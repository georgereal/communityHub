/**
 * Lightweight bank statement / opening queries for ledger KPIs and table.
 * Kept separate from bankReconciliation.js so ledger load does not pull ExcelJS / OCR / passbook UI.
 */
import { fnFinances } from './classicState.js';
import { getFinanceNew } from './state.js';
import { compareLineOrder } from '../bankStatementOrdering.js';

const BALANCE_TOLERANCE = 0.01;

export const getMatchedTransactionIds = () => {
    const ids = new Set();
    (fnFinances().bankStatementLines || []).forEach((line) => {
        if (line.match_status === 'MATCHED' && line.transaction_id) ids.add(line.transaction_id);
    });
    return ids;
};

export const isTransactionReconciled = (txnId) => getMatchedTransactionIds().has(txnId);

const bankStatementImportById = () => new Map(
    (fnFinances().bankStatementImports || []).map((row) => [row.id, row]),
);

/** Statement / passbook balance on a row (Excel Balance column or Evolyx OCR). */
const passbookRowBalance = (line) => {
    if (line?.balance == null || line.balance === '') return null;
    const value = parseFloat(line.balance);
    return Number.isFinite(value) ? value : null;
};

/** Opening balance baseline from Finance-New Mongo finance_config.bankAccount. */
export const getBankOpeningConfig = () => {
    const fn = getFinanceNew();
    const bank = fnFinances().bankAccount
        || fn?.admin?.bankAccount
        || fn?.config?.bankAccount
        || null;
    const raw = bank?.opening_balance;
    const amount = raw != null && raw !== '' && !Number.isNaN(parseFloat(raw))
        ? parseFloat(raw)
        : null;
    const dateRaw = bank?.opening_balance_date;
    const date = dateRaw ? String(dateRaw).slice(0, 10) : null;
    return { amount, date };
};

export const getStatementLinesChronological = () =>
    [...(fnFinances().bankStatementLines || [])].sort((a, b) =>
        compareLineOrder(a, b, bankStatementImportById()),
    );

/** Running balance per line from current statement order (respects manual line_order). */
export const annotateStatementLineBalances = () => {
    const opening = getBankOpeningConfig();
    const hasOpening = opening.amount != null;
    const chronological = getStatementLinesChronological();

    let running = hasOpening ? opening.amount : 0;
    const liveById = new Map();
    if (hasOpening) {
        for (const line of chronological) {
            const onOrAfterOpening = !opening.date || line.line_date >= opening.date;
            if (onOrAfterOpening) {
                running += parseFloat(line.credit || 0) - parseFloat(line.debit || 0);
                liveById.set(line.id, running);
            }
        }
    }

    return chronological.map((line) => {
        const onOrAfterOpening = !opening.date || line.line_date >= opening.date;
        let computedBalance = null;
        let passbookMismatch = false;

        if (hasOpening && onOrAfterOpening) {
            // Always use live walk from current line_order / order_source.
            // Persisted computed_balance goes stale after ledger ↑↓ reorder until Recalculate.
            computedBalance = liveById.has(line.id)
                ? liveById.get(line.id)
                : (line.computed_balance != null && line.computed_balance !== ''
                    ? parseFloat(line.computed_balance)
                    : null);
            const passbookBal = passbookRowBalance(line);
            if (computedBalance != null && passbookBal != null
                && Math.abs(computedBalance - passbookBal) > BALANCE_TOLERANCE) {
                passbookMismatch = true;
            }
        }

        return { ...line, computedBalance, passbookMismatch };
    });
};

/**
 * Balance from opening baseline + MATCHED statement line movements on/after opening date.
 *
 * Only MATCHED lines are counted because unmatched lines have not been posted to the
 * ledger yet — including them would overstate or understate the calculated book balance
 * and cause a spurious variance against the passbook figure in Financial Reports.
 */
export const getCalculatedBankBalance = () => {
    const opening = getBankOpeningConfig();
    const allLines = getStatementLinesChronological().filter((l) =>
        !opening.date || l.line_date >= opening.date,
    );
    // Only count lines that have been matched and posted to the ledger.
    const matchedLines = allLines.filter((l) => l.match_status === 'MATCHED');

    if (opening.amount == null) {
        return { balance: null, asOf: opening.date, lineCount: matchedLines.length, needsOpening: true };
    }

    // Live closing from matched lines only (unmatched = not yet in ledger).
    let balance = opening.amount;
    let asOf = opening.date;
    for (const line of matchedLines) {
        balance += parseFloat(line.credit || 0) - parseFloat(line.debit || 0);
        asOf = line.line_date;
    }
    return { balance, asOf, lineCount: matchedLines.length, needsOpening: false };
};

/** Passbook on posted (MATCHED) lines only — same universe as ledger calculated. */
export const getPostedPassbookBalance = (asOf = null) => {
    const opening = getBankOpeningConfig();
    const cutoff = asOf ? String(asOf).slice(0, 10) : null;
    const chronological = getStatementLinesChronological().filter((line) => {
        if (opening.date && line.line_date < opening.date) return false;
        if (line.match_status !== 'MATCHED') return false;
        if (cutoff && String(line.line_date).slice(0, 10) > cutoff) return false;
        return true;
    });

    for (let i = chronological.length - 1; i >= 0; i -= 1) {
        const line = chronological[i];
        const passbookBalance = passbookRowBalance(line);
        if (passbookBalance != null) {
            return {
                balance: passbookBalance,
                asOf: line.line_date,
                lineId: line.id,
            };
        }
    }
    return null;
};

/** Passbook closing from the last statement row with a balance (includes unmatched work). */
export const getPassbookClosingBalance = () => {
    const opening = getBankOpeningConfig();
    const chronological = getStatementLinesChronological().filter((l) =>
        !opening.date || l.line_date >= opening.date,
    );

    for (let i = chronological.length - 1; i >= 0; i -= 1) {
        const line = chronological[i];
        const passbookBalance = passbookRowBalance(line);
        if (passbookBalance != null) {
            return {
                balance: passbookBalance,
                asOf: line.line_date,
                lineId: line.id,
            };
        }
    }
    return null;
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

export const getUnmatchedBankLines = () =>
    (fnFinances().bankStatementLines || []).filter((l) => l.match_status === 'UNMATCHED');
