/**
 * Phase 2.2 — Bank statement import and reconciliation
 */
import ExcelJS from 'exceljs';
import { portalState, supabase, pullState } from './store.js';
import { logActivity } from './activityAudit.js';
import { matchFlatFromText, parseNoBrokerCollectionLines } from './bulkCollectionImport.js';
import { recordMaintenanceCollectionPayment } from './maintenanceBilling.js';

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN')}`;

const parseDate = (val) => {
    if (!val) return null;
    if (val instanceof Date) return val.toISOString().slice(0, 10);
    const s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    const parts = s.split(/[\/\-]/);
    if (parts.length === 3) {
        const [a, b, c] = parts.map((x) => parseInt(x, 10));
        if (c > 1000) return `${c}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
        if (a > 1000) return `${a}-${String(b).padStart(2, '0')}-${String(c).padStart(2, '0')}`;
    }
    return null;
};

const parseAmount = (val) => {
    if (val == null || val === '') return 0;
    const n = parseFloat(String(val).replace(/[,₹]/g, ''));
    return Number.isFinite(n) ? Math.abs(n) : 0;
};

export const getMatchedTransactionIds = () => {
    const ids = new Set();
    (portalState.finances.bankStatementLines || []).forEach((line) => {
        if (line.match_status === 'MATCHED' && line.transaction_id) ids.add(line.transaction_id);
    });
    return ids;
};

export const isTransactionReconciled = (txnId) => getMatchedTransactionIds().has(txnId);

export async function parseBankStatementFile(file) {
    const wb = new ExcelJS.Workbook();
    const buf = await file.arrayBuffer();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('No worksheet found in file.');

    const headerRow = ws.getRow(1);
    const headers = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
        headers[col] = String(cell.value || '').trim().toLowerCase();
    });

    const col = (names) => {
        const idx = headers.findIndex((h) => names.some((n) => h.includes(n)));
        return idx >= 0 ? idx + 1 : null;
    };

    const dateCol = col(['date']);
    const descCol = col(['description', 'narration', 'particular']);
    const debitCol = col(['debit', 'withdraw']);
    const creditCol = col(['credit', 'deposit']);
    const balanceCol = col(['balance']);

    if (!dateCol) throw new Error('Could not find Date column. Use template headers: Date, Description, Debit, Credit, Balance.');

    const lines = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        const lineDate = parseDate(row.getCell(dateCol).value);
        if (!lineDate) return;
        lines.push({
            line_date: lineDate,
            description: descCol ? String(row.getCell(descCol).value || '').trim() : '',
            debit: debitCol ? parseAmount(row.getCell(debitCol).value) : 0,
            credit: creditCol ? parseAmount(row.getCell(creditCol).value) : 0,
            balance: balanceCol ? parseAmount(row.getCell(balanceCol).value) : null,
        });
    });

    if (!lines.length) throw new Error('No data rows found.');
    return lines;
}

export async function importBankStatement(file, lines) {
    if (!supabase) throw new Error('Supabase is not configured.');
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');

    const { data: { user } } = await supabase.auth.getUser();
    const bank_account_id = portalState.admin?.bankAccount?.id || null;
    const dates = lines.map((l) => l.line_date).sort();
    const importId = crypto.randomUUID();

    const { error: impErr } = await supabase.from('bank_statement_imports').insert({
        id: importId,
        apartment_id,
        bank_account_id,
        file_name: file?.name || 'import.xlsx',
        period_start: dates[0] || null,
        period_end: dates[dates.length - 1] || null,
        imported_by: user?.id || null,
    });
    if (impErr) throw new Error(impErr.message);

    const payload = lines.map((l) => ({
        id: crypto.randomUUID(),
        import_id: importId,
        apartment_id,
        line_date: l.line_date,
        description: l.description || null,
        debit: l.debit || 0,
        credit: l.credit || 0,
        balance: l.balance,
        match_status: 'UNMATCHED',
    }));

    const { error: lineErr } = await supabase.from('bank_statement_lines').insert(payload);
    if (lineErr) throw new Error(lineErr.message);

    await pullState();
    return { importId, count: payload.length };
}

export const getUnmatchedBankLines = () =>
    (portalState.finances.bankStatementLines || []).filter((l) => l.match_status === 'UNMATCHED');

export const getUnmatchedLedgerTxns = () => {
    const matched = getMatchedTransactionIds();
    return (portalState.finances.txns || []).filter((t) =>
        (t.wallet || '').toUpperCase() === 'BANK'
        && !matched.has(t.id),
    );
};

let nobrokerDumpLines = [];
let nobrokerFileName = '';

export const getNoBrokerDump = () => ({ lines: nobrokerDumpLines, fileName: nobrokerFileName });

export const setNoBrokerDump = (lines, fileName = '') => {
    nobrokerDumpLines = lines || [];
    nobrokerFileName = fileName || '';
};

export const clearNoBrokerDump = () => {
    nobrokerDumpLines = [];
    nobrokerFileName = '';
};

export const getDateTolerance = () => {
    const raw = document.getElementById('bank-recon-date-tolerance')?.value
        ?? document.getElementById('fa-date-tolerance')?.value
        ?? '3';
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 3;
};

export const lineAmount = (line) => {
    const credit = parseFloat(line?.credit || 0);
    const debit = parseFloat(line?.debit || 0);
    if (credit > 0.001) return { amount: credit, type: 'IN' };
    if (debit > 0.001) return { amount: debit, type: 'OUT' };
    return null;
};

const txnDateStr = (txn) => new Date(txn.date).toISOString().slice(0, 10);

const daysDiff = (dateA, dateB) => {
    const a = new Date(`${dateA}T12:00:00`);
    const b = new Date(`${dateB}T12:00:00`);
    return Math.abs((a - b) / 86400000);
};

const inferExpenseCategory = (desc) => {
    const u = String(desc || '').toUpperCase();
    if (/SECURITY|GUARD/.test(u)) return 'Security';
    if (/PLUMB|WATER|MOTOR|TANK/.test(u)) return 'Plumbing';
    if (/ELECT|DIESEL|\bDG\b/.test(u)) return 'Electrical';
    if (/STATIONERY|PRINT|OFFICE/.test(u)) return 'Stationery';
    if (/MAINT|LIFT|GEN|HOUSE|CLEAN/.test(u)) return 'Maintenance';
    return 'Other';
};

const inferIncomeCategory = (desc) => {
    const u = String(desc || '').toUpperCase();
    if (/INTEREST|\bINT\b/.test(u)) return 'Interest';
    if (/NOBROKER|MAINT|RENT|COLLECT|FLAT/.test(u)) return 'Maintenance Collection';
    return 'Other Income';
};

const inferBankPaymentType = (desc) => {
    const u = String(desc || '').toUpperCase();
    if (/UPI|GPAY|PHONEPE|PAYTM/.test(u)) return 'UPI';
    if (/NEFT|IMPS|RTGS/.test(u)) return 'NEFT';
    if (/CHQ|CHEQUE/.test(u)) return 'CHEQUE';
    return 'NEFT';
};

const statementReference = (lineId) => `STMT-${String(lineId || '').slice(0, 8)}`;

const referenceExists = (ref) => {
    const key = String(ref || '').trim().toLowerCase();
    if (!key) return false;
    return (portalState.finances.txns || []).some(
        (t) => (t.bank_reference || '').trim().toLowerCase() === key,
    );
};

export const findNoBrokerForLine = (line, nobrokerLines = nobrokerDumpLines, maxDays = getDateTolerance()) => {
    const la = lineAmount(line);
    if (!la || la.type !== 'IN') return null;
    let best = null;
    let bestDiff = Infinity;
    nobrokerLines.forEach((nb) => {
        if (Math.abs(parseFloat(nb.amount) - la.amount) > 0.01) return;
        const diff = daysDiff(line.line_date, nb.date);
        if (diff > maxDays || diff >= bestDiff) return;
        bestDiff = diff;
        best = nb;
    });
    return best;
};

export const findLedgerMatch = (line, txns, maxDays = getDateTolerance()) => {
    const la = lineAmount(line);
    if (!la) return null;
    let best = null;
    let bestScore = Infinity;
    txns.forEach((t) => {
        if (t.type !== la.type) return;
        if ((t.wallet || '').toUpperCase() !== 'BANK') return;
        const amt = parseFloat(t.amount || 0);
        if (Math.abs(amt - la.amount) > 0.01) return;
        const diff = daysDiff(line.line_date, txnDateStr(t));
        if (diff > maxDays) return;
        const score = diff * 1000 + Math.abs(amt - la.amount);
        if (score < bestScore) {
            bestScore = score;
            best = t;
        }
    });
    return best;
};

export const suggestMatches = (line, txns = getUnmatchedLedgerTxns(), maxDays = getDateTolerance()) => {
    const la = lineAmount(line);
    if (!la) return [];

    const scored = txns
        .filter((t) => t.type === la.type)
        .map((t) => {
            const amt = parseFloat(t.amount || 0);
            if (Math.abs(amt - la.amount) > 0.01) return null;
            const diff = daysDiff(line.line_date, txnDateStr(t));
            if (diff > maxDays) return null;
            return { txn: t, score: diff * 1000 };
        })
        .filter(Boolean)
        .sort((a, b) => a.score - b.score);

    return scored.slice(0, 5).map((s) => s.txn);
};

async function insertGenericBankTransaction({
    type,
    amount,
    date,
    cat,
    description,
    bankReference,
    bankPaymentType,
    vendorName = null,
}) {
    if (!supabase) throw new Error('Supabase is not configured.');
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');

    const txnId = crypto.randomUUID();
    const dateIso = new Date(`${date}T12:00:00`).toISOString();
    const core = {
        id: txnId,
        apartment_id,
        amount: parseFloat(amount),
        cat,
        description: description || null,
        wallet: 'BANK',
        type,
        date: dateIso,
    };
    const extended = {
        ...core,
        bank_payment_type: bankPaymentType || inferBankPaymentType(description),
        bank_reference: bankReference,
        vendor_name: vendorName,
    };

    let { error } = await supabase.from('transactions').insert(extended);
    if (error && /bank_payment_type|bank_reference|vendor_name/i.test(error.message)) {
        ({ error } = await supabase.from('transactions').insert(core));
    }
    if (error) throw new Error(error.message);

    await logActivity({
        entityType: 'TRANSACTION',
        entityId: txnId,
        action: 'CREATE',
        summary: `Auto-created from bank statement — ${type} ${formatMoney(amount)}`,
        newData: { txnId, cat, bankReference },
    });

    return txnId;
}

export async function createLedgerFromBankLine(lineId, { nobrokerRow = null, skipMatch = false } = {}) {
    const line = portalState.finances.bankStatementLines?.find((l) => l.id === lineId);
    if (!line || line.match_status !== 'UNMATCHED') throw new Error('Statement line is not available for import.');

    const la = lineAmount(line);
    if (!la) throw new Error('Statement line has no debit or credit amount.');

    const nb = nobrokerRow || findNoBrokerForLine(line);
    const desc = line.description || nb?.description || '';
    let txnId;

    if (la.type === 'IN') {
        const flat = nb?.flatHint || matchFlatFromText(desc) || matchFlatFromText(nb?.description);
        const incomeCat = inferIncomeCategory(desc);
        const bankRef = nb?.reference || statementReference(lineId);

        if (flat && (nb || incomeCat === 'Maintenance Collection')) {
            if (referenceExists(bankRef)) {
                throw new Error(`Reference ${bankRef} is already recorded in the ledger.`);
            }
            const result = await recordMaintenanceCollectionPayment({
                unitNumber: flat,
                amount: la.amount,
                date: line.line_date,
                description: desc || `Bank collection — ${flat}`,
                wallet: 'BANK',
                bankReference: bankRef,
                bankPaymentType: nb ? 'UPI' : inferBankPaymentType(desc),
            });
            txnId = result.txnId;
        } else {
            if (referenceExists(bankRef)) {
                throw new Error(`Reference ${bankRef} is already recorded in the ledger.`);
            }
            txnId = await insertGenericBankTransaction({
                type: 'IN',
                amount: la.amount,
                date: line.line_date,
                cat: incomeCat,
                description: desc || `Bank credit — ${incomeCat}`,
                bankReference: bankRef,
                bankPaymentType: inferBankPaymentType(desc),
            });
        }
    } else {
        const bankRef = statementReference(lineId);
        if (referenceExists(bankRef)) {
            throw new Error(`This statement line was already imported (${bankRef}).`);
        }
        const cat = inferExpenseCategory(desc);
        txnId = await insertGenericBankTransaction({
            type: 'OUT',
            amount: la.amount,
            date: line.line_date,
            cat,
            description: desc || `Bank debit — ${cat}`,
            bankReference: bankRef,
            bankPaymentType: inferBankPaymentType(desc),
            vendorName: desc.slice(0, 120) || null,
        });
    }

    if (!skipMatch) {
        await matchBankLine(lineId, txnId);
    }
    return txnId;
}

export async function autoMatchByDateAndAmount({ maxDaysDiff = getDateTolerance() } = {}) {
    const lines = [...getUnmatchedBankLines()].sort((a, b) =>
        (a.line_date || '').localeCompare(b.line_date || ''),
    );
    let txns = getUnmatchedLedgerTxns();
    const matched = [];
    const errors = [];

    for (const line of lines) {
        const txn = findLedgerMatch(line, txns, maxDaysDiff);
        if (!txn) continue;
        try {
            await matchBankLine(line.id, txn.id);
            matched.push({ lineId: line.id, txnId: txn.id, date: line.line_date });
            txns = txns.filter((t) => t.id !== txn.id);
        } catch (err) {
            errors.push(`${line.line_date}: ${err?.message || 'Match failed'}`);
        }
    }

    await pullState();
    return { matched, errors };
}

export async function autoCreateFromUnmatchedLines({
    maxDaysDiff = getDateTolerance(),
    includeDebits = true,
} = {}) {
    const lines = [...getUnmatchedBankLines()].sort((a, b) =>
        (a.line_date || '').localeCompare(b.line_date || ''),
    );
    let created = 0;
    let matchedExisting = 0;
    const skipped = [];
    const errors = [];

    for (const line of lines) {
        const la = lineAmount(line);
        if (!la) {
            skipped.push(`${line.line_date}: zero amount`);
            continue;
        }
        if (la.type === 'OUT' && !includeDebits) {
            skipped.push(`${line.line_date}: debit skipped`);
            continue;
        }

        const existing = findLedgerMatch(line, getUnmatchedLedgerTxns(), maxDaysDiff);
        if (existing) {
            try {
                await matchBankLine(line.id, existing.id);
                matchedExisting += 1;
            } catch (err) {
                errors.push(`${line.line_date}: ${err?.message || 'Match failed'}`);
            }
            continue;
        }

        try {
            const nb = findNoBrokerForLine(line, nobrokerDumpLines, maxDaysDiff);
            await createLedgerFromBankLine(line.id, { nobrokerRow: nb });
            created += 1;
        } catch (err) {
            skipped.push(`${line.line_date}: ${err?.message || 'Skipped'}`);
        }
    }

    await pullState();
    return { created, matchedExisting, skipped, errors };
}

export async function reconcileBankWithNoBroker({
    maxDaysDiff = getDateTolerance(),
    createMissing = true,
} = {}) {
    if (!nobrokerDumpLines.length) throw new Error('Upload a NoBroker payment dump first.');

    const lines = getUnmatchedBankLines().filter((l) => parseFloat(l.credit || 0) > 0.001);
    let txns = getUnmatchedLedgerTxns();
    let matchedLedger = 0;
    let created = 0;
    const unmatched = [];
    const errors = [];

    for (const line of lines) {
        const nb = findNoBrokerForLine(line, nobrokerDumpLines, maxDaysDiff);
        if (!nb) {
            unmatched.push(`${line.line_date} · ${formatMoney(line.credit)} — no NoBroker row`);
            continue;
        }

        const flat = nb.flatHint || matchFlatFromText(nb.description);
        if (!flat) {
            errors.push(`${line.line_date}: NoBroker row matched amount/date but flat could not be resolved`);
            continue;
        }

        const ledgerMatch = txns.find((t) =>
            t.type === 'IN'
            && t.cat === 'Maintenance Collection'
            && Math.abs(parseFloat(t.amount) - parseFloat(nb.amount)) < 0.01
            && daysDiff(line.line_date, txnDateStr(t)) <= maxDaysDiff
            && (
                (t.description || '').toUpperCase().includes(flat.toUpperCase())
                || daysDiff(nb.date, txnDateStr(t)) <= maxDaysDiff
            ),
        );

        if (ledgerMatch) {
            try {
                await matchBankLine(line.id, ledgerMatch.id);
                txns = txns.filter((t) => t.id !== ledgerMatch.id);
                matchedLedger += 1;
            } catch (err) {
                errors.push(`${line.line_date}: ${err?.message || 'Match failed'}`);
            }
            continue;
        }

        if (!createMissing) {
            unmatched.push(`${line.line_date} · ${flat} · ${formatMoney(nb.amount)} — ledger entry missing`);
            continue;
        }

        try {
            await createLedgerFromBankLine(line.id, { nobrokerRow: nb });
            created += 1;
        } catch (err) {
            errors.push(`${line.line_date} · ${flat}: ${err?.message || 'Create failed'}`);
        }
    }

    await pullState();
    return { matchedLedger, created, unmatched, errors };
}

export async function loadNoBrokerDumpFile(file) {
    const lines = await parseNoBrokerCollectionLines(file);
    setNoBrokerDump(lines, file?.name || 'NoBroker export');
    return lines.length;
}

export async function matchBankLine(lineId, transactionId) {
    if (!supabase) return;
    const line = portalState.finances.bankStatementLines?.find((l) => l.id === lineId);
    if (!line) return;

    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('bank_statement_lines').update({
        match_status: 'MATCHED',
        transaction_id: transactionId,
        matched_at: new Date().toISOString(),
        matched_by: user?.id || null,
    }).eq('id', lineId);
    if (error) throw new Error(error.message);

    await logActivity({
        entityType: 'BANK_MATCH',
        entityId: lineId,
        action: 'MATCH',
        summary: `Matched statement line to ledger txn ${transactionId.slice(0, 8)}…`,
        newData: { line_id: lineId, transaction_id: transactionId },
    });

    await pullState();
}

export async function unmatchBankLine(lineId) {
    if (!supabase) return;
    const line = portalState.finances.bankStatementLines?.find((l) => l.id === lineId);
    if (!line) return;

    const { error } = await supabase.from('bank_statement_lines').update({
        match_status: 'UNMATCHED',
        transaction_id: null,
        matched_at: null,
        matched_by: null,
    }).eq('id', lineId);
    if (error) throw new Error(error.message);

    await logActivity({
        entityType: 'BANK_MATCH',
        entityId: lineId,
        action: 'UNMATCH',
        summary: 'Unmatched bank statement line',
        oldData: { transaction_id: line.transaction_id },
    });

    await pullState();
}

export async function ignoreBankLine(lineId) {
    if (!supabase) return;
    const { error } = await supabase.from('bank_statement_lines').update({
        match_status: 'IGNORED',
        transaction_id: null,
    }).eq('id', lineId);
    if (error) throw new Error(error.message);

    await logActivity({
        entityType: 'BANK_MATCH',
        entityId: lineId,
        action: 'IGNORE',
        summary: 'Marked bank line as ignored',
    });

    await pullState();
}

export const renderBankReconciliation = () => {
    const linesEl = document.getElementById('bank-recon-lines');
    const txnsEl = document.getElementById('bank-recon-txns');
    const statsEl = document.getElementById('bank-recon-stats');
    const nobrokerMeta = document.getElementById('bank-recon-nobroker-meta');
    if (!linesEl || !txnsEl) return;

    const maxDays = getDateTolerance();
    const lines = portalState.finances.bankStatementLines || [];
    const unmatched = lines.filter((l) => l.match_status === 'UNMATCHED');
    const matched = lines.filter((l) => l.match_status === 'MATCHED');
    const ignored = lines.filter((l) => l.match_status === 'IGNORED');

    if (nobrokerMeta) {
        nobrokerMeta.textContent = nobrokerDumpLines.length
            ? `${nobrokerDumpLines.length} NoBroker rows loaded${nobrokerFileName ? ` (${nobrokerFileName})` : ''}`
            : 'No NoBroker dump loaded';
    }

    if (statsEl) {
        statsEl.innerHTML = `
          <div class="metric-card"><span class="label">Statement lines</span><span class="value">${lines.length}</span></div>
          <div class="metric-card"><span class="label">Unmatched</span><span class="value" style="color:var(--danger);">${unmatched.length}</span></div>
          <div class="metric-card"><span class="label">Matched</span><span class="value" style="color:var(--success);">${matched.length}</span></div>
          <div class="metric-card"><span class="label">Date tolerance</span><span class="value">${maxDays === 0 ? 'Exact' : `±${maxDays}d`}</span></div>
          <div class="metric-card"><span class="label">Ignored</span><span class="value">${ignored.length}</span></div>`;
    }

    const ledgerTxns = getUnmatchedLedgerTxns();

    if (!unmatched.length) {
        linesEl.innerHTML = '<p class="maintenance-dues-empty">No unmatched statement lines. Import a bank statement to begin.</p>';
    } else {
        linesEl.innerHTML = unmatched.map((line) => {
            const amt = parseFloat(line.credit) > 0 ? `+${formatMoney(line.credit)}` : `-${formatMoney(line.debit)}`;
            const suggestions = suggestMatches(line, ledgerTxns, maxDays);
            const nb = findNoBrokerForLine(line);
            const nbHint = nb
                ? `<span class="bank-recon-nobroker-hint"><i class="fa-solid fa-building"></i> NoBroker: ${nb.flatHint || matchFlatFromText(nb.description) || 'matched'} · ${nb.date}</span>`
                : '';
            const sugHtml = suggestions.length
                ? `<div class="bank-recon-suggestions">${suggestions.map((t) => {
                    const diff = daysDiff(line.line_date, txnDateStr(t));
                    return `<button type="button" class="btn btn-outline btn--small bank-match-suggest" data-line="${line.id}" data-txn="${t.id}">
                      ${new Date(t.date).toLocaleDateString('en-GB')}${diff ? ` (${diff === 0 ? 'same day' : `±${diff}d`})` : ''} · ${formatMoney(t.amount)} · ${(t.description || t.cat || '').slice(0, 30)}
                    </button>`;
                }).join('')}</div>`
                : `<span class="nb-muted" style="font-size:0.75rem;">No suggestions within ${maxDays === 0 ? 'exact date' : `±${maxDays} days`}</span>`;

            return `<div class="bank-recon-line" data-line-id="${line.id}">
              <div class="bank-recon-line__head">
                <strong>${line.line_date}</strong> ${amt}
                <span>${line.description || '—'}</span>
              </div>
              ${nbHint}
              ${sugHtml}
              <div class="bank-recon-line__actions">
                <select class="expense-combobox bank-match-select" data-line="${line.id}">
                  <option value="">Select ledger txn…</option>
                  ${ledgerTxns.map((t) =>
                    `<option value="${t.id}">${new Date(t.date).toLocaleDateString('en-GB')} · ${t.type} · ${formatMoney(t.amount)} · ${(t.description || '').slice(0, 40)}</option>`,
                  ).join('')}
                </select>
                <button type="button" class="btn btn-primary btn--small bank-match-btn" data-line="${line.id}">Match</button>
                <button type="button" class="btn btn-outline btn--small bank-create-btn" data-line="${line.id}" title="Create ledger entry and reconcile">Create entry</button>
                <button type="button" class="btn btn-outline btn--small bank-ignore-btn" data-line="${line.id}">Ignore</button>
              </div>
            </div>`;
        }).join('');
    }

    txnsEl.innerHTML = ledgerTxns.length
        ? ledgerTxns.slice(0, 40).map((t) => `
          <div class="bank-recon-txn">
            <span>${new Date(t.date).toLocaleDateString('en-GB')}</span>
            <span class="${t.type === 'IN' ? 'text-success' : 'text-danger'}">${t.type === 'IN' ? '+' : '-'}${formatMoney(t.amount)}</span>
            <span>${t.description || t.cat || '—'}</span>
          </div>`).join('')
        : '<p class="maintenance-dues-empty">All bank ledger transactions are matched.</p>';

    linesEl.querySelectorAll('.bank-match-suggest').forEach((btn) => {
        btn.addEventListener('click', async () => {
            try {
                await matchBankLine(btn.dataset.line, btn.dataset.txn);
                renderBankReconciliation();
                window.renderCashLedger?.();
            } catch (err) {
                alert(err?.message || 'Match failed.');
            }
        });
    });

    linesEl.querySelectorAll('.bank-match-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const sel = linesEl.querySelector(`.bank-match-select[data-line="${btn.dataset.line}"]`);
            const txnId = sel?.value;
            if (!txnId) return alert('Select a ledger transaction.');
            try {
                await matchBankLine(btn.dataset.line, txnId);
                renderBankReconciliation();
                window.renderCashLedger?.();
            } catch (err) {
                alert(err?.message || 'Match failed.');
            }
        });
    });

    linesEl.querySelectorAll('.bank-create-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!confirm('Create a ledger entry from this statement line and mark it reconciled?')) return;
            try {
                await createLedgerFromBankLine(btn.dataset.line);
                renderBankReconciliation();
                window.renderCashLedger?.();
                window.processFinances?.();
                window.renderFinanceAnalytics?.();
            } catch (err) {
                alert(err?.message || 'Could not create ledger entry.');
            }
        });
    });

    linesEl.querySelectorAll('.bank-ignore-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!confirm('Mark this line as ignored (bank charges, etc.)?')) return;
            try {
                await ignoreBankLine(btn.dataset.line);
                renderBankReconciliation();
            } catch (err) {
                alert(err?.message || 'Could not ignore line.');
            }
        });
    });
};

export async function downloadBankStatementTemplate() {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Statement');
    ws.addRow(['Date', 'Description', 'Debit', 'Credit', 'Balance']);
    ws.addRow(['2026-01-05', 'NEFT MAINTENANCE COLLECTION', '', '15000', '125000']);
    ws.addRow(['2026-01-08', 'UPI VENDOR PAYMENT', '8500', '', '116500']);
    ws.columns = [{ width: 12 }, { width: 36 }, { width: 12 }, { width: 12 }, { width: 14 }];
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Bank_Statement_Template.xlsx';
    a.click();
    URL.revokeObjectURL(url);
}

export const initBankReconciliationUi = () => {
    document.getElementById('bank-recon-import-btn')?.addEventListener('click', () => {
        document.getElementById('bank-recon-file')?.click();
    });
    document.getElementById('bank-recon-template-btn')?.addEventListener('click', () => {
        downloadBankStatementTemplate().catch((err) => alert(err?.message || 'Download failed.'));
    });
    document.getElementById('bank-recon-date-tolerance')?.addEventListener('change', () => {
        renderBankReconciliation();
    });
    document.getElementById('bank-recon-nobroker-upload-btn')?.addEventListener('click', () => {
        document.getElementById('bank-recon-nobroker-file')?.click();
    });
    document.getElementById('bank-recon-nobroker-file')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const count = await loadNoBrokerDumpFile(file);
            alert(`Loaded ${count} NoBroker payment row(s).`);
            renderBankReconciliation();
            window.renderFinanceAnalytics?.();
        } catch (err) {
            alert(err?.message || 'NoBroker import failed.');
        } finally {
            e.target.value = '';
        }
    });
    document.getElementById('bank-recon-clear-nobroker-btn')?.addEventListener('click', () => {
        clearNoBrokerDump();
        renderBankReconciliation();
        window.renderFinanceAnalytics?.();
    });
    document.getElementById('bank-recon-auto-match-btn')?.addEventListener('click', async () => {
        const tol = getDateTolerance();
        const label = tol === 0 ? 'exact date' : `±${tol} day(s)`;
        if (!confirm(`Auto-match unmatched statement lines to ledger entries with the same amount and ${label}?`)) return;
        try {
            const { matched, errors } = await autoMatchByDateAndAmount();
            renderBankReconciliation();
            window.renderCashLedger?.();
            window.renderFinanceAnalytics?.();
            const msg = [`Matched ${matched.length} line(s).`];
            if (errors.length) msg.push(`\n\nIssues:\n${errors.slice(0, 8).join('\n')}`);
            alert(msg.join(''));
        } catch (err) {
            alert(err?.message || 'Auto-match failed.');
        }
    });
    document.getElementById('bank-recon-auto-create-btn')?.addEventListener('click', async () => {
        const includeDebits = document.getElementById('bank-recon-include-debits')?.checked !== false;
        if (!confirm(`Create ledger entries for remaining unmatched lines${includeDebits ? ' (including debits)' : ' (credits only)'}? Existing matches by date/amount will be linked first.`)) return;
        try {
            const { created, matchedExisting, skipped, errors } = await autoCreateFromUnmatchedLines({ includeDebits });
            renderBankReconciliation();
            window.renderCashLedger?.();
            window.processFinances?.();
            window.renderFinanceAnalytics?.();
            const msg = [
                `Created ${created} ledger entry(ies).`,
                matchedExisting ? `Linked ${matchedExisting} existing entry(ies).` : '',
                skipped.length ? `${skipped.length} skipped.` : '',
            ].filter(Boolean);
            if (errors.length) msg.push(`\n\nErrors:\n${errors.slice(0, 8).join('\n')}`);
            if (skipped.length && skipped.length <= 6) msg.push(`\n\nSkipped:\n${skipped.join('\n')}`);
            alert(msg.join('\n'));
        } catch (err) {
            alert(err?.message || 'Auto-create failed.');
        }
    });
    document.getElementById('bank-recon-nobroker-reconcile-btn')?.addEventListener('click', async () => {
        if (!nobrokerDumpLines.length) return alert('Upload a NoBroker dump first.');
        const tol = getDateTolerance();
        if (!confirm(`Reconcile bank credits with NoBroker using ${tol === 0 ? 'exact dates' : `±${tol} days`}? Missing ledger entries will be created for matched flats.`)) return;
        try {
            const { matchedLedger, created, unmatched, errors } = await reconcileBankWithNoBroker({ createMissing: true });
            renderBankReconciliation();
            window.renderCashLedger?.();
            window.processFinances?.();
            window.renderFinanceAnalytics?.();
            const msg = [
                `Matched ${matchedLedger} line(s) to existing ledger entries.`,
                created ? `Created ${created} new collection(s).` : '',
                unmatched.length ? `${unmatched.length} bank line(s) had no NoBroker match.` : '',
            ].filter(Boolean);
            if (errors.length) msg.push(`\n\nIssues:\n${errors.slice(0, 8).join('\n')}`);
            alert(msg.join('\n'));
        } catch (err) {
            alert(err?.message || 'NoBroker reconcile failed.');
        }
    });
    document.getElementById('bank-recon-file')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const lines = await parseBankStatementFile(file);
            if (!confirm(`Import ${lines.length} statement line(s) from ${file.name}?`)) return;
            const { count } = await importBankStatement(file, lines);
            alert(`Imported ${count} line(s).`);
            renderBankReconciliation();
        } catch (err) {
            alert(err?.message || 'Import failed.');
        } finally {
            e.target.value = '';
        }
    });
};

window.renderBankReconciliation = renderBankReconciliation;
