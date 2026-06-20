/**
 * Module enable/disable — apartment defaults + per-user overrides for non-admins.
 */
import { portalState, supabase } from './store.js';

/** Aligns with NAV_MODULES ids in navigation.js */
export const MODULE_CATALOG = [
    { key: 'home', label: 'Dashboard', description: 'Home overview and quick actions', icon: 'fa-gauge-high' },
    { key: 'portal', label: 'Resident Portal', description: 'Owner/resident self-service views', icon: 'fa-house-user' },
    { key: 'security', label: 'Security Gate', description: 'Visitor gate desk and passes', icon: 'fa-shield-halved' },
    { key: 'property', label: 'Property', description: 'Parking, residents, units, operations', icon: 'fa-building' },
    { key: 'finance', label: 'Finance', description: 'Ledger, billing, bank reconciliation', icon: 'fa-coins' },
    { key: 'admin', label: 'Administration', description: 'Society setup, sync, email outbox', icon: 'fa-gear' },
];

const MODULE_KEYS = new Set(MODULE_CATALOG.map((m) => m.key));

/** Modules that cannot be turned off (would lock out society configuration). */
export const LOCKED_MODULE_KEYS = new Set(['admin']);

/** Only apartment admins bypass module toggles (not property managers with setup.view). */
export function moduleBypassGating() {
    const perms = portalState.authPermissions || [];
    if (perms.includes('rbac.edit')) return true;
    if (portalState.auth?.effectiveRoleKey === 'apartment_admin') return true;
    if (portalState.auth?.role === 'admin') return true;
    return false;
}

function normalizeSettingsMap(rows = []) {
    const map = {};
    rows.forEach((row) => {
        if (MODULE_KEYS.has(row.module_key)) map[row.module_key] = row.enabled !== false;
    });
    return map;
}

/** Load apartment + current-user module maps into portalState. */
export async function loadModuleAccess(apartmentId, userId = null) {
    portalState.moduleAccess = portalState.moduleAccess || { apartment: {}, user: {} };
    if (!supabase || !apartmentId) {
        portalState.moduleAccess.apartment = {};
        portalState.moduleAccess.user = {};
        return portalState.moduleAccess;
    }

    const uid = userId || portalState.auth?.id;
    const queries = [
        supabase.from('apartment_module_settings').select('module_key, enabled').eq('apartment_id', apartmentId),
    ];
    if (uid) {
        queries.push(
            supabase.from('user_module_access').select('module_key, enabled').eq('apartment_id', apartmentId).eq('user_id', uid),
        );
    }

    const [aptRes, userRes] = await Promise.all(queries);

    if (aptRes.error && !/apartment_module_settings/i.test(aptRes.error.message)) {
        console.warn('[moduleAccess] apartment load failed:', aptRes.error.message);
    }
    if (userRes?.error && !/user_module_access/i.test(userRes.error.message)) {
        console.warn('[moduleAccess] user load failed:', userRes.error.message);
    }

    portalState.moduleAccess.apartment = aptRes.error ? {} : normalizeSettingsMap(aptRes.data);
    portalState.moduleAccess.user = userRes?.error ? {} : normalizeSettingsMap(userRes?.data);
    return portalState.moduleAccess;
}

export async function fetchApartmentModuleSettings(apartmentId) {
    if (!supabase || !apartmentId) return {};
    const { data, error } = await supabase
        .from('apartment_module_settings')
        .select('module_key, enabled')
        .eq('apartment_id', apartmentId);
    if (error) {
        if (/apartment_module_settings/i.test(error.message)) return {};
        throw new Error(error.message);
    }
    return normalizeSettingsMap(data);
}

export async function fetchUserModuleAccess(userId, apartmentId) {
    if (!supabase || !userId || !apartmentId) return {};
    const { data, error } = await supabase
        .from('user_module_access')
        .select('module_key, enabled')
        .eq('user_id', userId)
        .eq('apartment_id', apartmentId);
    if (error) {
        if (/user_module_access/i.test(error.message)) return {};
        throw new Error(error.message);
    }
    return normalizeSettingsMap(data);
}

/** Effective enabled state for signed-in user (admins / setup viewers always pass locked modules). */
export function isModuleEnabled(moduleKey) {
    if (!MODULE_KEYS.has(moduleKey)) return true;
    if (LOCKED_MODULE_KEYS.has(moduleKey)) return true;
    if (moduleBypassGating()) return true;

    const apt = portalState.moduleAccess?.apartment || {};
    const user = portalState.moduleAccess?.user || {};

    if (Object.prototype.hasOwnProperty.call(user, moduleKey)) return user[moduleKey];
    if (Object.prototype.hasOwnProperty.call(apt, moduleKey)) return apt[moduleKey];
    return true;
}

export async function saveApartmentModuleSettings(apartmentId, settings = {}) {
    if (!supabase || !apartmentId) throw new Error('Supabase and apartment required.');
    const rows = MODULE_CATALOG.map(({ key }) => ({
        apartment_id: apartmentId,
        module_key: key,
        enabled: LOCKED_MODULE_KEYS.has(key) ? true : settings[key] !== false,
        updated_at: new Date().toISOString(),
    }));

    const { error: delErr } = await supabase
        .from('apartment_module_settings')
        .delete()
        .eq('apartment_id', apartmentId);
    if (delErr && !/apartment_module_settings/i.test(delErr.message)) throw new Error(delErr.message);

    const { error } = await supabase.from('apartment_module_settings').insert(rows);
    if (error) throw new Error(error.message);

    portalState.moduleAccess = portalState.moduleAccess || { apartment: {}, user: {} };
    portalState.moduleAccess.apartment = normalizeSettingsMap(rows);
}

/**
 * Save user overrides for one or more apartments.
 * overrides: { moduleKey: true | false | null } — null removes override (inherit).
 */
export async function saveUserModuleAccess(userId, apartmentIds = [], overrides = {}) {
    if (!supabase || !userId) throw new Error('Supabase and user required.');
    const aptIds = apartmentIds.filter(Boolean);
    if (!aptIds.length) return;

    for (const apartmentId of aptIds) {
        const { error: delErr } = await supabase
            .from('user_module_access')
            .delete()
            .eq('user_id', userId)
            .eq('apartment_id', apartmentId);
        if (delErr && !/user_module_access/i.test(delErr.message)) throw new Error(delErr.message);

        const inserts = MODULE_CATALOG
            .filter(({ key }) => overrides[key] === true || overrides[key] === false)
            .map(({ key }) => ({
                user_id: userId,
                apartment_id: apartmentId,
                module_key: key,
                enabled: overrides[key] === true,
                updated_at: new Date().toISOString(),
            }));

        if (inserts.length) {
            const { error } = await supabase.from('user_module_access').insert(inserts);
            if (error) throw new Error(error.message);
        }
    }
}

export function readModuleToggleValues(container, prefix = 'module') {
    const values = {};
    MODULE_CATALOG.forEach(({ key }) => {
        const el = container.querySelector(`[data-${prefix}-key="${key}"]`);
        if (!el) return;
        if (el.type === 'checkbox') {
            values[key] = el.checked;
        } else if (el.tagName === 'SELECT') {
            const v = el.value;
            values[key] = v === 'inherit' ? null : v === 'on';
        }
    });
    return values;
}
