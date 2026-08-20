/**
 * Finance-New API client — REST against /api/finance/*.
 */
import { portalState } from '../store.js';
import { readApiJson } from '../apiJson.js';
import { bearerAuthHeaders } from '../runtime/authHeaders.js';
import {
    analyticsQueryKey,
    dropFinancePackCacheAndMemory,
    persistFinancePackCache,
} from './packCache.js';
import {
    applyFinanceNewBoot,
    applyFinanceNewLedger,
    applyFinanceNewLedgerSummary,
    applyFinanceNewVouchers,
    getFinanceNew,
} from './state.js';

async function authHeaders() {
    return bearerAuthHeaders();
}

export async function financeNewFetch(path, {
    method = 'GET',
    body,
    query = {},
} = {}) {
    const apartment_id = query.apartment_id || body?.apartment_id || portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');

    const u = new URL(path.startsWith('http') ? path : path, window.location.origin);
    u.searchParams.set('apartment_id', apartment_id);
    for (const [k, v] of Object.entries(query)) {
        if (k === 'apartment_id') continue;
        if (v == null || v === '') continue;
        u.searchParams.set(k, String(v));
    }

    const init = {
        method,
        headers: await authHeaders(),
        credentials: 'include',
    };
    if (body != null && method !== 'GET' && method !== 'HEAD') {
        init.body = JSON.stringify({ apartment_id, ...body });
    }

    const res = await fetch(`${u.pathname}${u.search}`, init);
    const { ok, json, error } = await readApiJson(res);
    if (!ok) throw new Error(json.error || error || 'Finance-New request failed.');
    return json;
}

/** @deprecated Prefer financeNewFetch REST paths. Kept for classicState transitional calls. */
export async function postFinanceMongo(action, payload = {}) {
    const apartment_id = payload.apartment_id || portalState.access?.activeApartmentId;
    const map = {
        boot: () => financeNewFetch('/api/finance/boot', { query: { apartment_id } }),
        loadLedger: () => financeNewFetch('/api/finance/ledger', { query: { apartment_id, ...payload } }),
        loadLedgerSummary: () => financeNewFetch('/api/finance/ledger/summary', { query: { apartment_id } }),
        listVouchers: () => financeNewFetch('/api/finance/vouchers', {
            query: {
                apartment_id,
                limit: payload.limit,
                offset: payload.offset,
                kind: payload.kind,
                status: payload.status,
                q: payload.q,
                pay: payload.pay,
            },
        }),
        voucherAggregates: () => financeNewFetch('/api/finance/vouchers/aggregates', { query: { apartment_id } }),
        loadBankImports: () => financeNewFetch('/api/finance/bank/imports', { query: { apartment_id } }),
        loadBilling: () => financeNewFetch('/api/finance/billing', { query: { apartment_id } }),
        listNobroker: () => financeNewFetch('/api/finance/nobroker', {
            query: { apartment_id, limit: payload.limit, offset: payload.offset },
        }),
    };
    const fn = map[action];
    if (!fn) throw new Error(`Unknown Finance-New read action: ${action}`);
    return fn();
}

export async function ensureFinanceNewBoot({ force = false } = {}) {
    const s = getFinanceNew();
    const apt = portalState.access?.activeApartmentId;
    if (!force && s.booted && s.bootApartmentId === apt) return s;
    if (s.bootApartmentId && s.bootApartmentId !== apt) dropFinancePackCacheAndMemory(s.bootApartmentId);
    const json = await financeNewFetch('/api/finance/boot');
    applyFinanceNewBoot(json);
    persistFinancePackCache();
    return getFinanceNew();
}

export async function loadFinanceNewLedger({ force = false } = {}) {
    await ensureFinanceNewBoot();
    const s = getFinanceNew();
    if (!force && s.ledgerLoaded) return s;
    const json = await financeNewFetch('/api/finance/ledger');
    applyFinanceNewLedger(json);
    persistFinancePackCache();
    return getFinanceNew();
}

export async function loadFinanceNewLedgerSummary({ force = false } = {}) {
    await ensureFinanceNewBoot();
    const s = getFinanceNew();
    if (!force && s.ledgerSummary) return s.ledgerSummary;
    const json = await financeNewFetch('/api/finance/ledger/summary');
    applyFinanceNewLedgerSummary(json);
    persistFinancePackCache();
    return s.ledgerSummary;
}

