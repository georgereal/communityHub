/**
 * Finance Mongo indexes — for migrate / remodel scripts only.
 * Do not call from request handlers (DDL on page load is slow and can 500 on name conflicts).
 */
function isBenignIndexConflict(err) {
    const code = err?.code;
    if (code === 85 || code === 86) return true;
    const msg = String(err?.message || err || '');
    return /already exists with a different name/i.test(msg)
        || /index already exists/i.test(msg);
}

async function createIndexesSafe(collection, specs) {
    for (const spec of specs) {
        const { key, ...options } = spec;
        try {
            await collection.createIndex(key, options);
        } catch (err) {
            if (isBenignIndexConflict(err)) continue;
            throw err;
        }
    }
}

/** Specs used by paginated ledger list / filters. */
export const FINANCE_LEDGER_INDEXES = [
    { key: { apartment_id: 1, date: -1, created_at: -1 }, name: 'idx_ledger_apt_date_created' },
    { key: { apartment_id: 1, wallet: 1, date: -1 }, name: 'idx_ledger_apt_wallet_date' },
    { key: { apartment_id: 1, type: 1, date: -1 }, name: 'idx_ledger_apt_type_date' },
    { key: { apartment_id: 1, id: 1 }, name: 'idx_ledger_apt_id' },
    { key: { apartment_id: 1, cat: 1, date: -1 }, name: 'idx_ledger_apt_cat_date' },
];

export const FINANCE_BANK_IMPORT_INDEXES = [
    { key: { apartment_id: 1, created_at: -1 }, name: 'idx_bank_imports_apt_created' },
];

export const FINANCE_VOUCHER_INDEXES = [
    { key: { apartment_id: 1, doc_date: -1, created_at: -1 }, name: 'idx_vouchers_apt_doc_created' },
];

/** One-shot ensure for scripts (e.g. remodel-finance-mongo). */
export async function ensureFinanceIndexes(db) {
    await Promise.all([
        createIndexesSafe(db.collection('ledger_entries'), FINANCE_LEDGER_INDEXES),
        createIndexesSafe(db.collection('bank_imports'), FINANCE_BANK_IMPORT_INDEXES),
        createIndexesSafe(db.collection('vouchers'), FINANCE_VOUCHER_INDEXES),
    ]);
}
