/**
 * Explicit Mongo writes for Finance-New — REST /api/finance/tables/:table
 */
import { postFinanceMongoMutation } from './api.js';
import { applyMongoPacksToClassic } from './classicState.js';
import { reloadFinancePacks } from './load.js';

const TABLE_PACKS = {
    ledger_entries: ['ledger'],
    vouchers: ['vouchers', 'voucherAggregates'],
    bank_imports: ['bank'],
    dues_invoices: ['billing'],
    billing_groups: ['billing'],
    billing_batches: ['billing'],
    nobroker_invoices: ['nobroker'],
    nobroker_invoices_raised: ['nobroker'],
    finance_config: ['boot'],
};

export async function mongoTableWrite({ table, op, rows, row, filter, patch, rehydrate = true } = {}) {
    if (!table || !op) throw new Error('mongoTableWrite requires table and op.');
    const result = await postFinanceMongoMutation('tableWrite', {
        table,
        op,
        rows: rows != null ? rows : (row != null ? [row] : []),
        row,
        filter: filter || {},
        patch,
    });
    if (result?.config) applyMongoPacksToClassic({ config: result.config });
    if (rehydrate) {
        const packs = TABLE_PACKS[table] || ['boot'];
        // tableWrite mutation already reloads a broad set; skip duplicate if packs overlap
        await reloadFinancePacks(packs, { force: true });
    }
    return result;
}

export async function mongoInsert(table, rows, opts = {}) {
    const list = Array.isArray(rows) ? rows : [rows];
    return mongoTableWrite({ table, op: 'insert', rows: list, ...opts });
}

export async function mongoUpsert(table, rows, opts = {}) {
    const list = Array.isArray(rows) ? rows : [rows];
    return mongoTableWrite({ table, op: 'upsert', rows: list, ...opts });
}

export async function mongoUpdate(table, filter, patch, opts = {}) {
    return mongoTableWrite({ table, op: 'update', filter, patch, ...opts });
}

export async function mongoDelete(table, filter, opts = {}) {
    return mongoTableWrite({ table, op: 'delete', filter, ...opts });
}
