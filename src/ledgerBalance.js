/**
 * Ledger bank balance — opening + BANK ledger movements (active rows only).
 * Running balance uses statement order for reconciled same-day rows when linked.
 */
import { portalState } from './store.js';
import { getBankOpeningConfig } from './bankReconciliation.js';
import {
    buildLedgerStatementContext,
    compareLedgerTxnStatementOrder,
} from './ledgerStatementContext.js';

export const isActiveLedgerTxn = (t) => !t?.excluded_from_ledger;

export const getActiveLedgerTxns = (txns = null) =>
    (txns ?? portalState.finances.txns ?? []).filter(isActiveLedgerTxn);

export const getExcludedLedgerTxns = (txns = null) =>
    (txns ?? portalState.finances.txns ?? []).filter((t) => !!t?.excluded_from_ledger);

const bankWalletTxns = (txns) =>
    txns.filter((t) => (t.wallet || '').toUpperCase() === 'BANK');

const txnMovement = (t) => {
    const amt = parseFloat(t.amount) || 0;
    return t.type === 'IN' ? amt : -amt;
};

const chronologicalBankTxns = (txns) => {
    const ctx = buildLedgerStatementContext();
    return bankWalletTxns(txns).sort((a, b) => compareLedgerTxnStatementOrder(a, b, ctx));
};

/** Fields that change running bank balance when edited. */
export const LEDGER_BALANCE_FIELDS = new Set(['amount', 'type', 'wallet', 'date', 'excluded_from_ledger']);

export const patchAffectsLedgerBalance = (fields) =>
    Object.keys(fields || {}).some((k) => LEDGER_BALANCE_FIELDS.has(k));

export const dayAfterIso = (isoDate) => {
    if (!isoDate) return null;
    const d = new Date(`${String(isoDate).slice(0, 10)}T12:00:00`);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
};

/**
 * Recompute running balances from `fromDate` onward (inclusive).
 * Pass `seedById` from a prior full run to keep earlier rows unchanged.
 */
export function annotateLedgerRunningBalancesFromDate(txns, fromDate, seedById = null) {
    const opening = getBankOpeningConfig();
    const pool = chronologicalBankTxns(getActiveLedgerTxns(txns));
    const byId = seedById ? new Map(seedById) : new Map();
    const cutoff = String(fromDate || '');

    if (opening.amount == null || Number.isNaN(parseFloat(opening.amount))) {
        return { byId, closing: null, needsOpening: true, opening, txnCount: pool.length };
    }

    let running = parseFloat(opening.amount);
    for (const t of pool) {
        if (opening.date && String(t.date || '') < String(opening.date)) continue;
        running += txnMovement(t);
        if (!cutoff || String(t.date || '') >= cutoff) {
            byId.set(t.id, running);
        }
    }

    return {
        byId,
        closing: running,
        needsOpening: false,
        opening,
        txnCount: pool.length,
    };
}

/**
 * Running calculated balance after each active BANK ledger row.
 * @returns {{ byId: Map<string, number>, closing: number|null, needsOpening: boolean, opening: object }}
 */
export function annotateLedgerRunningBalances(txns = null) {
    const opening = getBankOpeningConfig();
    const pool = chronologicalBankTxns(getActiveLedgerTxns(txns));
    const byId = new Map();

    if (opening.amount == null || Number.isNaN(parseFloat(opening.amount))) {
        return { byId, closing: null, needsOpening: true, opening, txnCount: pool.length };
    }

    let running = parseFloat(opening.amount);
    for (const t of pool) {
        if (opening.date && String(t.date || '') < String(opening.date)) continue;
        running += txnMovement(t);
        byId.set(t.id, running);
    }

    return {
        byId,
        closing: running,
        needsOpening: false,
        opening,
        txnCount: pool.length,
    };
}

/**
 * Bank balance implied by the active financial ledger (BANK wallet entries).
 */
export function getLedgerBankBalance(txns = null) {
    const annotated = annotateLedgerRunningBalances(txns);
    const opening = annotated.opening;
    const pool = chronologicalBankTxns(getActiveLedgerTxns(txns));
    const onOrAfterOpening = opening.date
        ? pool.filter((t) => String(t.date || '') >= String(opening.date))
        : pool;
    const netMovements = onOrAfterOpening.reduce((sum, t) => sum + txnMovement(t), 0);

    if (annotated.needsOpening) {
        return {
            balance: null,
            netMovements,
            asOf: onOrAfterOpening.length
                ? onOrAfterOpening[onOrAfterOpening.length - 1].date
                : opening.date || null,
            txnCount: onOrAfterOpening.length,
            needsOpening: true,
        };
    }

    return {
        balance: annotated.closing,
        netMovements,
        asOf: onOrAfterOpening.length ? onOrAfterOpening[onOrAfterOpening.length - 1].date : opening.date || null,
        txnCount: onOrAfterOpening.length,
        needsOpening: false,
    };
}
