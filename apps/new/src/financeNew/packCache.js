/**
 * Session cache for Finance-New Mongo packs.
 * Survives MPA navigations in the same tab. Cleared on reload/hard refresh,
 * apartment switch, or after mutations (callers refetch with force then persist).
 */
import { applyMongoPacksToClassic, ensureFnClassicShape } from './classicState.js';
import { getFinanceNew, resetFinanceNew } from './state.js';

const SCHEMA = 1;
const PREFIX = 'ch_fn_packs_v1_';

function isReloadNavigation() {
    try {
        const nav = performance.getEntriesByType?.('navigation')?.[0];
        if (nav?.type) return nav.type === 'reload';
        return performance.navigation?.type === 1;
    } catch {
        return false;
    }
}

function storageKey(apartmentId) {
    return `${PREFIX}${apartmentId}`;
}

export function analyticsQueryKey(payload = {}) {
    return JSON.stringify({
        months: Number(payload.months ?? payload.monthCount ?? 6),
        sheetOnly: payload.sheetOnly !== false && payload.sheetOnly !== '0',
        cashExpenseReporting: payload.cashExpenseReporting || 'petty_bank',
        pivotDimension: payload.pivotDimension || 'cat',
    });
}

function snapshotFromState(s) {
    return {
        schema: SCHEMA,
        savedAt: Date.now(),
        bootApartmentId: s.bootApartmentId,
        booted: !!s.booted,
        config: s.config,
        counts: s.counts || {},
        ledgerEntries: s.ledgerLoaded ? s.ledgerEntries : null,
        ledgerLoaded: !!s.ledgerLoaded,
        ledgerSummary: s.ledgerSummary,
        vouchers: s.vouchersLoaded ? s.vouchers : null,
        vouchersTotal: s.vouchersTotal,
        vouchersOffset: s.vouchersOffset,
        vouchersLimit: s.vouchersLimit,
        vouchersLoaded: !!s.vouchersLoaded,
        voucherAggregates: s.voucherAggregates,
        bankImports: s.bankLoaded ? s.bankImports : null,
        bankLoaded: !!s.bankLoaded,
        duesInvoices: s.billingLoaded ? s.duesInvoices : null,
        billingGroups: s.billingLoaded ? s.billingGroups : null,
        billingBatches: s.billingLoaded ? s.billingBatches : null,
        billingLoaded: !!s.billingLoaded,
        nobrokerInvoices: s.nobrokerLoaded ? s.nobrokerInvoices : null,
        nobrokerTotal: s.nobrokerTotal,
        nobrokerLoaded: !!s.nobrokerLoaded,
        reportAnalytics: s.reportAnalytics,
        reportAnalyticsKey: s.reportAnalyticsKey || null,
    };
}

