/**
 * Apply finance transaction mutations to portalState without a full pullState().
 */
import { portalState } from './store.js';

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
    const vendors = portalState.finances.vendors || (portalState.finances.vendors = []);
    const now = new Date().toISOString();
    const existing = vendors.find((v) => v.name === name);
    if (existing) existing.last_used_at = now;
    else vendors.unshift({ apartment_id: apartmentId, name, last_used_at: now });
};

const touchSubCategoryLocally = (category, name, apartmentId) => {
    if (!category || !name) return;
    const rows = portalState.finances.subCategories || (portalState.finances.subCategories = []);
    const now = new Date().toISOString();
    const existing = rows.find((r) => r.category === category && r.name === name);
    if (existing) existing.last_used_at = now;
    else rows.unshift({ apartment_id: apartmentId, category, name, last_used_at: now });
};

export function applySavedTransactionLocally(transaction, { allocations = [] } = {}) {
    if (!transaction?.id) return;

    const txns = portalState.finances.txns || (portalState.finances.txns = []);
    const idx = txns.findIndex((t) => t.id === transaction.id);
    if (idx >= 0) txns[idx] = { ...txns[idx], ...transaction };
    else txns.unshift(transaction);

    if (transaction.cat === 'Maintenance Collection') {
        const apartmentId = transaction.apartment_id;
        const rest = (portalState.finances.maintenanceAllocations || []).filter(
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
        portalState.finances.maintenanceAllocations = [...rest, ...rows];
    }

    touchVendorLocally(transaction.vendor_name, transaction.apartment_id);
    touchSubCategoryLocally(transaction.cat, transaction.sub_category, transaction.apartment_id);
}

export function removeTransactionLocally(txnId) {
    if (!txnId) return;
    portalState.finances.txns = (portalState.finances.txns || []).filter((t) => t.id !== txnId);
    portalState.finances.maintenanceAllocations = (portalState.finances.maintenanceAllocations || [])
        .filter((a) => a.transaction_id !== txnId);
}
