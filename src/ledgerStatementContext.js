/**
 * Join ledger transactions to matched bank statement lines for passbook order & balances.
 */
import { portalState } from './store.js';
import {
    annotateStatementLineBalances,
    getBankOpeningConfig,
    reorderBankStatementLines,
} from './bankReconciliation.js';
import { compareLineOrder, linePassbookBalance } from './bankStatementOrdering.js';

const PASSBOOK_IMPORT_PREFIX = 'evolyx-passbook:';

const passbookBalanceForLine = (line, importById) => {
    const importRow = importById.get(line?.import_id);
    const fileName = String(importRow?.file_name || '');
    if (!fileName.startsWith(PASSBOOK_IMPORT_PREFIX)) return null;
    return linePassbookBalance(line);
};

const txnDateKey = (txn) => String(txn?.date || '').slice(0, 10);

const isBankTxn = (txn) => (txn?.wallet || '').toUpperCase() === 'BANK';

const getActiveBankLedgerTxns = () =>
    (portalState.finances.txns || []).filter((txn) => !txn?.excluded_from_ledger && isBankTxn(txn));

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

/** Same-day peers for reconciled BANK ledger rows (matched statement line required). */
export function buildSameDayLedgerOrderMeta(ctx = null) {
    const statementCtx = ctx || buildLedgerStatementContext();
    const byDate = new Map();
    for (const txn of getActiveBankLedgerTxns()) {
        if (!statementCtx.byTxnId.has(txn.id)) continue;
        const key = txnDateKey(txn);
        if (!byDate.has(key)) byDate.set(key, []);
        byDate.get(key).push(txn);
    }
    const meta = new Map();
    for (const list of byDate.values()) {
        list.sort((a, b) => compareLedgerTxnStatementOrder(a, b, statementCtx));
        list.forEach((txn, index) => {
            meta.set(txn.id, { index, count: list.length, date: txnDateKey(txn) });
        });
    }
    return meta;
}

/**
 * Move a reconciled BANK ledger row among same-day peers.
 * Reorders matched statement lines in those peer slots (unmatched lines keep their positions).
 */
export async function moveLedgerTxnInDay(txnId, direction, { steps = 1, recalculate = true } = {}) {
    const ctx = buildLedgerStatementContext();
    const txn = (portalState.finances.txns || []).find((row) => row.id === txnId);
    if (!txn) throw new Error('Transaction not found.');
    if (!isBankTxn(txn)) throw new Error('Only BANK ledger rows can be reordered.');
    if (!ctx.byTxnId.has(txnId)) {
        throw new Error('Reconcile this row to a statement line first — order is kept on the matched passbook entry.');
    }

    const date = txnDateKey(txn);
    const peers = getActiveBankLedgerTxns()
        .filter((row) => txnDateKey(row) === date && ctx.byTxnId.has(row.id))
        .sort((a, b) => compareLedgerTxnStatementOrder(a, b, ctx));

    if (peers.length <= 1) return null;

    const idx = peers.findIndex((row) => row.id === txnId);
    if (idx < 0) return null;

    const stepCount = Math.max(1, parseInt(steps, 10) || 1);
    const targetIdx = Math.max(0, Math.min(peers.length - 1, idx + direction * stepCount));
    if (targetIdx === idx) return null;

    const reorderedPeers = [...peers];
    const [moved] = reorderedPeers.splice(idx, 1);
    reorderedPeers.splice(targetIdx, 0, moved);

    const dayLines = (portalState.finances.bankStatementLines || [])
        .filter((line) => String(line.line_date || '').slice(0, 10) === date)
        .sort((a, b) => compareLineOrder(a, b, ctx.importById));

    const peerLineIds = new Set(reorderedPeers.map((row) => ctx.byTxnId.get(row.id).id));
    const linkedQueue = reorderedPeers.map((row) => ctx.byTxnId.get(row.id));
    let qi = 0;
    const merged = dayLines.map((line) => {
        if (!peerLineIds.has(line.id)) return line;
        return linkedQueue[qi++];
    });

    const updates = merged.map((line, index) => ({ id: line.id, line_order: index }));
    await reorderBankStatementLines(updates, { recalculate });
    return { txnId, peerIds: reorderedPeers.map((row) => row.id) };
}

export function getLedgerCalculatedHeaderHint(visibleColumns) {
    const opening = getBankOpeningConfig();
    return visibleColumns?.calculatedBalance && opening.amount == null
        ? ' title="Set opening balance via the Opening control above"'
        : '';
}
