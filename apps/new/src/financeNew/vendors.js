/**
 * Curated Vendors directory (finance_config.vendors) helpers.
 * Used by Add bill / Quick capture — type or pick; new names are upserted.
 */
import { titleCaseVendor } from '../vendorFormat.js';
import { fnFinances } from './classicState.js';
import { mongoUpsert } from './mongoWrite.js';

export function listDirectoryVendors() {
    return [...new Set(
        (fnFinances().vendors || [])
            .map((row) => String(row?.name || '').trim())
            .filter(Boolean),
    )].sort((a, b) => a.localeCompare(b));
}

export function findDirectoryVendor(name) {
    const needle = titleCaseVendor(name).toLowerCase();
    if (!needle) return null;
    return (fnFinances().vendors || []).find(
        (row) => String(row?.name || '').trim().toLowerCase() === needle,
    ) || null;
}

/**
 * Upsert a vendor into the Vendors page list. Returns Title Case name or null.
 */
export async function ensureVendorInDirectory(apartmentId, name) {
    if (!apartmentId || !name) return null;
    const normalized = titleCaseVendor(name);
    if (!normalized) return null;
    const existing = findDirectoryVendor(normalized);
    const payload = {
        id: existing?.id || crypto.randomUUID(),
        apartment_id: apartmentId,
        name: normalized,
        contact_phone: existing?.contact_phone || null,
        contact_email: existing?.contact_email || null,
        notes: existing?.notes || null,
        use_count: (existing?.use_count || 0) + 1,
        last_used_at: new Date().toISOString(),
    };
    try {
        await mongoUpsert('expense_vendors', payload, { rehydrate: false });
        const list = fnFinances().vendors || (fnFinances().vendors = []);
        const idx = list.findIndex((v) => String(v.id) === String(payload.id)
            || String(v.name || '').toLowerCase() === normalized.toLowerCase());
        if (idx >= 0) list[idx] = { ...list[idx], ...payload };
        else list.unshift(payload);
        // Keep financeNew.config in sync when present
        if (fnFinances() && typeof window !== 'undefined') {
            try {
                const { portalState } = await import('../store.js');
                if (portalState.financeNew?.config) {
                    portalState.financeNew.config.vendors = list;
                }
            } catch {
                /* ignore */
            }
        }
        return normalized;
    } catch (err) {
        console.warn('Could not save vendor to directory:', err?.message || err);
        return normalized;
    }
}
