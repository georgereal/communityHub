/**
 * Finance-New isolated client state (Mongo). Not shared with portalState.finances.
 */
import { portalState } from '../store.js';

export function emptyFinanceNewState() {
    return {
        booted: false,
        bootApartmentId: null,
        classicHydrated: false,
        config: null,
        counts: {},
        finances: null,
        ledger: null,
        admin: null,
        ledgerEntries: [],
        ledgerLoaded: false,
        ledgerSummary: null,
        vouchers: [],
        vouchersTotal: 0,
        vouchersOffset: 0,
        vouchersLimit: 50,
        voucherAggregates: null,
        vouchersLoaded: false,
        bankImports: [],
        bankLoaded: false,
        duesInvoices: [],
        billingGroups: [],
        billingBatches: [],
        billingLoaded: false,
        nobrokerInvoices: [],
        nobrokerTotal: 0,
        nobrokerLoaded: false,
        reportAnalytics: null,
        reportAnalyticsKey: null,
        lastError: null,
    };
}

export function getFinanceNew() {
    if (!portalState.financeNew) {
        portalState.financeNew = emptyFinanceNewState();
    }
    return portalState.financeNew;
}

export function resetFinanceNew() {
    portalState.financeNew = emptyFinanceNewState();
    return portalState.financeNew;
}

export function applyFinanceNewBoot(payload = {}) {
    const s = getFinanceNew();
    s.booted = true;
    s.bootApartmentId = portalState.access?.activeApartmentId || null;
    s.config = payload.config || null;
    s.counts = payload.counts || {};
    s.lastError = null;
    return s;
}

export function applyFinanceNewLedger(payload = {}) {
    const s = getFinanceNew();
    s.ledgerEntries = Array.isArray(payload.entries) ? payload.entries : [];
    s.ledgerLoaded = true;
    return s;
}

export function applyFinanceNewLedgerSummary(payload = {}) {
    const s = getFinanceNew();
    s.ledgerSummary = payload.summary || payload || null;
    return s;
}

export function applyFinanceNewVouchers(payload = {}) {
    const s = getFinanceNew();
    s.vouchers = Array.isArray(payload.rows) ? payload.rows : [];
    s.vouchersTotal = Number(payload.total) || 0;
    s.vouchersOffset = Number(payload.offset) || 0;
    s.vouchersLimit = Number(payload.limit) || 50;
    s.vouchersLoaded = true;
    return s;
}

export function applyFinanceNewVoucherAggregates(payload = {}) {
    const s = getFinanceNew();
    s.voucherAggregates = payload;
    return s;
}
