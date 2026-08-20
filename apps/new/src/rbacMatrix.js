/**
 * New-app RBAC matrix — Mongo policy document only.
 */
import { portalState } from './store.js';
import { ROLE_OPTIONS, SOCIETY_FULL_ADMIN_KEYS } from './rbac.js';
import { MODULE_CATALOG, LOCKED_MODULE_KEYS } from './moduleAccess.js';
import { persistMongoPolicy } from './rbacMongoClient.js';

export const MATRIX_ROLE_KEYS = ROLE_OPTIONS
    .map((r) => r.key)
    .filter((k) => k !== 'system_admin');

export const CRUD_RESOURCES = [
    { key: 'vehicle_registry', label: 'Vehicles & Parking', moduleId: 'property' },
    { key: 'apartment_mgmt', label: 'Property', moduleId: 'property' },
    { key: 'accounts', label: 'Finance & Accounts', moduleId: 'finance' },
    { key: 'setup', label: 'Society Setup', moduleId: 'admin' },
    { key: 'rbac', label: 'Roles & Access', moduleId: 'admin' },
];

export const CRUD_ACTIONS = [
    { key: 'create', col: 'can_create', short: 'C', label: 'Create' },
    { key: 'read', col: 'can_read', short: 'R', label: 'Read' },
    { key: 'update', col: 'can_update', short: 'U', label: 'Update' },
    { key: 'delete', col: 'can_delete', short: 'D', label: 'Delete' },
];

export function defaultCrudFromPermKeys(resourceKey, permKeys = []) {
    const set = new Set(permKeys || []);
    const view = set.has(`${resourceKey}.view`);
    const edit = set.has(`${resourceKey}.edit`);
    if (resourceKey === 'portal' || resourceKey === 'security') {
        return { create: view, read: view, update: view, delete: false };
    }
    return {
        create: edit,
        read: view || edit,
        update: edit,
        delete: false,
    };
}

export function permKeyToCrud(permKey) {
    if (!permKey || !String(permKey).includes('.')) return null;
    const [resource, action] = String(permKey).split('.');
    if (action === 'view') return { resource, action: 'read' };
    if (action === 'edit') return { resource, action: 'update' };
    if (action === 'bills_entry') return { resource: 'accounts', action: 'create' };
    return { resource, action: 'read' };
}

export function crudAllowsPerm(crudForRole, permKey) {
    const mapped = permKeyToCrud(permKey);
    if (!mapped) return false;
    const row = crudForRole?.[mapped.resource] || {};
    if (row[mapped.action]) return true;
    if (mapped.action === 'update' && (row.create || row.delete)) return true;
    return false;
}

export function pageAllowedByCrud(page, crudForRole) {
    if (crudAllowsPerm(crudForRole, page.permission)) return true;
    return (page.altPermissions || []).some((p) => crudAllowsPerm(crudForRole, p));
}

export function defaultModuleEnabled(moduleKey, roleKey, permKeys, pageStates) {
    if (LOCKED_MODULE_KEYS.has(moduleKey)) return true;
    if (SOCIETY_FULL_ADMIN_KEYS.has(roleKey)) return true;
    const routes = Object.keys(pageStates || {});
    if (!routes.length) return true;
    return routes.some((route) => pageStates[route] === true);
}

export function derivePagesAndModulesFromCrud(crudByRole, roles = MATRIX_ROLE_KEYS) {
    const pages = {};
    const moduleEnabled = {};
    roles.forEach((roleKey) => {
        pages[roleKey] = pages[roleKey] || {};
        moduleEnabled[roleKey] = {};
        MODULE_CATALOG.forEach(({ key }) => {
            if (LOCKED_MODULE_KEYS.has(key) || SOCIETY_FULL_ADMIN_KEYS.has(roleKey)) {
                moduleEnabled[roleKey][key] = true;
                return;
            }
            const resourceKeys = CRUD_RESOURCES.filter((r) => r.moduleId === key).map((r) => r.key);
            moduleEnabled[roleKey][key] = resourceKeys.some((rk) => {
                const row = crudByRole?.[roleKey]?.[rk];
                return row && (row.read || row.create || row.update || row.delete);
            });
        });
    });
    return { pages, moduleEnabled };
}

export async function saveRbacMatrix(apartmentId, { pages, moduleEnabled, crud }) {
    if (!apartmentId) throw new Error('Apartment required.');
    await persistMongoPolicy({
        apartmentId,
        pages,
        modules: moduleEnabled,
        crud,
    });
    const roleKey = portalState.auth?.effectiveRoleKey;
    if (roleKey && moduleEnabled?.[roleKey]) {
        portalState.moduleAccess = portalState.moduleAccess || { apartment: {}, user: {}, role: {} };
        portalState.moduleAccess.role = { ...moduleEnabled[roleKey] };
    }
    if (roleKey && crud?.[roleKey]) {
        portalState.crudAccess = { ...crud[roleKey] };
    }
    if (roleKey && pages?.[roleKey]) {
        portalState.pageAccess = portalState.pageAccess || { user: {}, societyRole: {} };
        portalState.pageAccess.societyRole = { [roleKey]: { ...(pages[roleKey] || {}) } };
    }
}

export function canCrud(resourceKey, action = 'read') {
    if (portalState.auth?.isSystemAdmin || portalState.auth?.effectiveRoleKey === 'system_admin') {
        return true;
    }
    if (SOCIETY_FULL_ADMIN_KEYS.has(portalState.auth?.effectiveRoleKey)) return true;

    const stored = portalState.crudAccess?.[resourceKey];
    if (stored && Object.prototype.hasOwnProperty.call(stored, action)) {
        return !!stored[action];
    }

    const perms = portalState.authPermissions || [];
    const defaults = defaultCrudFromPermKeys(resourceKey, perms);
    return !!defaults[action];
}

export async function buildRbacMatrixState() {
    throw new Error('Use loadRbacMatrix() in Admin-New (Mongo).');
}
