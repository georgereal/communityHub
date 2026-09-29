/**
 * Per-subview Finance-New loaders — Mongo packs only, mapped into classic shape.
 * Never loads collections a screen does not need.
 */
import { portalState } from '../store.js';
import {
    ensureFinanceNewBoot,
    financeNewFetch,
    loadFinanceNewBankImports,
    loadFinanceNewBilling,
    loadFinanceNewBookBalance,
    loadFinanceNewLedger,
    loadFinanceNewVoucherAggregates,
    loadFinanceNewVouchers,
} from './api.js';
import { applyMongoPacksToClassic, ensureFnClassicShape } from './classicState.js';
import { getFinanceNew } from './state.js';
import { invalidateCachedReports, persistFinancePackCache } from './packCache.js';

const aptId = () => portalState.access?.activeApartmentId || null;

/** Ensure boot config is mapped into classic finances (vendors, plans, bank account, …). */
export async function ensureBootMapped({ force = false } = {}) {
    await ensureFinanceNewBoot({ force });
    const s = getFinanceNew();
    applyMongoPacksToClassic({ config: s.config, counts: s.counts });
    return s;
}

async function loadLedgerMapped({ force = false, append = false, offset = 0, limit = 50, query = {} } = {}) {
    const { buildLedgerServerQuery } = await import('./ledgerServerQuery.js');
    // Append must keep the query that produced the current window (ignore mid-scroll DOM edits).
    const filterQuery = append
        ? { ...(getFinanceNew().ledgerQuery || {}), ...query }
        : { ...buildLedgerServerQuery(), ...query };
    await loadFinanceNewLedger({ force, append, offset, limit, query: filterQuery });
    applyMongoPacksToClassic({
        ledgerEntries: getFinanceNew().ledgerEntries,
        appendLedger: append,
    });
}

async function loadBankMapped({ force = false } = {}) {
    await loadFinanceNewBankImports({ force });
    applyMongoPacksToClassic({ bankImports: getFinanceNew().bankImports });
}

async function loadBillingMapped({ force = false } = {}) {
    await loadFinanceNewBilling({ force });
    const s = getFinanceNew();
    applyMongoPacksToClassic({
        duesInvoices: s.duesInvoices,
        billingGroups: s.billingGroups,
        billingBatches: s.billingBatches,
    });
}

async function loadNobrokerMapped({ force = false, limit = 500 } = {}) {
    const s = getFinanceNew();
    if (!force && s.nobrokerLoaded && s.bootApartmentId === aptId()) return s;
    const pageSize = Math.min(Math.max(Number(limit) || 500, 1), 500);
    let offset = 0;
    let total = Infinity;
    const rows = [];
    while (offset < total) {
        const json = await financeNewFetch('/api/finance/nobroker', {
            query: { limit: pageSize, offset },
        });
        const batch = Array.isArray(json.rows) ? json.rows : [];
        total = Number(json.total) || (offset + batch.length);
        rows.push(...batch);
        if (!batch.length) break;
        offset += batch.length;
        if (offset >= total) break;
    }
    s.nobrokerInvoices = rows;
    s.nobrokerTotal = Number.isFinite(total) ? total : rows.length;
    s.nobrokerLoaded = true;
    applyMongoPacksToClassic({ nobrokerInvoices: s.nobrokerInvoices });
    persistFinancePackCache();
    return s;
}

async function loadVouchersPageMapped(opts = {}) {
    const json = await loadFinanceNewVouchers({ force: opts.force, ...opts });
    applyMongoPacksToClassic({
        vouchers: getFinanceNew().vouchers,
        vouchersTotal: getFinanceNew().vouchersTotal,
    });
    return json;
}

/**
 * Reload one or more packs after a mutation.
 * @param {Array<'boot'|'ledger'|'bank'|'billing'|'nobroker'|'vouchers'|'voucherAggregates'|'bookBalance'>} packs
 */
export async function reloadFinancePacks(packs = [], { force = true } = {}) {
    const set = new Set(packs);
    if (force && [...set].some((p) => p !== 'billing')) {
        invalidateCachedReports();
    }
    await ensureBootMapped({ force: set.has('boot') ? force : false });

    const jobs = [];
    if (set.has('ledger')) jobs.push(loadLedgerMapped({ force }));
    if (set.has('bank')) jobs.push(loadBankMapped({ force }));
    if (set.has('billing')) jobs.push(loadBillingMapped({ force }));
    if (set.has('nobroker')) jobs.push(loadNobrokerMapped({ force }));
    if (set.has('vouchers')) jobs.push(loadVouchersPageMapped({ limit: 50, offset: 0, force }));
    if (set.has('voucherAggregates')) jobs.push(loadFinanceNewVoucherAggregates({ force }));
    if (set.has('bookBalance')) jobs.push(loadFinanceNewBookBalance({ force }));
    if (jobs.length) await Promise.all(jobs);
    return getFinanceNew();
}

