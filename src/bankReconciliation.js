/**
 * Phase 2.2 — Bank statement import and reconciliation
 */
import ExcelJS from 'exceljs';
import { portalState, supabase, pullState } from './store.js';
import { logActivity } from './activityAudit.js';
import { matchFlatFromText, parseNoBrokerCollectionLines } from './bulkCollectionImport.js';
import { recordMaintenanceCollectionPayment } from './maintenanceBilling.js';
import { withButtonBusy } from './buttonBusy.js';
import {
    validatePassbookFiles,
    parsePassbookFiles,
    passbookImportLabel,
    PASSBOOK_ACCEPT,
} from './passbookEvolyx.js';
import { isPassbookOcrConfigured } from './externalConnections.js';

const EXPENSE_CATS = ['Maintenance', 'Security', 'Plumbing', 'Electrical', 'Stationery', 'Other'];
const SUB_CAT_SUGGESTIONS = {
    Maintenance: ['Lift / Elevator', 'Generator', 'Housekeeping', 'Painting', 'Landscaping', 'Pest control'],
    Security: ['Guard salary', 'Uniforms', 'CCTV'],
    Plumbing: ['Motor repair', 'Tank cleaning', 'Pipeline'],
    Electrical: ['Diesel', 'Common area lighting', 'Lift backup'],
    Stationery: ['Printing', 'Office supplies'],
    Other: ['Miscellaneous'],
};
const INCOME_CATS = [
    'Maintenance Collection',
    'Marketing',
    'Promotion',
    'Interest',
    'Petty Inflow',
    'Reconcile',
    'Other Income',
];

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN')}`;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const formatAmountInput = (n) => {
    const v = parseFloat(n || 0);
    return v > 0.001 ? String(v) : '';
};

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

const normalizeDesc = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

export const bankLineAmount = (line) => (
    parseFloat(line.credit || 0) > 0.001 ? parseFloat(line.credit) : parseFloat(line.debit || 0)
);

export const bankLineType = (line) => (parseFloat(line.credit || 0) > 0.001 ? 'IN' : 'OUT');

export const bankLineFingerprint = (line) => {
    const amt = bankLineAmount(line);
    return `${line.line_date}|${normalizeDesc(line.description)}|${amt.toFixed(2)}`;
};

export function dedupeBankImportLines(lines) {
    const existing = new Set((portalState.finances.bankStatementLines || []).map(bankLineFingerprint));
    const seen = new Set();
    const unique = [];
    let skippedExisting = 0;
    let skippedBatch = 0;

    for (const line of lines) {
        const fp = bankLineFingerprint(line);
        if (existing.has(fp)) {
            skippedExisting += 1;
            continue;
        }
        if (seen.has(fp)) {
            skippedBatch += 1;
            continue;
        }
        seen.add(fp);
        unique.push(line);
    }

    return {
        unique,
        skipped: skippedExisting + skippedBatch,
        skippedExisting,
        skippedBatch,
    };
}

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

