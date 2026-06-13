/**
 * Phase 2.2 — Bank statement import and reconciliation
 */
import ExcelJS from 'exceljs';
import { portalState, supabase, pullState } from './store.js';
import { logActivity } from './activityAudit.js';

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

export const suggestMatches = (line, txns = getUnmatchedLedgerTxns()) => {
    const lineAmt = parseFloat(line.credit || 0) > 0.001
        ? parseFloat(line.credit)
        : parseFloat(line.debit || 0);
    if (lineAmt <= 0.001) return [];

    const lineDate = new Date(`${line.line_date}T12:00:00`);
    return txns.filter((t) => {
        const amt = parseFloat(t.amount || 0);
        if (Math.abs(amt - lineAmt) > 0.01) return false;
        const txnDate = new Date(`${t.date}T12:00:00`);
        const diffDays = Math.abs((lineDate - txnDate) / 86400000);
        return diffDays <= 3;
    }).slice(0, 5);
};

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
    if (!linesEl || !txnsEl) return;

    const lines = portalState.finances.bankStatementLines || [];
    const unmatched = lines.filter((l) => l.match_status === 'UNMATCHED');
    const matched = lines.filter((l) => l.match_status === 'MATCHED');
    const ignored = lines.filter((l) => l.match_status === 'IGNORED');

    if (statsEl) {
        statsEl.innerHTML = `
          <div class="metric-card"><span class="label">Statement lines</span><span class="value">${lines.length}</span></div>
          <div class="metric-card"><span class="label">Unmatched</span><span class="value" style="color:var(--danger);">${unmatched.length}</span></div>
          <div class="metric-card"><span class="label">Matched</span><span class="value" style="color:var(--success);">${matched.length}</span></div>
          <div class="metric-card"><span class="label">Ignored</span><span class="value">${ignored.length}</span></div>`;
    }

    const ledgerTxns = getUnmatchedLedgerTxns();

    if (!unmatched.length) {
        linesEl.innerHTML = '<p class="maintenance-dues-empty">No unmatched statement lines. Import a bank statement to begin.</p>';
    } else {
        linesEl.innerHTML = unmatched.map((line) => {
            const amt = parseFloat(line.credit) > 0 ? `+${formatMoney(line.credit)}` : `-${formatMoney(line.debit)}`;
            const suggestions = suggestMatches(line, ledgerTxns);
            const sugHtml = suggestions.length
                ? `<div class="bank-recon-suggestions">${suggestions.map((t) =>
                    `<button type="button" class="btn btn-outline btn--small bank-match-suggest" data-line="${line.id}" data-txn="${t.id}">
                      ${new Date(t.date).toLocaleDateString('en-GB')} · ${formatMoney(t.amount)} · ${(t.description || t.cat || '').slice(0, 30)}
                    </button>`,
                ).join('')}</div>`
                : '<span class="nb-muted" style="font-size:0.75rem;">No auto-suggestions</span>';

            return `<div class="bank-recon-line" data-line-id="${line.id}">
              <div class="bank-recon-line__head">
                <strong>${line.line_date}</strong> ${amt}
                <span>${line.description || '—'}</span>
              </div>
              ${sugHtml}
              <div class="bank-recon-line__actions">
                <select class="expense-combobox bank-match-select" data-line="${line.id}">
                  <option value="">Select ledger txn…</option>
                  ${ledgerTxns.map((t) =>
                    `<option value="${t.id}">${new Date(t.date).toLocaleDateString('en-GB')} · ${t.type} · ${formatMoney(t.amount)} · ${(t.description || '').slice(0, 40)}</option>`,
                  ).join('')}
                </select>
                <button type="button" class="btn btn-primary btn--small bank-match-btn" data-line="${line.id}">Match</button>
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
