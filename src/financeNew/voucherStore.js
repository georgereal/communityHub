/**
 * Apply Mongo voucher aggregates into classic financeDocuments store.
 */
import { fnFinances, ensureFnClassicShape } from './classicState.js';
import { applyFinanceNewVoucherAggregates, getFinanceNew } from './state.js';

export function mergeVoucherAggregatesIntoStore(json = {}) {
    ensureFnClassicShape();
    applyFinanceNewVoucherAggregates(json);
    const docs = Array.isArray(json.documents) ? json.documents : [];
    if (!fnFinances().financeDocuments) fnFinances().financeDocuments = [];
    const list = fnFinances().financeDocuments;
    for (const doc of docs) {
        if (!doc?.id) continue;
        const mapped = {
            ...doc,
            id: doc.id || doc._id,
            transaction_id: doc.transaction_id || doc.ledgerEntryId || null,
        };
        const idx = list.findIndex((d) => String(d.id) === String(mapped.id));
        if (idx >= 0) list[idx] = mapped;
        else list.push(mapped);
    }
    getFinanceNew().voucherAggregates = json;
    return json;
}
