/**
 * Ledger MPA API — cookie auth + finance ctx (no Supabase / finances.js).
 */
import { readFinanceCtx } from '../session.js';
import { readApiJson } from '../../apiJson.js';

function apartmentId() {
    const id = readFinanceCtx()?.apartmentId;
    if (!id) throw new Error('No active apartment selected.');
    return id;
}

async function financeFetch(path, { method = 'GET', body, query = {} } = {}) {
    const apartment_id = apartmentId();
    const u = new URL(path, window.location.origin);
    u.searchParams.set('apartment_id', apartment_id);
    for (const [k, v] of Object.entries(query)) {
        if (v == null || v === '') continue;
        u.searchParams.set(k, String(v));
    }
    const init = {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
    };
    if (body != null && method !== 'GET' && method !== 'HEAD') {
        init.body = JSON.stringify({ apartment_id, ...body });
    }
    const res = await fetch(`${u.pathname}${u.search}`, init);
    const { ok, json, error } = await readApiJson(res);
    if (!ok) throw new Error(json?.error || error || 'Finance request failed.');
    return json;
}

/**
 * @returns {Promise<{ summary: object|null, entries: object[], config: object|null }>}
 */
export async function loadLedgerPageData() {
    const [bootJson, summaryJson, ledgerJson] = await Promise.all([
        financeFetch('/api/finance/boot'),
        financeFetch('/api/finance/ledger/summary'),
        financeFetch('/api/finance/ledger'),
    ]);
    return {
        summary: summaryJson.summary || null,
        entries: Array.isArray(ledgerJson.entries) ? ledgerJson.entries : [],
        config: bootJson.config || null,
    };
}

export async function saveLedgerEntry(transaction) {
    return financeFetch('/api/finance/ledger', {
        method: 'POST',
        body: { transaction },
    });
}

export async function deleteLedgerEntry(id) {
    return financeFetch(`/api/finance/ledger/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        body: { transaction_id: id },
    });
}

export async function deleteLedgerEntries(ids) {
    return financeFetch('/api/finance/ledger/bulk-delete', {
        method: 'POST',
        body: { transaction_ids: ids },
    });
}

export async function bulkUpdateLedgerEntries(updates) {
    return financeFetch('/api/finance/ledger/bulk-update', {
        method: 'POST',
        body: { updates },
    });
}

export async function saveBankOpeningBalance({ date, amount }) {
    return financeFetch('/api/finance/bank/opening-balance', {
        method: 'POST',
        body: { date, amount },
    });
}

export async function recalculateLedgerBalances({ full = false } = {}) {
    return financeFetch('/api/finance/ledger/recalculate', {
        method: 'POST',
        body: { full: !!full },
    });
}
