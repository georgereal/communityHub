/**
 * Reports-only loader — boot config only (analytics pack fetched by financeAnalytics).
 * Avoids importing ledger/bank/billing loaders from load.js.
 */
import { ensureFinanceNewBoot } from './api.js';
import { applyMongoPacksToClassic, ensureFnClassicShape } from './classicState.js';
import { getFinanceNew } from './state.js';

export async function loadAccountsReports({ force = false } = {}) {
    ensureFnClassicShape();
    await ensureFinanceNewBoot({ force });
    const s = getFinanceNew();
    applyMongoPacksToClassic({ config: s.config, counts: s.counts });
    if (s.voucherAggregates?.summary) {
        try {
            const { hydrateFinanceDocsAggregatesFromApi } = await import('./financeDocuments.js');
            hydrateFinanceDocsAggregatesFromApi(s.voucherAggregates, s.bootApartmentId);
        } catch { /* reports still render without float worksheet */ }
    }
    return s;
}