export async function importBankStatement(file, lines, { fileLabel } = {}) {
    if (!supabase) throw new Error('Supabase is not configured.');
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');

    const { unique, skipped, skippedExisting, skippedBatch } = dedupeBankImportLines(lines);
    if (!unique.length) {
        return { importId: null, count: 0, skipped, skippedExisting, skippedBatch };
    }

    const { data: { user } } = await supabase.auth.getUser();
    const bank_account_id = portalState.admin?.bankAccount?.id || null;
    const dates = unique.map((l) => l.line_date).sort();
    const importId = crypto.randomUUID();
    const file_name = fileLabel || file?.name || 'import.xlsx';

    const { error: impErr } = await supabase.from('bank_statement_imports').insert({
        id: importId,
        apartment_id,
        bank_account_id,
        file_name,
        period_start: dates[0] || null,
        period_end: dates[dates.length - 1] || null,
        imported_by: user?.id || null,
    });
    if (impErr) throw new Error(impErr.message);

    const payload = unique.map((l) => ({
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
    return { importId, count: payload.length, skipped, skippedExisting, skippedBatch };
}

export const getUnmatchedBankLines = () =>
    (portalState.finances.bankStatementLines || []).filter((l) => l.match_status === 'UNMATCHED');

const BALANCE_TOLERANCE = 0.01;

/** Opening balance baseline from society bank account settings. */
export const getBankOpeningConfig = () => {
    const bank = portalState.admin?.bankAccount;
    const raw = bank?.opening_balance;
    const amount = raw != null && raw !== '' && !Number.isNaN(parseFloat(raw))
        ? parseFloat(raw)
        : null;
    return {
        amount,
        date: bank?.opening_balance_date || null,
    };
};

export const getStatementLinesChronological = () =>
    [...(portalState.finances.bankStatementLines || [])].sort((a, b) => {
        const byDate = a.line_date.localeCompare(b.line_date);
        if (byDate !== 0) return byDate;
        return String(a.id).localeCompare(String(b.id));
    });

/** Running balance per line: opening + credits − debits; flags passbook mismatches. */
export const annotateStatementLineBalances = () => {
    const opening = getBankOpeningConfig();
    const hasOpening = opening.amount != null;
    let running = hasOpening ? opening.amount : 0;

    return getStatementLinesChronological().map((line) => {
        const onOrAfterOpening = !opening.date || line.line_date >= opening.date;
        let computedBalance = null;
        let passbookMismatch = false;

        if (hasOpening && onOrAfterOpening) {
            running += parseFloat(line.credit || 0) - parseFloat(line.debit || 0);
            computedBalance = running;
            if (line.balance != null && line.balance !== '') {
                const passbookBal = parseFloat(line.balance);
                if (!Number.isNaN(passbookBal) && Math.abs(computedBalance - passbookBal) > BALANCE_TOLERANCE) {
                    passbookMismatch = true;
                }
            }
        }

        return { ...line, computedBalance, passbookMismatch };
    });
};

/** Balance from opening baseline + all statement movements on/after opening date. */
export const getCalculatedBankBalance = () => {
    const opening = getBankOpeningConfig();
    const lines = getStatementLinesChronological().filter((l) =>
        !opening.date || l.line_date >= opening.date,
    );

    if (opening.amount == null) {
        return { balance: null, asOf: opening.date, lineCount: lines.length, needsOpening: true };
    }

    let balance = opening.amount;
    let asOf = opening.date;
    for (const line of lines) {
        balance += parseFloat(line.credit || 0) - parseFloat(line.debit || 0);
        asOf = line.line_date;
    }
    return { balance, asOf, lineCount: lines.length, needsOpening: false };
};

/** Passbook closing balance from the latest imported row that includes a balance column. */
export const getPassbookClosingBalance = () => {
    const lines = (portalState.finances.bankStatementLines || [])
        .filter((l) => l.balance != null && l.balance !== '' && !Number.isNaN(parseFloat(l.balance)));
    if (!lines.length) return null;

    const sorted = [...lines].sort((a, b) => {
        const byDate = b.line_date.localeCompare(a.line_date);
        if (byDate !== 0) return byDate;
        return String(b.id).localeCompare(String(a.id));
    });
    const latest = sorted[0];
    return {
        balance: parseFloat(latest.balance),
        asOf: latest.line_date,
        lineId: latest.id,
    };
};

/** @deprecated Use getPassbookClosingBalance */
export const getStatementClosingBalance = getPassbookClosingBalance;

export const getBankBalanceReconciliation = () => {
    const opening = getBankOpeningConfig();
    const calculated = getCalculatedBankBalance();
    const passbook = getPassbookClosingBalance();
    const diff = calculated.balance != null && passbook != null
        ? calculated.balance - passbook.balance
        : null;
    const hasDiscrepancy = diff != null && Math.abs(diff) > BALANCE_TOLERANCE;
    const mismatchCount = annotateStatementLineBalances().filter((l) => l.passbookMismatch).length;
    return { opening, calculated, passbook, diff, hasDiscrepancy, mismatchCount };
};

export async function saveBankOpeningBalance(date, amount) {
    if (!supabase) throw new Error('Supabase required.');
    const apt = portalState.access?.activeApartmentId;
    if (!apt) throw new Error('Select an apartment first.');
    if (!date) throw new Error('Enter the opening balance date.');
    if (amount == null || Number.isNaN(amount)) throw new Error('Enter the opening balance amount.');

    const bank = portalState.admin?.bankAccount;
    const payload = {
        id: bank?.id || crypto.randomUUID(),
        apartment_id: apt,
        bank_name: bank?.bank_name || 'Bank account',
        opening_balance_date: date,
        opening_balance: amount,
        updated_at: new Date().toISOString(),
    };
    if (bank?.branch) payload.branch = bank.branch;
    if (bank?.account_holder) payload.account_holder = bank.account_holder;
    if (bank?.account_number) payload.account_number = bank.account_number;
    if (bank?.ifsc) payload.ifsc = bank.ifsc;
    if (bank?.upi_id) payload.upi_id = bank.upi_id;
    if (bank?.notes) payload.notes = bank.notes;

    const { error } = await supabase.from('apartment_bank_accounts').upsert(payload, { onConflict: 'apartment_id' });
    if (error) throw new Error(error.message);
    await pullState();
}

export const getUnmatchedLedgerTxns = (typeFilter = null) => {
    const matched = getMatchedTransactionIds();
    return (portalState.finances.txns || []).filter((t) =>
        (t.wallet || '').toUpperCase() === 'BANK'
        && !matched.has(t.id)
        && (!typeFilter || t.type === typeFilter),
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

const lineAmount = (line) => {
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
};

export const suggestMatches = (line, txns = null, maxDays = getDateTolerance()) => {
    const lineType = bankLineType(line);
    const pool = txns ?? getUnmatchedLedgerTxns(lineType);
    const lineAmt = bankLineAmount(line);
    if (lineAmt <= 0.001) return [];

    const lineDate = new Date(`${line.line_date}T12:00:00`);
    return pool.filter((t) => {
        if (t.type !== lineType) return false;
        const amt = parseFloat(t.amount || 0);
        if (Math.abs(amt - lineAmt) > 0.01) return false;
        const txnDate = new Date(`${t.date}T12:00:00`);
        const diffDays = Math.abs((lineDate - txnDate) / 86400000);
        return diffDays <= maxDays;
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

export async function updateBankStatementLine(lineId, patch) {
    if (!supabase) throw new Error('Supabase is not configured.');
    const allowed = ['line_date', 'description', 'debit', 'credit', 'balance'];
    const payload = {};
    for (const key of allowed) {
        if (key in patch) payload[key] = patch[key];
    }
    if (!Object.keys(payload).length) return;

    const { error } = await supabase.from('bank_statement_lines').update(payload).eq('id', lineId);
    if (error) throw new Error(error.message);

    const line = portalState.finances.bankStatementLines?.find((l) => l.id === lineId);
    if (line) Object.assign(line, payload);
}

export async function deleteBankStatementLine(lineId) {
    await deleteBankStatementLines([lineId]);
}

export async function deleteBankStatementLines(lineIds) {
    if (!supabase) throw new Error('Supabase is not configured.');
    const ids = [...new Set(lineIds)].filter(Boolean);
    if (!ids.length) return;

    const { error } = await supabase.from('bank_statement_lines').delete().in('id', ids);
    if (error) throw new Error(error.message);

    await pullState();

    await logActivity({
        entityType: 'BANK_MATCH',
        entityId: ids[0],
        action: 'DELETE',
        summary: ids.length === 1 ? 'Deleted bank statement line' : `Deleted ${ids.length} bank statement lines`,
        newData: { line_ids: ids },
    });
}

export async function clearAllBankStatementData() {
    if (!supabase) throw new Error('Supabase is not configured.');
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');

    const lines = portalState.finances.bankStatementLines || [];
    if (!lines.length) return { deleted: 0 };

    const { error } = await supabase.from('bank_statement_imports').delete().eq('apartment_id', apartment_id);
    if (error) throw new Error(error.message);

    await pullState();

    await logActivity({
        entityType: 'BANK_MATCH',
        entityId: apartment_id,
        action: 'CLEAR_ALL',
        summary: `Cleared all bank statement imports (${lines.length} line(s))`,
    });

    return { deleted: lines.length };
}

export async function createTxnFromBankLine(lineId, { cat, sub_category, vendor_name }) {
    if (!supabase) throw new Error('Supabase is not configured.');
    const line = portalState.finances.bankStatementLines?.find((l) => l.id === lineId);
    if (!line) throw new Error('Statement line not found.');

    const isIncome = bankLineType(line) === 'IN';
    const amount = bankLineAmount(line);
    if (amount <= 0.001) throw new Error('Enter a debit or credit amount.');
    if (!cat) throw new Error('Select a category.');
    if (!isIncome && !sub_category) throw new Error('Enter sub-category for expenses.');
    if (!isIncome && !vendor_name) throw new Error('Enter vendor name for expenses.');

    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');

    const txnId = crypto.randomUUID();
    const payload = {
        id: txnId,
        apartment_id,
        amount,
        cat,
        sub_category: isIncome ? null : (sub_category || null),
        vendor_name: isIncome ? null : vendor_name,
        vendor_invoice: null,
        bank_payment_type: null,
        bank_reference: (line.description || '').slice(0, 120) || null,
        bank_proof_urls: [],
        description: line.description || null,
        wallet: 'BANK',
        type: isIncome ? 'IN' : 'OUT',
        date: new Date(`${line.line_date}T12:00:00`).toISOString(),
        receipt_url: null,
        receipt_urls: [],
    };

    let { error } = await supabase.from('transactions').insert(payload);
    if (error && /sub_category|vendor_name|bank_reference|bank_proof_urls/i.test(error.message)) {
        const core = { ...payload };
        delete core.sub_category;
        delete core.vendor_name;
        delete core.vendor_invoice;
        delete core.bank_payment_type;
        delete core.bank_reference;
        delete core.bank_proof_urls;
        delete core.receipt_url;
        delete core.receipt_urls;
        ({ error } = await supabase.from('transactions').insert(core));
    }
    if (error) throw new Error(error.message);

    await matchBankLine(lineId, txnId);

    await logActivity({
        entityType: 'BANK_MATCH',
        entityId: lineId,
        action: 'POST',
        summary: `Posted ${isIncome ? 'income' : 'expense'} (${cat}) from bank line`,
        newData: { line_id: lineId, transaction_id: txnId, cat },
    });
}

const importResultMessage = ({ count, skipped, skippedExisting, skippedBatch }) => {
    if (!count && skipped) {
        return `No new lines imported — ${skipped} duplicate(s) skipped (same date, description, and amount).`;
    }
    let msg = `Imported ${count} line(s).`;
    if (skipped) {
        msg += ` Skipped ${skipped} duplicate(s)`;
        if (skippedExisting) msg += ` (${skippedExisting} already in system`;
        if (skippedBatch) msg += `${skippedExisting ? ', ' : ' ('}${skippedBatch} in file`;
        msg += ').';
    }
    return msg;
};

const renderCatOptions = (isIncome) => {
    const cats = isIncome ? INCOME_CATS : EXPENSE_CATS;
    return cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
};

const subCatOptionsForCategory = (catKey) => {
    if (!catKey) return [];
    const defaults = SUB_CAT_SUGGESTIONS[catKey] || SUB_CAT_SUGGESTIONS.Other;
    const saved = (portalState.finances.subCategories || [])
        .filter((row) => row.category === catKey)
        .map((row) => row.name);
    return [...new Set([...defaults, ...saved])].sort((a, b) => a.localeCompare(b));
};

const updateRowSubCatDatalist = (row, catKey) => {
    const lineId = row?.dataset.lineId;
    if (!lineId) return;
    const list = row.querySelector(`#bank-recon-subcats-${lineId}`);
    if (!list) return;
    list.innerHTML = subCatOptionsForCategory(catKey)
        .map((s) => `<option value="${esc(s)}">`)
        .join('');
};

const rowClassifyReady = (row) => {
    if (!row) return false;
    const isIncome = row.dataset.lineType === 'IN';
    const cat = row.querySelector('.bank-recon-cat-select')?.value;
    if (!cat) return false;
    if (isIncome) return true;
    const sub_category = row.querySelector('.bank-recon-subcat-input')?.value?.trim();
    const vendor_name = row.querySelector('.bank-recon-vendor-input')?.value?.trim();
    return Boolean(sub_category && vendor_name);
};

const renderBalanceCells = (line, showBalances) => {
    if (!showBalances) return '';
    const computed = line.computedBalance != null ? formatMoney(line.computedBalance) : '—';
    const passbook = line.balance != null && line.balance !== '' ? formatMoney(line.balance) : '—';
    const mismatchTitle = line.passbookMismatch && line.computedBalance != null
        ? ` title="Calculated ${formatMoney(line.computedBalance)} ≠ passbook ${formatMoney(line.balance)}"`
        : '';
    const mismatchClass = line.passbookMismatch ? ' bank-recon-balance--mismatch' : '';
    const icon = line.passbookMismatch
        ? '<i class="fa-solid fa-triangle-exclamation bank-recon-mismatch-icon" aria-hidden="true"></i>'
        : '';
    return `
      <td class="bank-recon-table__cell bank-recon-table__cell--num${mismatchClass}"${mismatchTitle}>${computed}</td>
      <td class="bank-recon-table__cell bank-recon-table__cell--num${mismatchClass}"${mismatchTitle}>${passbook}${icon}</td>`;
};

const renderOpeningBalancePanel = () => {
    const opening = getBankOpeningConfig();
    const recon = getBankBalanceReconciliation();
    const hasOpening = opening.amount != null && opening.date;

    let statusHtml = '';
    if (!hasOpening) {
        statusHtml = '<p class="bank-recon-balance-panel__hint">Set your passbook opening balance and date below. Each import adds movements; we calculate running balance and compare it to the passbook balance on each row.</p>';
    } else if (recon.passbook && recon.hasDiscrepancy) {
        statusHtml = `<p class="bank-recon-balance-panel__alert"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> Overall discrepancy of <strong>${formatMoney(Math.abs(recon.diff))}</strong> — calculated ${formatMoney(recon.calculated.balance)} vs passbook ${formatMoney(recon.passbook.balance)}. Review highlighted rows below.</p>`;
    } else if (recon.passbook && !recon.hasDiscrepancy) {
        statusHtml = '<p class="bank-recon-balance-panel__ok"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> Calculated balance matches the latest passbook closing balance.</p>';
    } else if (recon.calculated.balance != null) {
        statusHtml = `<p class="bank-recon-balance-panel__hint">Calculated balance is ${formatMoney(recon.calculated.balance)}${recon.calculated.asOf ? ` as of ${recon.calculated.asOf}` : ''}. Import statements with a balance column to compare against passbook.</p>`;
    }

    const mismatchNote = recon.mismatchCount > 0
        ? `<span class="bank-recon-balance-panel__mismatch-count">${recon.mismatchCount} row(s) with balance mismatch</span>`
        : '';

    return `
      <div class="bank-recon-balance-panel__inner">
        <div class="bank-recon-balance-panel__opening">
          <h4 class="bank-recon-balance-panel__title">Opening balance</h4>
          <div class="bank-recon-balance-panel__fields">
            <label class="bank-recon-balance-panel__field">
              <span>As of date</span>
              <input type="date" id="bank-recon-opening-date" value="${esc(opening.date || '')}" />
            </label>
            <label class="bank-recon-balance-panel__field">
              <span>Amount (₹)</span>
              <input type="number" step="0.01" id="bank-recon-opening-amount" value="${opening.amount != null ? esc(opening.amount) : ''}" placeholder="e.g. 150000" />
            </label>
            <button type="button" class="btn btn-outline btn--small" id="bank-recon-opening-save">Save opening</button>
          </div>
          ${mismatchNote}
        </div>
        ${statusHtml}
      </div>`;
};

const renderStatementTable = (unmatched, showBalances = false) => {
    if (!unmatched.length) {
        return '<p class="maintenance-dues-empty">No unmatched statement lines. Import a bank statement to begin.</p>';
    }

    const rows = unmatched.map((line) => {
        const lineType = bankLineType(line);
        const isIncome = lineType === 'IN';
        const ledgerTxns = getUnmatchedLedgerTxns(lineType);
        const suggestions = suggestMatches(line, ledgerTxns);
        const sugOptions = suggestions.map((t) =>
            `<option value="${t.id}">★ ${new Date(t.date).toLocaleDateString('en-GB')} · ${formatMoney(t.amount)} · ${esc((t.description || t.cat || '').slice(0, 30))}</option>`,
        ).join('');
        const allOptions = ledgerTxns.map((t) =>
            `<option value="${t.id}">${new Date(t.date).toLocaleDateString('en-GB')} · ${esc(t.cat || t.type)} · ${formatMoney(t.amount)} · ${esc((t.description || '').slice(0, 30))}</option>`,
        ).join('');
        const subCats = !isIncome
            ? subCatOptionsForCategory(null).map((s) => `<option value="${esc(s)}">`).join('')
            : '';

        return `<tr class="bank-recon-table__row${line.passbookMismatch ? ' bank-recon-table__row--mismatch' : ''}" data-line-id="${line.id}" data-line-type="${lineType}">
          <td class="bank-recon-table__cell bank-recon-table__cell--check">
            <input type="checkbox" class="bank-recon-row-check" data-line="${line.id}" aria-label="Select row" />
          </td>
          <td class="bank-recon-table__cell bank-recon-table__cell--date">
            <input type="date" class="bank-recon-cell-input" data-line="${line.id}" data-field="line_date" value="${esc(line.line_date)}" />
          </td>
          <td class="bank-recon-table__cell bank-recon-table__cell--desc">
            <input type="text" class="bank-recon-cell-input bank-recon-cell-input--desc" data-line="${line.id}" data-field="description" value="${esc(line.description || '')}" placeholder="Description" />
          </td>
          <td class="bank-recon-table__cell bank-recon-table__cell--num">
            <input type="number" min="0" step="0.01" class="bank-recon-cell-input bank-recon-cell-input--num" data-line="${line.id}" data-field="debit" value="${formatAmountInput(line.debit)}" placeholder="0" ${isIncome ? 'disabled' : ''} />
          </td>
          <td class="bank-recon-table__cell bank-recon-table__cell--num">
            <input type="number" min="0" step="0.01" class="bank-recon-cell-input bank-recon-cell-input--num" data-line="${line.id}" data-field="credit" value="${formatAmountInput(line.credit)}" placeholder="0" ${!isIncome ? 'disabled' : ''} />
          </td>
          ${renderBalanceCells(line, showBalances)}
          <td class="bank-recon-table__cell bank-recon-table__cell--type">
            <span class="bank-recon-type-badge bank-recon-type-badge--${lineType.toLowerCase()}">${lineType === 'IN' ? 'Income' : 'Expense'}</span>
          </td>
          <td class="bank-recon-table__cell bank-recon-table__cell--classify">
            <select class="bank-recon-cell-select bank-recon-cat-select" data-line="${line.id}" title="Category">
              <option value="">Category…</option>
              ${renderCatOptions(isIncome)}
            </select>
            ${isIncome ? '' : `<input type="text" class="bank-recon-cell-input bank-recon-subcat-input" data-line="${line.id}" list="bank-recon-subcats-${line.id}" placeholder="Sub-category *" />
            <datalist id="bank-recon-subcats-${line.id}">${subCats}</datalist>
            <input type="text" class="bank-recon-cell-input bank-recon-vendor-input" data-line="${line.id}" list="bank-recon-vendors" placeholder="Vendor *" value="${esc((line.description || '').slice(0, 48))}" />`}
          </td>
          <td class="bank-recon-table__cell bank-recon-table__cell--match">
            <select class="bank-recon-cell-select bank-match-select" data-line="${line.id}">
              <option value="">Match…</option>
              ${sugOptions ? `<optgroup label="Suggested">${sugOptions}</optgroup>` : ''}
              ${allOptions ? `<optgroup label="All ${isIncome ? 'income' : 'expenses'}">${allOptions}</optgroup>` : ''}
            </select>
          </td>
          <td class="bank-recon-table__cell bank-recon-table__cell--actions">
            <div class="bank-recon-row-actions">
              <span class="bank-recon-row-status" hidden aria-live="polite"></span>
              <button type="button" class="btn btn-outline btn--small btn--icon bank-ignore-btn" data-line="${line.id}" title="Ignore line" aria-label="Ignore"><i class="fa-solid fa-eye-slash" aria-hidden="true"></i></button>
              <button type="button" class="btn btn-outline btn--small btn--icon btn--danger bank-delete-btn" data-line="${line.id}" title="Delete line" aria-label="Delete"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>
            </div>
          </td>
        </tr>`;
    }).join('');

    const vendorDatalist = (portalState.finances.vendors || [])
        .map((v) => `<option value="${esc(v.name)}">`).join('');

    return `
      <datalist id="bank-recon-vendors">${vendorDatalist}</datalist>
      <p class="bank-recon-work-hint">For <strong>expenses</strong>, pick category, sub-category, and vendor — saves when all three are set. For <strong>income</strong>, category alone is enough. Or pick a <strong>match</strong> to link an existing ledger entry.</p>
      <div class="bank-recon-bulk-bar">
        <label class="bank-recon-bulk-select-all">
          <input type="checkbox" id="bank-recon-select-all" aria-label="Select all rows" />
          <span>Select all</span>
        </label>
        <button type="button" class="btn btn-outline btn--small" id="bank-recon-bulk-delete" disabled>
          <i class="fa-solid fa-trash-can" aria-hidden="true"></i> Delete selected
        </button>
        <span id="bank-recon-bulk-count" class="bank-recon-bulk-count"></span>
      </div>
      <div class="bank-recon-table-wrap">
        <table class="bank-recon-table">
          <thead>
            <tr>
              <th class="bank-recon-table__th--check"><span class="sr-only">Select</span></th>
              <th>Date</th>
              <th>Description</th>
              <th class="bank-recon-table__th--num">Debit</th>
              <th class="bank-recon-table__th--num">Credit</th>
              ${showBalances ? '<th class="bank-recon-table__th--num">Calculated</th><th class="bank-recon-table__th--num">Passbook</th>' : ''}
              <th>Type</th>
              <th>Category / vendor</th>
              <th class="bank-recon-table__th--match">Match ledger</th>
              <th class="bank-recon-table__th--actions"></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
};

const renderProcessedLinesSection = (matched, ignored, showBalances = false) => {
    const rows = [...matched, ...ignored];
    if (!rows.length) return '';

    const body = rows.map((line) => {
        const isIncome = bankLineType(line) === 'IN';
        const amt = bankLineAmount(line);
        const amtLabel = isIncome ? `+${formatMoney(amt)}` : `-${formatMoney(amt)}`;
        const status = line.match_status === 'MATCHED' ? 'Matched' : 'Ignored';
        const statusClass = line.match_status === 'MATCHED' ? 'bank-recon-status--matched' : 'bank-recon-status--ignored';
        const txn = line.transaction_id
            ? portalState.finances.txns?.find((t) => t.id === line.transaction_id)
            : null;
        const txnLabel = txn
            ? `${txn.cat || txn.type}${txn.sub_category ? ` · ${txn.sub_category}` : ''}${txn.vendor_name ? ` · ${txn.vendor_name}` : ''} · ${formatMoney(txn.amount)}`
            : '';

        return `<tr class="bank-recon-table__row bank-recon-table__row--processed bank-recon-table__row--readonly${line.passbookMismatch ? ' bank-recon-table__row--mismatch' : ''}" data-line-id="${line.id}">
          <td class="bank-recon-table__cell">${esc(line.line_date)}</td>
          <td class="bank-recon-table__cell bank-recon-table__cell--desc">${esc(line.description || '—')}</td>
          <td class="bank-recon-table__cell bank-recon-table__cell--num ${isIncome ? 'bank-recon-amt--in' : 'bank-recon-amt--out'}">${amtLabel}</td>
          ${renderBalanceCells(line, showBalances)}
          <td class="bank-recon-table__cell"><span class="bank-recon-status ${statusClass}">${status}</span>${txnLabel ? `<span class="bank-recon-processed-txn">${esc(txnLabel)}</span>` : ''}</td>
          <td class="bank-recon-table__cell bank-recon-table__cell--actions">
            <div class="bank-recon-row-actions">
              ${line.match_status === 'MATCHED' ? `<button type="button" class="btn btn-outline btn--small bank-edit-btn" data-line="${line.id}" title="Return to work queue to re-classify or re-match">Edit</button>` : ''}
              <button type="button" class="btn btn-outline btn--small btn--icon btn--danger bank-delete-btn" data-line="${line.id}" title="Delete" aria-label="Delete"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>
            </div>
          </td>
        </tr>`;
    }).join('');

    return `
      <section class="bank-recon-processed">
        <h4 class="bank-recon-processed__title">Matched &amp; ignored <span class="bank-recon-processed__count">(${rows.length})</span></h4>
        <p class="bank-recon-processed__hint">Reconciled lines are read-only here. Use Edit to return a matched line to the work queue.</p>
        <div class="bank-recon-table-wrap bank-recon-table-wrap--compact">
          <table class="bank-recon-table bank-recon-table--processed">
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th class="bank-recon-table__th--num">Amount</th>
                ${showBalances ? '<th class="bank-recon-table__th--num">Calculated</th><th class="bank-recon-table__th--num">Passbook</th>' : ''}
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </section>`;
};

const wireProcessedLines = (root) => {
    root.querySelectorAll('.bank-edit-btn, .bank-unmatch-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            try {
                await unmatchBankLine(btn.dataset.line);
                renderBankReconciliation();
                window.renderCashLedger?.();
            } catch (err) {
                alert(err?.message || 'Could not return line to work queue.');
            }
        });
    });

    root.querySelectorAll('.bank-recon-processed .bank-delete-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!confirm('Delete this statement line permanently?')) return;
            try {
                await deleteBankStatementLine(btn.dataset.line);
                renderBankReconciliation();
            } catch (err) {
                alert(err?.message || 'Could not delete line.');
            }
        });
    });
};

const renderLedgerTable = (ledgerTxns) => {
    if (!ledgerTxns.length) {
        return '<p class="maintenance-dues-empty">All bank ledger transactions are matched.</p>';
    }

    const rows = ledgerTxns.slice(0, 80).map((t) => `
      <tr class="bank-recon-table__row">
        <td class="bank-recon-table__cell">${new Date(t.date).toLocaleDateString('en-GB')}</td>
        <td class="bank-recon-table__cell">${esc(t.type)}</td>
        <td class="bank-recon-table__cell bank-recon-table__cell--num ${t.type === 'IN' ? 'bank-recon-amt--in' : 'bank-recon-amt--out'}">
          ${t.type === 'IN' ? '+' : '-'}${formatMoney(t.amount)}
        </td>
        <td class="bank-recon-table__cell bank-recon-table__cell--desc">${esc(t.description || t.cat || '—')}</td>
      </tr>`).join('');

    return `
      <div class="bank-recon-table-wrap bank-recon-table-wrap--compact">
        <table class="bank-recon-table bank-recon-table--ledger">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th class="bank-recon-table__th--num">Amount</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
};

const syncBulkSelectionUi = (root) => {
    const checks = [...root.querySelectorAll('.bank-recon-row-check')];
    const selected = checks.filter((c) => c.checked);
    const bulkBtn = root.querySelector('#bank-recon-bulk-delete');
    const countEl = root.querySelector('#bank-recon-bulk-count');
    const selectAll = root.querySelector('#bank-recon-select-all');

    if (bulkBtn) bulkBtn.disabled = selected.length === 0;
    if (countEl) {
        countEl.textContent = selected.length
            ? `${selected.length} selected`
            : '';
    }
    if (selectAll) {
        selectAll.indeterminate = selected.length > 0 && selected.length < checks.length;
        selectAll.checked = checks.length > 0 && selected.length === checks.length;
    }
};

const setRowBusy = (row, busy, label = '') => {
    if (!row) return;
    row.classList.toggle('bank-recon-table__row--busy', busy);
    row.querySelectorAll('select, input, button').forEach((el) => { el.disabled = busy; });
    const statusEl = row.querySelector('.bank-recon-row-status');
    if (statusEl) {
        statusEl.textContent = busy ? label : '';
        statusEl.hidden = !busy;
    }
};

const clearRowClassify = (row) => {
    row?.querySelector('.bank-recon-cat-select') && (row.querySelector('.bank-recon-cat-select').value = '');
    row?.querySelector('.bank-recon-subcat-input') && (row.querySelector('.bank-recon-subcat-input').value = '');
    row?.querySelector('.bank-recon-vendor-input') && (row.querySelector('.bank-recon-vendor-input').value = '');
};

const clearRowMatch = (row) => {
    const matchSel = row?.querySelector('.bank-match-select');
    if (matchSel) matchSel.value = '';
};

const tryAutoPostFromRow = async (row, lineId) => {
    if (!row || row.classList.contains('bank-recon-table__row--busy')) return;
    const matchSel = row.querySelector('.bank-match-select');
    if (matchSel?.value) return;

    const cat = row.querySelector('.bank-recon-cat-select')?.value;
    if (!cat) return;
    const sub_category = row.querySelector('.bank-recon-subcat-input')?.value?.trim() || null;
    const vendor_name = row.querySelector('.bank-recon-vendor-input')?.value?.trim() || null;
    if (!rowClassifyReady(row)) return;

    setRowBusy(row, true, 'Posting…');
    try {
        await createTxnFromBankLine(lineId, { cat, sub_category, vendor_name });
        renderBankReconciliation();
        window.renderCashLedger?.();
        window.processFinances?.();
    } catch (err) {
        setRowBusy(row, false);
        alert(err?.message || 'Could not post transaction.');
    }
};

const tryAutoMatchFromRow = async (row, lineId, txnId) => {
    if (!row || row.classList.contains('bank-recon-table__row--busy')) return;
    clearRowClassify(row);
    setRowBusy(row, true, 'Matching…');
    try {
        await matchBankLine(lineId, txnId);
        renderBankReconciliation();
        window.renderCashLedger?.();
    } catch (err) {
        setRowBusy(row, false);
        const matchSel = row.querySelector('.bank-match-select');
        if (matchSel) matchSel.value = '';
        alert(err?.message || 'Match failed.');
    }
};

const wireStatementTable = (linesEl) => {
    const getSelectedLineIds = () => [...linesEl.querySelectorAll('.bank-recon-row-check:checked')]
        .map((c) => c.dataset.line);

    linesEl.querySelector('#bank-recon-select-all')?.addEventListener('change', (e) => {
        const on = e.target.checked;
        linesEl.querySelectorAll('.bank-recon-row-check').forEach((c) => { c.checked = on; });
        syncBulkSelectionUi(linesEl);
    });

    linesEl.querySelectorAll('.bank-recon-row-check').forEach((cb) => {
        cb.addEventListener('change', () => syncBulkSelectionUi(linesEl));
    });

    linesEl.querySelector('#bank-recon-bulk-delete')?.addEventListener('click', async () => {
        const ids = getSelectedLineIds();
        if (!ids.length) return;
        if (!confirm(`Delete ${ids.length} statement line(s) permanently?`)) return;
        const btn = linesEl.querySelector('#bank-recon-bulk-delete');
        try {
            await withButtonBusy(btn, 'Deleting…', () => deleteBankStatementLines(ids));
            renderBankReconciliation();
        } catch (err) {
            alert(err?.message || 'Bulk delete failed.');
        }
    });

    syncBulkSelectionUi(linesEl);
    linesEl.querySelectorAll('.bank-recon-cell-input').forEach((input) => {
        input.addEventListener('change', async () => {
            const lineId = input.dataset.line;
            const field = input.dataset.field;
            let value = input.value;
            if (field === 'debit' || field === 'credit' || field === 'balance') {
                value = value === '' ? 0 : parseFloat(value);
                if (!Number.isFinite(value)) return;
            }
            try {
                await updateBankStatementLine(lineId, { [field]: value });
                if (field === 'debit' && value > 0) {
                    const creditInput = linesEl.querySelector(`input[data-line="${lineId}"][data-field="credit"]`);
                    if (creditInput?.value) {
                        creditInput.value = '';
                        await updateBankStatementLine(lineId, { credit: 0 });
                    }
                }
                if (field === 'credit' && value > 0) {
                    const debitInput = linesEl.querySelector(`input[data-line="${lineId}"][data-field="debit"]`);
                    if (debitInput?.value) {
                        debitInput.value = '';
                        await updateBankStatementLine(lineId, { debit: 0 });
                    }
                }
                if (field === 'debit' || field === 'credit' || field === 'line_date') {
                    renderBankReconciliation();
                }
            } catch (err) {
                alert(err?.message || 'Could not save line.');
                renderBankReconciliation();
            }
        });
    });

    linesEl.querySelectorAll('.bank-match-select').forEach((sel) => {
        sel.addEventListener('change', async () => {
            const txnId = sel.value;
            if (!txnId) return;
            await tryAutoMatchFromRow(sel.closest('tr'), sel.dataset.line, txnId);
        });
    });

    linesEl.querySelectorAll('.bank-recon-cat-select').forEach((sel) => {
        sel.addEventListener('change', () => {
            const row = sel.closest('tr');
            clearRowMatch(row);
            const isIncome = row?.dataset.lineType === 'IN';
            if (!isIncome) {
                row?.querySelector('.bank-recon-subcat-input') && (row.querySelector('.bank-recon-subcat-input').value = '');
                updateRowSubCatDatalist(row, sel.value);
                return;
            }
            tryAutoPostFromRow(row, sel.dataset.line);
        });
    });

    const onExpenseFieldReady = (input) => {
        const row = input.closest('tr');
        if (rowClassifyReady(row)) tryAutoPostFromRow(row, input.dataset.line);
    };

    linesEl.querySelectorAll('.bank-recon-vendor-input').forEach((input) => {
        input.addEventListener('change', () => onExpenseFieldReady(input));
        input.addEventListener('blur', () => onExpenseFieldReady(input));
    });

    linesEl.querySelectorAll('.bank-recon-subcat-input').forEach((input) => {
        input.addEventListener('change', () => onExpenseFieldReady(input));
        input.addEventListener('blur', () => onExpenseFieldReady(input));
    });

    linesEl.querySelectorAll('.bank-delete-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!confirm('Delete this statement line permanently?')) return;
            try {
                await deleteBankStatementLine(btn.dataset.line);
                renderBankReconciliation();
            } catch (err) {
                alert(err?.message || 'Could not delete line.');
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

export const renderBankReconciliation = () => {
    const linesEl = document.getElementById('bank-recon-lines');
    const txnsEl = document.getElementById('bank-recon-txns');
    const statsEl = document.getElementById('bank-recon-stats');
    const balancePanelEl = document.getElementById('bank-recon-balance-panel');
    const passbookBtn = document.getElementById('bank-recon-passbook-btn');
    const passbookHint = document.getElementById('bank-recon-passbook-hint');
    if (!linesEl || !txnsEl) return;

    const passbookReady = isPassbookOcrConfigured();
    if (passbookBtn) {
        passbookBtn.disabled = !passbookReady;
        passbookBtn.title = passbookReady
            ? 'Scan passbook photos or PDF with Evolyx OCR'
            : 'Configure Evolyx under Administration → External Connections';
    }
    if (passbookHint) {
        passbookHint.hidden = passbookReady;
        passbookHint.innerHTML = passbookReady
            ? ''
            : 'Passbook OCR is not configured. <a href="#admin-connections">Set up Evolyx</a> under Administration → External Connections.';
    }

    const annotated = annotateStatementLineBalances();
    const lines = portalState.finances.bankStatementLines || [];
    const unmatched = annotated.filter((l) => l.match_status === 'UNMATCHED');
    const matched = annotated.filter((l) => l.match_status === 'MATCHED');
    const ignored = annotated.filter((l) => l.match_status === 'IGNORED');
    const recon = getBankBalanceReconciliation();
    const showBalances = recon.opening.amount != null;

    if (balancePanelEl) {
        balancePanelEl.innerHTML = renderOpeningBalancePanel();
        document.getElementById('bank-recon-opening-save')?.addEventListener('click', async () => {
            const date = document.getElementById('bank-recon-opening-date')?.value;
            const raw = document.getElementById('bank-recon-opening-amount')?.value?.trim();
            const amount = raw === '' ? null : parseFloat(raw);
            const btn = document.getElementById('bank-recon-opening-save');
            try {
                await withButtonBusy(btn, 'Saving…', () => saveBankOpeningBalance(date, amount));
                renderBankReconciliation();
            } catch (err) {
                alert(err?.message || 'Could not save opening balance.');
            }
        });
    }

    if (statsEl) {
        const calcCard = recon.calculated.balance != null
            ? `<div class="metric-card metric-card--highlight"><span class="label">Calculated balance</span><span class="value">${formatMoney(recon.calculated.balance)}</span><span class="metric-card__sub">opening + ${recon.calculated.lineCount} line(s)${recon.calculated.asOf ? ` · as of ${recon.calculated.asOf}` : ''}</span></div>`
            : `<div class="metric-card metric-card--warn"><span class="label">Calculated balance</span><span class="value">—</span><span class="metric-card__sub">set opening balance above</span></div>`;
        const passbookCard = recon.passbook
            ? `<div class="metric-card${recon.hasDiscrepancy ? ' metric-card--danger' : ''}"><span class="label">Passbook balance</span><span class="value">${formatMoney(recon.passbook.balance)}</span><span class="metric-card__sub">last row with balance · ${recon.passbook.asOf}</span></div>`
            : '';
        const varianceCard = recon.diff != null
            ? `<div class="metric-card${recon.hasDiscrepancy ? ' metric-card--danger' : ' metric-card--ok'}"><span class="label">Variance</span><span class="value">${recon.diff >= 0 ? '+' : ''}${formatMoney(recon.diff)}</span><span class="metric-card__sub">${recon.hasDiscrepancy ? 'needs review' : 'in balance'}</span></div>`
            : '';
        statsEl.innerHTML = `
          ${calcCard}
          ${passbookCard}
          ${varianceCard}
          <div class="metric-card"><span class="label">Statement lines</span><span class="value">${lines.length}</span></div>
          <div class="metric-card"><span class="label">Unmatched</span><span class="value" style="color:var(--danger);">${unmatched.length}</span></div>
          <div class="metric-card"><span class="label">Matched</span><span class="value" style="color:var(--success);">${matched.length}</span></div>
          <div class="metric-card"><span class="label">Ignored</span><span class="value">${ignored.length}</span></div>`;
    }

    const ledgerTxns = getUnmatchedLedgerTxns();

    linesEl.innerHTML = renderStatementTable(unmatched, showBalances) + renderProcessedLinesSection(matched, ignored, showBalances);
    txnsEl.innerHTML = renderLedgerTable(ledgerTxns);

    wireStatementTable(linesEl);
    wireProcessedLines(linesEl);
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
    const setPassbookStatus = (msg, isError = false) => {
        const el = document.getElementById('bank-recon-passbook-status');
        if (!el) return;
        el.hidden = !msg;
        el.textContent = msg;
        el.classList.toggle('bank-recon-passbook-status--error', isError);
    };

    document.getElementById('bank-recon-import-btn')?.addEventListener('click', () => {
        document.getElementById('bank-recon-file')?.click();
    });
    document.getElementById('bank-recon-passbook-btn')?.addEventListener('click', () => {
        if (!isPassbookOcrConfigured()) {
            alert('Passbook OCR is not configured. Go to Administration → External Connections to add your Evolyx API key.');
            return;
        }
        document.getElementById('bank-recon-passbook-files')?.click();
    });
    document.getElementById('bank-recon-template-btn')?.addEventListener('click', () => {
        downloadBankStatementTemplate().catch((err) => alert(err?.message || 'Download failed.'));
    });
    document.getElementById('bank-recon-clear-all-btn')?.addEventListener('click', async () => {
        const count = (portalState.finances.bankStatementLines || []).length;
        if (!count) return alert('No statement imports to clear.');
        if (!confirm(`Delete all ${count} imported statement line(s)? Ledger transactions you posted are not deleted. Opening balance is kept.`)) return;
        const btn = document.getElementById('bank-recon-clear-all-btn');
        try {
            const { deleted } = await withButtonBusy(btn, 'Clearing…', () => clearAllBankStatementData());
            alert(deleted ? `Cleared ${deleted} statement line(s).` : 'Nothing to clear.');
            renderBankReconciliation();
        } catch (err) {
            alert(err?.message || 'Could not clear statement data.');
        }
    });
    document.getElementById('bank-recon-file')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const lines = await parseBankStatementFile(file);
            const { unique, skipped } = dedupeBankImportLines(lines);
            const dupNote = skipped ? `\n\n${skipped} duplicate(s) will be skipped.` : '';
            if (!unique.length) {
                alert(`All ${lines.length} line(s) are duplicates (same date, description, and amount). Nothing to import.`);
                return;
            }
            if (!confirm(`Import ${unique.length} new line(s) from ${file.name}?${dupNote}`)) return;
            const result = await importBankStatement(file, lines);
            alert(importResultMessage(result));
            renderBankReconciliation();
        } catch (err) {
            alert(err?.message || 'Import failed.');
        } finally {
            e.target.value = '';
        }
    });

    document.getElementById('bank-recon-passbook-files')?.addEventListener('change', async (e) => {
        const input = e.target;
        const fileList = input.files;
        if (!fileList?.length) return;
        const btn = document.getElementById('bank-recon-passbook-btn');
        setPassbookStatus('');
        try {
            const files = validatePassbookFiles(fileList);
            if (!confirm(`Scan ${files.length} passbook file(s) with Evolyx OCR? This may take a few minutes.`)) return;

            setPassbookStatus('Scanning passbook… this may take up to 5 minutes. Please wait.');
            const { lines, meta } = await withButtonBusy(btn, 'Scanning…', () => parsePassbookFiles(files));

            const preview = lines.slice(0, 3).map((l) => {
                const amt = l.credit > 0 ? `+₹${l.credit}` : `-₹${l.debit}`;
                return `${l.line_date} ${amt} ${(l.description || '').slice(0, 40)}`;
            }).join('\n');
            const more = lines.length > 3 ? `\n… and ${lines.length - 3} more` : '';
            const { unique, skipped } = dedupeBankImportLines(lines);
            const dupNote = skipped ? `\n\n${skipped} duplicate(s) will be skipped.` : '';
            if (!unique.length) {
                alert(`All ${lines.length} line(s) are duplicates. Nothing to import.`);
                return;
            }
            if (!confirm(`Found ${lines.length} transaction(s).\n\n${preview}${more}\n\nImport ${unique.length} new line(s)?${dupNote}`)) return;

            const result = await importBankStatement(null, lines, {
                fileLabel: passbookImportLabel(files, meta),
            });
            setPassbookStatus(`Imported ${result.count} line(s) from passbook scan.`);
            alert(importResultMessage(result));
            renderBankReconciliation();
        } catch (err) {
            const msg = err?.message || 'Passbook scan failed.';
            setPassbookStatus(msg, true);
            alert(msg);
        } finally {
            input.value = '';
        }
    });
};

window.renderBankReconciliation = renderBankReconciliation;
