/**
 * Slim book-balance KPI pack — no ledger / bank-recon / docs imports.
 * Expense plan and other KPI-only pages should import from here, not financeAnalytics.js.
 */
import { getFinanceNew } from './state.js';

/** @type {{ bookBalance?: object, recon?: object }|null} */
let pack = null;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const emptyPending = () => ({
    openBills: [],
    uncleared: [],
    openAmt: 0,
    unclearedAmt: 0,
    openCount: 0,
    unclearedCount: 0,
    total: 0,
    count: 0,
});

/**
 * Hydrate book-balance KPIs from GET /api/finance/reports/bookBalance
 * (or the bookBalance slice of the analytics report).
 */
export function applyBookBalancePack(next = {}) {
    if (!next?.bookBalance) return;
    pack = {
        bookBalance: next.bookBalance,
        recon: next.recon || pack?.recon || {},
    };
    const s = getFinanceNew();
    s.bookBalancePack = pack;
}

export function hasBookBalancePack() {
    return !!pack?.bookBalance;
}

export function getBookBalancePack() {
    return pack;
}

export function clearBookBalancePack() {
    pack = null;
}

/** Book balance = bank + Wallet Left − pending (server snapshot). */
export function getBookBalanceSummary() {
    const bb = pack?.bookBalance;
    if (!bb) {
        return {
            cash: 0,
            bankBalance: null,
            hasBank: false,
            pending: emptyPending(),
            book: 0,
            asOf: null,
            recon: {
                diff: null,
                passbook: { balance: null, asOf: null },
                calculated: { balance: null, asOf: null },
            },
        };
    }

    const bankBalance = bb.bankBalance != null ? Number(bb.bankBalance) : null;
    const hasBank = bankBalance != null && (bb.hasBank !== false);
    const cash = Number(bb.cash) || 0;
    const pendingTotal = Number(bb.pending?.total) || 0;
    const book = hasBank ? round2(bankBalance + cash - pendingTotal) : round2(bb.book != null ? bb.book : cash);
    const packRecon = pack?.recon || {};
    const passbookBalance = packRecon.passbook?.balance ?? null;
    const asOf = bb.asOf || null;
    const reconDiff = hasBank && passbookBalance != null
        ? round2(bankBalance - passbookBalance)
        : null;

    return {
        cash,
        bankBalance,
        hasBank,
        pending: {
            openBills: [],
            uncleared: [],
            openAmt: Number(bb.pending?.openAmt) || 0,
            unclearedAmt: Number(bb.pending?.unclearedAmt) || 0,
            openCount: Number(bb.pending?.openCount) || 0,
            unclearedCount: Number(bb.pending?.unclearedCount) || 0,
            total: pendingTotal,
            count: Number(bb.pending?.count) || 0,
        },
        book,
        asOf,
        recon: {
            diff: reconDiff,
            passbook: { balance: passbookBalance, asOf: packRecon.passbook?.asOf || asOf },
            calculated: { balance: bankBalance, asOf },
        },
    };
}
