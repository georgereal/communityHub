/**
 * Ledger bank balance — opening + BANK ledger movements (active rows only).
 * Table "Calculated" follows the visible/sorted row order: prev ± this row.
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

/** Calendar day YYYY-MM-DD — prefer matched statement line_date when linked. */
export const ledgerTxnDayKey = (txn, ctx = null) => {
    const statementCtx = ctx || buildLedgerStatementContext();
    const line = statementCtx.byTxnId?.get(txn?.id);
    if (line?.line_date) {
        const match = String(line.line_date).match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (match) return `${match[1]}-${match[2]}-${match[3]}`;
    }
    const raw = String(txn?.date || '');
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : raw.slice(0, 10);
};

const chronologicalBankTxns = (txns) => {
    const ctx = buildLedgerStatementContext();
    return bankWalletTxns(txns).sort((a, b) => {
        const byDay = ledgerTxnDayKey(a, ctx).localeCompare(ledgerTxnDayKey(b, ctx));
        if (byDay) return byDay;
        return compareLedgerTxnStatementOrder(a, b, ctx);
    });
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
 * Running balance walking `orderedTxns` top → bottom (table order).
 * Each BANK row: previous calculated ± this row's amount. Non-BANK rows skipped.
 */
export function annotateLedgerRunningBalancesInOrder(orderedTxns = []) {
    const opening = getBankOpeningConfig();
    const byId = new Map();
    const pool = Array.isArray(orderedTxns) ? orderedTxns : [];

    if (opening.amount == null || Number.isNaN(parseFloat(opening.amount))) {
        return { byId, closing: null, needsOpening: true, opening, txnCount: 0 };
    }

    let running = parseFloat(opening.amount);
    let bankCount = 0;
    const ctx = buildLedgerStatementContext();

    for (const t of pool) {
        if ((t?.wallet || '').toUpperCase() !== 'BANK') continue;
        const day = ledgerTxnDayKey(t, ctx);
        if (opening.date && day && day < String(opening.date).slice(0, 10)) continue;
        running += txnMovement(t);
        byId.set(t.id, running);
        bankCount += 1;
    }

    return {
        byId,
        closing: running,
        needsOpening: false,
        opening,
        txnCount: bankCount,
    };
}

/**
 * Recompute running balances from `fromDate` onward (inclusive).
 * Pass `seedById` from a prior full run to keep earlier rows unchanged.
 */
export function annotateLedgerRunningBalancesFromDate(txns, fromDate, seedById = null) {
    const opening = getBankOpeningConfig();
    const pool = chronologicalBankTxns(getActiveLedgerTxns(txns));
    const byId = seedById ? new Map(seedById) : new Map();
    const cutoff = String(fromDate || '');
    const ctx = buildLedgerStatementContext();

    if (opening.amount == null || Number.isNaN(parseFloat(opening.amount))) {
        return { byId, closing: null, needsOpening: true, opening, txnCount: pool.length };
    }

    let running = parseFloat(opening.amount);
    for (const t of pool) {
        const day = ledgerTxnDayKey(t, ctx);
        if (opening.date && day < String(opening.date).slice(0, 10)) continue;
        running += txnMovement(t);
        if (!cutoff || day >= cutoff) {
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
 * Running calculated balance after each active BANK ledger row (statement / day order).
 * Prefer annotateLedgerRunningBalancesInOrder for the ledger table itself.
 */
export function annotateLedgerRunningBalances(txns = null) {
    const opening = getBankOpeningConfig();
    const pool = chronologicalBankTxns(getActiveLedgerTxns(txns));
    return annotateLedgerRunningBalancesInOrder(pool);
}

/**
 * Bank balance implied by the active financial ledger (BANK wallet entries).
 */
export function getLedgerBankBalance(txns = null) {
    const annotated = annotateLedgerRunningBalances(txns);
    const opening = annotated.opening;
    const pool = chronologicalBankTxns(getActiveLedgerTxns(txns));
    const ctx = buildLedgerStatementContext();
    const onOrAfterOpening = opening.date
        ? pool.filter((t) => ledgerTxnDayKey(t, ctx) >= String(opening.date).slice(0, 10))
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
