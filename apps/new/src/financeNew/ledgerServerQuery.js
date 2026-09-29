/**
 * Map ledger UI / pivot filter state → GET /api/finance/ledger query params.
 */
import { getLedgerCategoryFilter, getLedgerPivotFilter } from './ledgerFilter.js';

export function buildLedgerServerQuery(extra = {}) {
    const q = { ...extra };
    const cat = getLedgerCategoryFilter();
    if (cat) q.cat = cat;

    const search = (document.getElementById('fn-cash-search')?.value || '').trim();
    if (search) q.q = search;

    const pivot = getLedgerPivotFilter();
    if (pivot) {
        if (pivot.type) q.pivot_type = pivot.type;
        if (pivot.dimension) q.pivot_dimension = pivot.dimension;
        if (pivot.key) q.pivot_key = pivot.key;
        if (pivot.wallet) q.pivot_wallet = pivot.wallet;
        if (pivot.year != null) q.pivot_year = pivot.year;
        if (pivot.month != null) q.pivot_month = pivot.month;
        if (pivot.sourceScope) q.source_scope = pivot.sourceScope;
        if (pivot.transactionId) q.transaction_id = pivot.transactionId;
        if (pivot.rangeStart) {
            const d = pivot.rangeStart instanceof Date ? pivot.rangeStart : new Date(pivot.rangeStart);
            if (!Number.isNaN(d.getTime())) {
                q.date_from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            }
        }
        if (pivot.rangeEnd) {
            const d = pivot.rangeEnd instanceof Date ? pivot.rangeEnd : new Date(pivot.rangeEnd);
            if (!Number.isNaN(d.getTime())) {
                q.date_to = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            }
        }
    }
    return q;
}