/** Reports — boot + analytics report only (no full collection dumps). */
export async function loadAccountsReports({ force = false } = {}) {
    ensureFnClassicShape();
    await ensureBootMapped({ force });
    return getFinanceNew();
}

/** Cash ledger — first page + bank imports. More pages via infinite scroll. */
export async function loadAccountsLedger({ force = false } = {}) {
    ensureFnClassicShape();
    await ensureBootMapped({ force });
    await Promise.all([
        loadLedgerMapped({ force, offset: 0, limit: 50 }),
        loadBankMapped({ force }),
    ]);
    return getFinanceNew();
}

/** Append next ledger page (infinite scroll). */
export async function loadMoreLedgerPage() {
    const s = getFinanceNew();
    if (!s.ledgerHasMore || s.ledgerLoadingMore) return s;
    const nextOffset = (Number(s.ledgerOffset) || 0) + (Number(s.ledgerLimit) || 50);
    await loadLedgerMapped({
        force: true,
        append: true,
        offset: nextOffset,
        limit: s.ledgerLimit || 50,
        query: s.ledgerQuery || {},
    });
    return getFinanceNew();
}

/** Reset ledger list with current UI filters (search / pivot / cat). */
export async function reloadLedgerFiltered({ force = true } = {}) {
    ensureFnClassicShape();
    await loadLedgerMapped({ force, offset: 0, limit: 50 });
    return getFinanceNew();
}

/** Bills & receipts — vouchers + ledger (Petty Cash buckets / link candidates). */
export async function loadAccountsFinanceDocs({ force = false } = {}) {
    ensureFnClassicShape();
    await ensureBootMapped({ force });
    await Promise.all([
        loadVouchersPageMapped({ limit: 50, offset: 0, force }),
        loadFinanceNewVoucherAggregates({ force }),
        loadLedgerMapped({ force }),
    ]);
    return getFinanceNew();
}

/** Expense plan — boot (plan items) + slim book-balance KPIs only. */
export async function loadAccountsExpensePlan({ force = false } = {}) {
    ensureFnClassicShape();
    await ensureBootMapped({ force });
    await loadFinanceNewBookBalance({ force });
    return getFinanceNew();
}

/** NoBroker raised invoices. */
export async function loadAccountsInvoicesRaised({ force = false } = {}) {
    ensureFnClassicShape();
    await ensureBootMapped({ force });
    await loadNobrokerMapped({ force });
    return getFinanceNew();
}

/** Bank reconciliation — imports + unmatched BANK pack + summary KPIs (no full ledger dump). */
export async function loadAccountsBankRecon({ force = false } = {}) {
    ensureFnClassicShape();
    await ensureBootMapped({ force });
    const { loadFinanceNewUnmatchedBank, loadFinanceNewLedgerSummary } = await import('./api.js');
    await Promise.all([
        loadBankMapped({ force }),
        loadFinanceNewUnmatchedBank({ force }),
        loadFinanceNewLedgerSummary({ force }),
    ]);
    return getFinanceNew();
}

/** Merge same-calendar-day ledger peers into classic txns (reorder across page boundaries). */
export async function ensureLedgerDayPeers(date) {
    const day = String(date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
    const { loadFinanceNewLedgerDay } = await import('./api.js');
    const entries = await loadFinanceNewLedgerDay(day);
    if (!entries.length) return entries;
    applyMongoPacksToClassic({ ledgerEntries: entries, appendLedger: true });
    const s = getFinanceNew();
    const seen = new Set((s.ledgerEntries || []).map((e) => String(e.id || e._id)));
    for (const e of entries) {
        const id = String(e.id || e._id || '');
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        s.ledgerEntries = [...(s.ledgerEntries || []), e];
    }
    return entries;
}

/** Maintenance invoices shell — billing packs (+ ledger for collections). */
export async function loadInvoicesShell({ force = false, withLedger = false } = {}) {
    ensureFnClassicShape();
    await ensureBootMapped({ force });
    const jobs = [loadBillingMapped({ force })];
    if (withLedger) jobs.push(loadLedgerMapped({ force }));
    await Promise.all(jobs);
    return getFinanceNew();
}

const ACCOUNTS_LOADERS = {
    reports: loadAccountsReports,
    ledger: loadAccountsLedger,
    'finance-docs': loadAccountsFinanceDocs,
    'expense-plan': loadAccountsExpensePlan,
    'invoices-raised': loadAccountsInvoicesRaised,
    'bank-recon': loadAccountsBankRecon,
};

export async function loadAccountsSubview(subview, { force = false } = {}) {
    const key = subview === 'cash-float' ? 'finance-docs' : (subview || 'ledger');
    const loader = ACCOUNTS_LOADERS[key] || loadAccountsLedger;
    return loader({ force });
}