export async function loadFinanceNewVouchers(opts = {}) {
    await ensureFinanceNewBoot();
    const s = getFinanceNew();
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const kind = opts.kind || 'all';
    const status = opts.status || 'all';
    const q = opts.q || '';
    const pay = opts.pay || '';
    const defaultList = offset === 0 && kind === 'all' && status === 'all' && !q && !pay;
    if (!opts.force && defaultList && s.vouchersLoaded) {
        return {
            rows: s.vouchers,
            total: s.vouchersTotal,
            offset: s.vouchersOffset,
            limit: s.vouchersLimit,
        };
    }
    const json = await financeNewFetch('/api/finance/vouchers', {
        query: {
            limit,
            offset,
            kind,
            status,
            q,
            pay,
        },
    });
    applyFinanceNewVouchers(json);
    persistFinancePackCache();
    return json;
}

export async function loadFinanceNewVoucherAggregates({ force = false } = {}) {
    await ensureFinanceNewBoot();
    const s = getFinanceNew();
    if (!force && s.voucherAggregates?.summary) return s.voucherAggregates;
    const json = await financeNewFetch('/api/finance/vouchers/aggregates');
    const { mergeVoucherAggregatesIntoStore } = await import('./voucherStore.js');
    mergeVoucherAggregatesIntoStore(json);
    persistFinancePackCache();
    return json;
}

export async function loadFinanceNewBankImports({ force = false } = {}) {
    await ensureFinanceNewBoot();
    const s = getFinanceNew();
    if (!force && s.bankLoaded) return s;
    const json = await financeNewFetch('/api/finance/bank/imports');
    s.bankImports = Array.isArray(json.imports) ? json.imports : [];
    s.bankLoaded = true;
    persistFinancePackCache();
    return s;
}

export async function loadFinanceNewBilling({ force = false } = {}) {
    await ensureFinanceNewBoot();
    const s = getFinanceNew();
    if (!force && s.billingLoaded) return s;
    const json = await financeNewFetch('/api/finance/billing');
    s.duesInvoices = Array.isArray(json.duesInvoices) ? json.duesInvoices : [];
    s.billingGroups = Array.isArray(json.billingGroups) ? json.billingGroups : [];
    s.billingBatches = Array.isArray(json.billingBatches) ? json.billingBatches : [];
    s.billingLoaded = true;
    persistFinancePackCache();
    return s;
}

