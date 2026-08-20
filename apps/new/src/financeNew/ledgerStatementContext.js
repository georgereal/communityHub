/**
 * Finance-New — join ledger txns to matched bank statement lines (Mongo / fnFinances).
 */
import { fnFinances } from './classicState.js';
import {
    annotateStatementLineBalances,
    getBankOpeningConfig,
} from './bankStatementQueries.js';
import { compareLineOrder, linePassbookBalance, ORDER_SOURCE } from '../bankStatementOrdering.js';

async function reorderBankStatementLines(updates, opts) {
    const { reorderBankStatementLines: reorder } = await import('./bankReconciliation.js');
    return reorder(updates, opts);
}

/** Balance printed on the matched statement / passbook row (Excel, CSV, or OCR). */
const passbookBalanceForLine = (line) => linePassbookBalance(line);

const lineDateKey = (line) => {
    const raw = String(line?.line_date || '');
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : raw.slice(0, 10);
};

const isBankTxn = (txn) => (txn?.wallet || '').toUpperCase() === 'BANK';

const getActiveBankLedgerTxns = () =>
    (fnFinances().txns || []).filter((txn) => !txn?.excluded_from_ledger && isBankTxn(txn));

/** @returns {{ byTxnId: Map<string, object>, importById: Map<string, object> }} */
export function buildLedgerStatementContext() {
    const importById = new Map(
        (fnFinances().bankStatementImports || []).map((row) => [row.id, row]),
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
        passbookBalance: passbookBalanceForLine(line),
        source_row_index: line.source_row_index ?? null,
        line_order: line.line_order ?? null,
        passbookMismatch: !!line.passbookMismatch,
    };
}

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

export function buildSameDayLedgerOrderMeta(ctx = null) {
    const statementCtx = ctx || buildLedgerStatementContext();
    const byDate = new Map();
    for (const txn of getActiveBankLedgerTxns()) {
        const line = statementCtx.byTxnId.get(txn.id);
        if (!line) continue;
        const key = lineDateKey(line);
        if (!key) continue;
        if (!byDate.has(key)) byDate.set(key, []);
        byDate.get(key).push({ txn, line });
    }
    const meta = new Map();
    for (const [date, list] of byDate) {
        list.sort((a, b) => compareLineOrder(a.line, b.line, statementCtx.importById));
        list.forEach((row, index) => {
            meta.set(row.txn.id, { index, count: list.length, date });
        });
    }
    return meta;
}

export async function moveLedgerTxnInDay(txnId, direction, { steps = 1, recalculate = true } = {}) {
    const ctx = buildLedgerStatementContext();
    const txn = (fnFinances().txns || []).find((row) => row.id === txnId);
    if (!txn) throw new Error('Transaction not found.');
    if (!isBankTxn(txn)) throw new Error('Only BANK ledger rows can be reordered.');

    const focusLine = ctx.byTxnId.get(txnId);
    if (!focusLine) {
        throw new Error('Reconcile this row to a statement line first — order is kept on the matched passbook entry.');
    }

    const date = lineDateKey(focusLine);
    if (!date) throw new Error('Statement line is missing a date.');

    const activeTxnIds = new Set(getActiveBankLedgerTxns().map((row) => row.id));
    const allDayLines = (fnFinances().bankStatementLines || [])
        .filter((line) => lineDateKey(line) === date);

    if (!allDayLines.length) {
        throw new Error(`No statement lines found for ${date}.`);
    }

    const dayLines = [...allDayLines].sort((a, b) => compareLineOrder(a, b, ctx.importById));
    const peers = dayLines.filter(
        (line) => line.transaction_id && activeTxnIds.has(line.transaction_id),
    );

    if (peers.length <= 1) {
        throw new Error('Need at least two reconciled BANK rows on this date to reorder.');
    }

    const idx = peers.findIndex((line) => line.id === focusLine.id);
    if (idx < 0) {
        throw new Error('Could not find this row among same-day reconciled entries.');
    }

    const stepCount = Math.max(1, parseInt(steps, 10) || 1);
    const targetIdx = Math.max(0, Math.min(peers.length - 1, idx + direction * stepCount));
    if (targetIdx === idx) {
        throw new Error(direction < 0 ? 'Already at the top for this date.' : 'Already at the bottom for this date.');
    }

    const reorderedPeers = [...peers];
    const [moved] = reorderedPeers.splice(idx, 1);
    reorderedPeers.splice(targetIdx, 0, moved);

    const peerLineIds = new Set(peers.map((line) => line.id));
    const linkedQueue = [...reorderedPeers];
    let qi = 0;
    const merged = dayLines.map((line) => {
        if (!peerLineIds.has(line.id)) return line;
        return linkedQueue[qi++];
    });

    if (qi !== linkedQueue.length) {
        throw new Error('Could not rebuild same-day order — peer rows were missing from the statement day.');
    }

    const updates = merged.map((line, index) => ({
        id: line.id,
        line_order: index,
        order_source: ORDER_SOURCE.MANUAL,
    }));

    await reorderBankStatementLines(updates, { recalculate });
    return { txnId, date, peerIds: reorderedPeers.map((line) => line.transaction_id) };
}

export function getLedgerCalculatedHeaderHint(visibleColumns) {
    const opening = getBankOpeningConfig();
    return visibleColumns?.passbookBalance && opening.amount == null
        ? ' title="Set opening balance via the Opening control above"'
        : '';
}
