/** Finance-New clone (ledgerTxnLocal.js) */
import { fnFinances, fnLedger, ensureFnClassicShape } from './classicState.js';
/**
 * Apply finance transaction mutations to portalState without a full pullState().
 */
import { portalState } from '../store.js';

export function txnBalanceSnapshot(txn) {
    if (!txn) return null;
    return {
        amount: parseFloat(txn.amount) || 0,
        type: txn.type,
        wallet: (txn.wallet || '').toUpperCase(),
        date: String(txn.date || '').slice(0, 10),
        excluded_from_ledger: !!txn.excluded_from_ledger,
    };
}

export function balanceSnapshotChanged(before, after) {
    if (!before || !after) return true;
    return Object.keys(before).some((k) => before[k] !== after[k]);
}

const touchVendorLocally = (name, apartmentId) => {
    if (!name) return;
    const vendors = fnFinances().vendors || (fnFinances().vendors = []);
    const now = new Date().toISOString();
    const existing = vendors.find((v) => v.name === name);
    if (existing) existing.last_used_at = now;
    else vendors.unshift({ apartment_id: apartmentId, name, last_used_at: now });
};

const touchSubCategoryLocally = (category, name, apartmentId) => {
    if (!category || !name) return;
    const rows = fnFinances().subCategories || (fnFinances().subCategories = []);
    const now = new Date().toISOString();
    const existing = rows.find((r) => r.category === category && r.name === name);
    if (existing) existing.last_used_at = now;
    else rows.unshift({ apartment_id: apartmentId, category, name, last_used_at: now });
};

export function applySavedTransactionLocally(transaction, { allocations = [] } = {}) {
    if (!transaction?.id) return;

    const txns = fnFinances().txns || (fnFinances().txns = []);
    const idx = txns.findIndex((t) => t.id === transaction.id);
    if (idx >= 0) txns[idx] = { ...txns[idx], ...transaction };
    else txns.unshift(transaction);

    if (transaction.cat === 'Maintenance Collection') {
        const apartmentId = transaction.apartment_id;
        const rest = (fnFinances().maintenanceAllocations || []).filter(
            (a) => a.transaction_id !== transaction.id,
        );
        const rows = allocations
            .filter((row) => parseFloat(row.amount || 0) > 0)
            .map((row) => ({
                id: row.id || crypto.randomUUID(),
                apartment_id: apartmentId,
                transaction_id: transaction.id,
                invoice_id: row.invoice_id,
                amount: parseFloat(row.amount),
            }));
        fnFinances().maintenanceAllocations = [...rest, ...rows];
    }

    touchVendorLocally(transaction.vendor_name, transaction.apartment_id);
    touchSubCategoryLocally(transaction.cat, transaction.sub_category, transaction.apartment_id);
}

export function removeTransactionLocally(txnId) {
    if (!txnId) return;
    fnFinances().txns = (fnFinances().txns || []).filter((t) => t.id !== txnId);
    fnFinances().maintenanceAllocations = (fnFinances().maintenanceAllocations || [])
        .filter((a) => a.transaction_id !== txnId);
}

export function removeTransactionsLocally(txnIds = []) {
    const ids = new Set((txnIds || []).filter(Boolean));
    if (!ids.size) return;
    fnFinances().txns = (fnFinances().txns || []).filter((t) => !ids.has(t.id));
    fnFinances().maintenanceAllocations = (fnFinances().maintenanceAllocations || [])
        .filter((a) => !ids.has(a.transaction_id));
    // Unlink matched statement lines (server also does this).
    (fnFinances().bankStatementLines || []).forEach((line) => {
        if (line.transaction_id && ids.has(line.transaction_id)) {
            line.match_status = 'UNMATCHED';
            line.transaction_id = null;
            line.matched_at = null;
            line.matched_by = null;
        }
    });
}
