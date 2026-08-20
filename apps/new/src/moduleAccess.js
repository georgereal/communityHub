/**
 * Module toggles for New UI — from Mongo boot / policy, not Postgres.
 */
import { portalState } from './store.js';
import { persistMongoPolicy } from './rbacMongoClient.js';

export const MODULE_CATALOG = [
    { key: 'home', label: 'Dashboard', description: 'Home overview and quick actions', icon: 'fa-gauge-high' },
    { key: 'property', label: 'Property', description: 'Units, parking, and residents', icon: 'fa-building' },
    { key: 'finance', label: 'Finance', description: 'Ledger, reports, and bank reconciliation', icon: 'fa-coins' },
    { key: 'admin', label: 'Administration', description: 'Society setup, people, and roles', icon: 'fa-gear' },
];

const MODULE_KEYS = new Set(MODULE_CATALOG.map((m) => m.key));

export const LOCKED_MODULE_KEYS = new Set(['admin']);

export function moduleBypassGating() {
    if (portalState.auth?.isSystemAdmin || portalState.auth?.effectiveRoleKey === 'system_admin') return true;
    const perms = portalState.authPermissions || [];
    if (perms.includes('rbac.edit')) return true;
    if (portalState.auth?.effectiveRoleKey === 'society_admin') return true;
    return false;
}

export function isModuleEnabled(moduleKey) {
    if (moduleKey === 'finance-new') return isModuleEnabled('finance');
    if (moduleKey === 'property-new' || moduleKey === 'old-ops') return isModuleEnabled('property');
    if (moduleKey === 'admin-new') return isModuleEnabled('admin');
    if (!MODULE_KEYS.has(moduleKey)) return true;
    if (LOCKED_MODULE_KEYS.has(moduleKey)) return true;
    if (moduleBypassGating()) return true;

    const apt = portalState.moduleAccess?.apartment || {};
    const user = portalState.moduleAccess?.user || {};
    const role = portalState.moduleAccess?.role || {};

    if (Object.prototype.hasOwnProperty.call(user, moduleKey)) return user[moduleKey];
    if (Object.prototype.hasOwnProperty.call(role, moduleKey)) return role[moduleKey];
    if (Object.prototype.hasOwnProperty.call(apt, moduleKey)) return apt[moduleKey];
    return true;
}

export async function fetchApartmentModuleSettings() {
    const roleKey = portalState.auth?.effectiveRoleKey;
    const roleMap = roleKey && portalState.moduleAccess?.role ? portalState.moduleAccess.role : {};
    const apt = portalState.moduleAccess?.apartment || {};
    return { ...apt, ...roleMap };
}

export async function saveApartmentModuleSettings(apartmentId, settings = {}) {
    if (!apartmentId) throw new Error('Apartment required.');
    const res = await fetch(`/api/rbac-mongo?apartment_id=${encodeURIComponent(apartmentId)}`, {
        credentials: 'include',
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Could not load policy.');
    const policy = json.policy || { pages: {}, modules: {}, crud: {} };
    const roleKey = portalState.auth?.effectiveRoleKey;
    const apartmentMap = MODULE_CATALOG.reduce((acc, { key }) => {
        acc[key] = LOCKED_MODULE_KEYS.has(key) ? true : settings[key] !== false;
        return acc;
    }, {});
    const modules = { ...(policy.modules || {}) };
    if (roleKey) modules[roleKey] = { ...(modules[roleKey] || {}), ...apartmentMap };
    await persistMongoPolicy({
        apartmentId,
        pages: policy.pages || {},
        modules,
        crud: policy.crud || {},
    });
    portalState.moduleAccess = portalState.moduleAccess || { apartment: {}, user: {}, role: {} };
    portalState.moduleAccess.apartment = apartmentMap;
    if (roleKey) portalState.moduleAccess.role = { ...(portalState.moduleAccess.role || {}), ...apartmentMap };
}

export async function loadModuleAccess() {
    return portalState.moduleAccess || { apartment: {}, user: {}, role: {} };
}
