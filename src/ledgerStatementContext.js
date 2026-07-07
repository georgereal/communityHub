/**
 * Join ledger transactions to matched bank statement lines for passbook order & balances.
 */
import { portalState } from './store.js';
import { annotateStatementLineBalances, getBankOpeningConfig } from './bankReconciliation.js';
import { compareLineOrder, linePassbookBalance } from './bankStatementOrdering.js';

const PASSBOOK_IMPORT_PREFIX = 'evolyx-passbook:';

const passbookBalanceForLine = (line, importById) => {
    const importRow = importById.get(line?.import_id);
    const fileName = String(importRow?.file_name || '');
    if (!fileName.startsWith(PASSBOOK_IMPORT_PREFIX)) return null;
    return linePassbookBalance(line);
};

/** @returns {{ byTxnId: Map<string, object>, importById: Map<string, object> }} */
export function buildLedgerStatementContext() {
    const importById = new Map(
        (portalState.finances.bankStatementImports || []).map((row) => [row.id, row]),
    );
    const byTxnId = new Map();
    for (const line of annotateStatementLineBalances()) {
        if (line.transaction_id) byTxnId.set(line.transaction_id, line);
    }
    return { byTxnId, importById };
}

/** @param {object} txn */
export function enrichTxnWithStatementLine(txn, ctx) {
    const line = ctx?.byTxnId?.get(txn.id) || null;
    if (!line) {
        return {
            line: null,
            computedBalance: null,
            passbookBalance: null,
            source_row_index: null,
            line_order: null,
            passbookMismatch: false,
        };
    }
    return {
        line,
        computedBalance: line.computedBalance ?? null,
        passbookBalance: passbookBalanceForLine(line, ctx.importById),
        source_row_index: line.source_row_index ?? null,
        line_order: line.line_order ?? null,
        passbookMismatch: !!line.passbookMismatch,
    };
}

/** Tie-break sort for ledger rows — mirrors statement line chronology when linked. */
export function compareLedgerTxnStatementOrder(a, b, ctx) {
    const lineA = ctx?.byTxnId?.get(a.id);
    const lineB = ctx?.byTxnId?.get(b.id);
    if (lineA && lineB) return compareLineOrder(lineA, lineB, ctx.importById);
    if (lineA && !lineB) return -1;
    if (!lineA && lineB) return 1;
    const byDate = String(a.date || '').localeCompare(String(b.date || ''));
    if (byDate !== 0) return byDate;
    return String(a.id || '').localeCompare(String(b.id || ''));
}

export function getLedgerCalculatedHeaderHint(visibleColumns) {
    const opening = getBankOpeningConfig();
    return visibleColumns?.calculatedBalance && opening.amount == null
        ? ' title="Set opening balance in Bank Reconciliation to calculate"'
        : '';
}
