/**
 * Property-New API client — REST against /api/property/*.
 */
import { portalState } from '../store.js';
import { readApiJson } from '../apiJson.js';
import { bearerAuthHeaders } from '../runtime/authHeaders.js';

export async function propertyFetch(path, {
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
        headers: await bearerAuthHeaders(),
        credentials: 'include',
    };
    if (body != null && method !== 'GET' && method !== 'HEAD') {
        init.body = JSON.stringify({ apartment_id, ...body });
    }

    const res = await fetch(`${u.pathname}${u.search}`, init);
    const { ok, json, error } = await readApiJson(res);
    if (!ok) throw new Error(json.error || error || 'Property-New request failed.');
    return json;
}