function applySnapshot(snap) {
    const s = getFinanceNew();
    s.booted = !!snap.booted;
    s.bootApartmentId = snap.bootApartmentId || null;
    s.config = snap.config || null;
    s.counts = snap.counts || {};
    if (snap.ledgerLoaded && Array.isArray(snap.ledgerEntries)) {
        s.ledgerEntries = snap.ledgerEntries;
        s.ledgerLoaded = true;
    }
    s.ledgerSummary = snap.ledgerSummary || null;
    if (snap.vouchersLoaded && Array.isArray(snap.vouchers)) {
        s.vouchers = snap.vouchers;
        s.vouchersTotal = Number(snap.vouchersTotal) || 0;
        s.vouchersOffset = Number(snap.vouchersOffset) || 0;
        s.vouchersLimit = Number(snap.vouchersLimit) || 50;
        s.vouchersLoaded = true;
    }
    s.voucherAggregates = snap.voucherAggregates || null;
    if (snap.bankLoaded && Array.isArray(snap.bankImports)) {
        s.bankImports = snap.bankImports;
        s.bankLoaded = true;
    }
    if (snap.billingLoaded) {
        s.duesInvoices = Array.isArray(snap.duesInvoices) ? snap.duesInvoices : [];
        s.billingGroups = Array.isArray(snap.billingGroups) ? snap.billingGroups : [];
        s.billingBatches = Array.isArray(snap.billingBatches) ? snap.billingBatches : [];
        s.billingLoaded = true;
    }
    if (snap.nobrokerLoaded && Array.isArray(snap.nobrokerInvoices)) {
        s.nobrokerInvoices = snap.nobrokerInvoices;
        s.nobrokerTotal = Number(snap.nobrokerTotal) || snap.nobrokerInvoices.length;
        s.nobrokerLoaded = true;
    }
    s.reportAnalytics = snap.reportAnalytics || null;
    s.reportAnalyticsKey = snap.reportAnalyticsKey || null;

    applyMongoPacksToClassic({
        config: s.config,
        counts: s.counts,
        ledgerEntries: s.ledgerLoaded ? s.ledgerEntries : undefined,
        vouchers: s.vouchersLoaded ? s.vouchers : undefined,
        vouchersTotal: s.vouchersLoaded ? s.vouchersTotal : undefined,
        bankImports: s.bankLoaded ? s.bankImports : undefined,
        duesInvoices: s.billingLoaded ? s.duesInvoices : undefined,
        billingGroups: s.billingLoaded ? s.billingGroups : undefined,
        billingBatches: s.billingLoaded ? s.billingBatches : undefined,
        nobrokerInvoices: s.nobrokerLoaded ? s.nobrokerInvoices : undefined,
    });
    return s;
}

export function clearFinancePackCache(apartmentId) {
    try {
        if (apartmentId) sessionStorage.removeItem(storageKey(apartmentId));
        else {
            const toRemove = [];
            for (let i = 0; i < sessionStorage.length; i += 1) {
                const k = sessionStorage.key(i);
                if (k?.startsWith(PREFIX)) toRemove.push(k);
            }
            toRemove.forEach((k) => sessionStorage.removeItem(k));
        }
    } catch { /* ignore */ }
}

export function invalidateCachedReports() {
    const s = getFinanceNew();
    s.reportAnalytics = null;
    s.reportAnalyticsKey = null;
}

let persistTimer = 0;

export function persistFinancePackCache() {
    if (persistTimer) cancelAnimationFrame(persistTimer);
    persistTimer = requestAnimationFrame(() => {
        persistTimer = 0;
        const s = getFinanceNew();
        const apt = s.bootApartmentId;
        if (!apt || !s.booted) return;
        const snap = snapshotFromState(s);
        const write = (payload) => {
            sessionStorage.setItem(storageKey(apt), JSON.stringify(payload));
        };
        try {
            write(snap);
        } catch {
            try {
                write({ ...snap, reportAnalytics: null, reportAnalyticsKey: null });
            } catch {
                try {
                    write({
                        ...snap,
                        reportAnalytics: null,
                        reportAnalyticsKey: null,
                        bankImports: null,
                        bankLoaded: false,
                    });
                } catch { /* quota */ }
            }
        }
    });
}

/**
 * Restore packs after auth boot. No-op if this document load is a refresh.
 */
export function initFinancePackCache(apartmentId) {
    ensureFnClassicShape();
    if (!apartmentId) return false;
    if (isReloadNavigation()) {
        clearFinancePackCache(apartmentId);
        return false;
    }
    try {
        const raw = sessionStorage.getItem(storageKey(apartmentId));
        if (!raw) return false;
        const snap = JSON.parse(raw);
        if (!snap || snap.schema !== SCHEMA || snap.bootApartmentId !== apartmentId) {
            clearFinancePackCache(apartmentId);
            return false;
        }
        applySnapshot(snap);
        return true;
    } catch {
        clearFinancePackCache(apartmentId);
        return false;
    }
}

export function dropFinancePackCacheAndMemory(apartmentId) {
    clearFinancePackCache(apartmentId);
    resetFinanceNew();
    ensureFnClassicShape();
}