/** Map classic mutation action names → REST. */
export async function postFinanceMongoMutation(action, payload = {}) {
    const apartment_id = payload.apartment_id || portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');
    const p = { ...payload, apartment_id };

    const routes = {
        saveTransaction: () => financeNewFetch('/api/finance/ledger', { method: 'POST', body: p }),
        saveLedgerEntry: () => financeNewFetch('/api/finance/ledger', { method: 'POST', body: p }),
        deleteTransaction: () => financeNewFetch(`/api/finance/ledger/${p.transaction_id || p.id}`, { method: 'DELETE', body: p }),
        deleteLedgerEntry: () => financeNewFetch(`/api/finance/ledger/${p.transaction_id || p.id}`, { method: 'DELETE', body: p }),
        deleteTransactions: () => financeNewFetch('/api/finance/ledger/bulk-delete', { method: 'POST', body: p }),
        bulkUpdateTransactions: () => financeNewFetch('/api/finance/ledger/bulk-update', { method: 'POST', body: p }),
        setLedgerExclusion: () => financeNewFetch(`/api/finance/ledger/${p.transaction_id}/exclusion`, { method: 'POST', body: p }),
        returnLedgerTxnToStatement: () => financeNewFetch(`/api/finance/ledger/${p.transaction_id}/return-to-statement`, { method: 'POST', body: p }),

        saveFinanceDocument: () => financeNewFetch('/api/finance/vouchers', { method: 'POST', body: p }),
        saveVoucher: () => financeNewFetch('/api/finance/vouchers', { method: 'POST', body: p }),
        deleteFinanceDocument: () => financeNewFetch(`/api/finance/vouchers/${p.document_id || p.id}`, { method: 'DELETE', body: p }),
        deleteVoucher: () => financeNewFetch(`/api/finance/vouchers/${p.document_id || p.id}`, { method: 'DELETE', body: p }),
        importFinanceDocuments: () => financeNewFetch('/api/finance/vouchers/import', { method: 'POST', body: p }),
        linkFinanceDocuments: () => financeNewFetch('/api/finance/vouchers/link', { method: 'POST', body: p }),
        unlinkFinanceDocuments: () => financeNewFetch('/api/finance/vouchers/unlink', { method: 'POST', body: p }),
        syncFinanceDocumentCategories: () => financeNewFetch('/api/finance/vouchers/sync-categories', { method: 'POST', body: p }),

        setCashFloatFlag: () => financeNewFetch('/api/finance/cash-float/flag', { method: 'POST', body: p }),
        saveCashFloatOpening: () => financeNewFetch('/api/finance/cash-float/opening', { method: 'POST', body: p }),

        importBankStatement: () => financeNewFetch('/api/finance/bank/imports', { method: 'POST', body: p }),
        saveBankOpeningBalance: () => financeNewFetch('/api/finance/bank/opening-balance', { method: 'POST', body: p }),
        clearBankStatementData: () => financeNewFetch('/api/finance/bank/data', { method: 'DELETE', body: p }),
        reorderBankStatementLines: () => financeNewFetch('/api/finance/bank/lines/reorder', { method: 'POST', body: p }),
        recalculateBankStatementBalances: () => financeNewFetch('/api/finance/bank/lines/recalculate', { method: 'POST', body: p }),
        recalculateLedgerBalances: () => financeNewFetch('/api/finance/ledger/recalculate', { method: 'POST', body: p }),
        unmatchBankLines: () => financeNewFetch('/api/finance/bank/lines/unmatch', { method: 'POST', body: p }),
        deleteBankStatementLines: () => financeNewFetch('/api/finance/bank/lines', { method: 'DELETE', body: p }),
        createTxnsFromBankLines: () => financeNewFetch('/api/finance/bank/lines/create-txns', { method: 'POST', body: p }),
        matchBankLine: () => financeNewFetch(`/api/finance/bank/lines/${p.line_id}/match`, { method: 'POST', body: p }),
        unmatchBankLine: () => financeNewFetch(`/api/finance/bank/lines/${p.line_id}/unmatch`, { method: 'POST', body: p }),
        ignoreBankLine: () => financeNewFetch(`/api/finance/bank/lines/${p.line_id}/ignore`, { method: 'POST', body: p }),
        updateBankStatementLine: () => financeNewFetch(`/api/finance/bank/lines/${p.line_id}`, { method: 'PATCH', body: p }),
        createTxnFromBankLine: () => financeNewFetch(`/api/finance/bank/lines/${p.line_id}/create-txn`, { method: 'POST', body: p }),
        createLedgerFromBankLineAuto: () => financeNewFetch(`/api/finance/bank/lines/${p.line_id}/auto-ledger`, { method: 'POST', body: p }),

        listBankClassificationRules: () => financeNewFetch('/api/finance/bank/rules', { query: { apartment_id } }),
        saveBankClassificationRule: () => financeNewFetch('/api/finance/bank/rules', { method: 'POST', body: p }),
        deleteBankClassificationRule: () => financeNewFetch(`/api/finance/bank/rules/${p.id}`, { method: 'DELETE', body: p }),
        previewBankClassificationRules: () => financeNewFetch('/api/finance/bank/rules/preview', { method: 'POST', body: p }),

        saveExpensePlanItem: () => financeNewFetch('/api/finance/expense-plan/items', { method: 'POST', body: p }),
        deleteExpensePlanItem: () => financeNewFetch(`/api/finance/expense-plan/items/${p.id}`, { method: 'DELETE', body: p }),
        saveExpensePlanRecurring: () => financeNewFetch('/api/finance/expense-plan/recurring', { method: 'POST', body: p }),
        deleteExpensePlanRecurring: () => financeNewFetch(`/api/finance/expense-plan/recurring/${p.id}`, { method: 'DELETE', body: p }),

        patchFinanceConfig: () => financeNewFetch('/api/finance/config', { method: 'PATCH', body: p }),
        tableWrite: () => {
            const table = p.table;
            const op = p.op || 'insert';
            const method = op === 'upsert' ? 'PUT' : op === 'update' ? 'PATCH' : op === 'delete' ? 'DELETE' : 'POST';
            return financeNewFetch(`/api/finance/tables/${encodeURIComponent(table)}`, { method, body: p });
        },
    };

    const fn = routes[action];
    if (!fn) throw new Error(`Unknown Finance-New mutation: ${action}`);
    return fn();
}

export async function fetchFinanceNewReport(report, payload = {}) {
    const s = getFinanceNew();
    const key = `${report}:${analyticsQueryKey(payload)}`;
    if (!payload.force && s.reportAnalytics && s.reportAnalyticsKey === key) {
        return s.reportAnalytics;
    }
    const json = await financeNewFetch(`/api/finance/reports/${encodeURIComponent(report)}`, {
        query: {
            type: payload.type,
            months: payload.months ?? payload.monthCount,
            monthCount: payload.monthCount ?? payload.months,
            sheetOnly: payload.sheetOnly == null ? undefined : (payload.sheetOnly ? '1' : '0'),
            cashExpenseReporting: payload.cashExpenseReporting,
            pivotDimension: payload.pivotDimension,
        },
    });
    s.reportAnalytics = json;
    s.reportAnalyticsKey = key;
    persistFinancePackCache();
    return json;
}
