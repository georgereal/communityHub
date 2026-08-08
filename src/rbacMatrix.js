/**
 * Society-scoped RBAC matrices: role × module, role × page, role × CRUD.
 */
import { portalState, supabase } from './store.js';
import { ROLE_OPTIONS, SOCIETY_FULL_ADMIN_KEYS } from './rbac.js';
import { MODULE_CATALOG, LOCKED_MODULE_KEYS } from './moduleAccess.js';
import {
    buildPageCatalog,
    pageAllowedByPermissions,
    pageCatalogByModule,
} from './navigation.js';
import { fetchRolePermissionKeys, fetchSocietyRolePageMap, saveSocietyRolePageAccess } from './pageAccess.js';

/** Roles editable on the society RBAC matrix (exclude platform system_admin). */
export const MATRIX_ROLE_KEYS = ROLE_OPTIONS
    .map((r) => r.key)
    .filter((k) => k !== 'system_admin');

/** Permission-domain resources for CRUD matrix. */
export const CRUD_RESOURCES = [
    { key: 'vehicle_registry', label: 'Vehicles & Parking', moduleId: 'property' },
    { key: 'apartment_mgmt', label: 'Property & Operations', moduleId: 'property' },
    { key: 'accounts', label: 'Finance & Accounts', moduleId: 'finance' },
    { key: 'security', label: 'Security Gate', moduleId: 'security' },
    { key: 'portal', label: 'Resident Portal', moduleId: 'portal' },
    { key: 'setup', label: 'Society Setup', moduleId: 'admin' },
    { key: 'rbac', label: 'Roles & Access', moduleId: 'admin' },
];

export const CRUD_ACTIONS = [
    { key: 'create', col: 'can_create', short: 'C', label: 'Create' },
    { key: 'read', col: 'can_read', short: 'R', label: 'Read' },
    { key: 'update', col: 'can_update', short: 'U', label: 'Update' },
    { key: 'delete', col: 'can_delete', short: 'D', label: 'Delete' },
];

function emptyCrud() {
    return { create: false, read: false, update: false, delete: false };
}

/** Default CRUD from platform role_permissions (.view → R, .edit → C/U; Delete is opt-in via matrix). */
export function defaultCrudFromPermKeys(resourceKey, permKeys = []) {
    const set = new Set(permKeys || []);
    const view = set.has(`${resourceKey}.view`);
    const edit = set.has(`${resourceKey}.edit`);
    // portal / security are view-only keys today — treat view as read (+ light mutate for gate ops).
    if (resourceKey === 'portal' || resourceKey === 'security') {
        return { create: view, read: view, update: view, delete: false };
    }
    return {
        create: edit,
        read: view || edit,
        update: edit,
        // Delete must be granted in society_role_crud_access (Roles → CRUD → D).
        delete: false,
    };
}

export function defaultModuleEnabled(moduleKey, roleKey, permKeys, pageStates) {
    if (LOCKED_MODULE_KEYS.has(moduleKey)) return true;
    if (SOCIETY_FULL_ADMIN_KEYS.has(roleKey)) return true;
    const pages = buildPageCatalog().filter((p) => p.moduleId === moduleKey);
    if (!pages.length) return true;
    return pages.some((p) => {
        if (pageStates && Object.prototype.hasOwnProperty.call(pageStates, p.route)) {
            return pageStates[p.route] === true;
        }
        return pageAllowedByPermissions(p, permKeys);
    });
}

export async function fetchSocietyRoleModuleMap(apartmentId) {
    if (!supabase || !apartmentId) return {};
    const { data, error } = await supabase
        .from('society_role_module_access')
        .select('role_key, module_key, enabled')
        .eq('apartment_id', apartmentId);
    if (error) {
        if (/society_role_module_access/i.test(error.message)) return {};
        throw new Error(error.message);
    }
    const map = {};
    (data || []).forEach((row) => {
        map[row.role_key] = map[row.role_key] || {};
        map[row.role_key][row.module_key] = row.enabled !== false;
    });
    return map;
}

export async function fetchSocietyRoleCrudMap(apartmentId) {
    if (!supabase || !apartmentId) return {};
    const { data, error } = await supabase
        .from('society_role_crud_access')
        .select('role_key, resource_key, can_create, can_read, can_update, can_delete')
        .eq('apartment_id', apartmentId);
    if (error) {
        if (/society_role_crud_access/i.test(error.message)) return {};
        throw new Error(error.message);
    }
    const map = {};
    (data || []).forEach((row) => {
        map[row.role_key] = map[row.role_key] || {};
        map[row.role_key][row.resource_key] = {
            create: !!row.can_create,
            read: !!row.can_read,
            update: !!row.can_update,
            delete: !!row.can_delete,
        };
    });
    return map;
}

export async function fetchAllSocietyRolePageMaps(apartmentId) {
    if (!supabase || !apartmentId) return {};
    const { data, error } = await supabase
        .from('society_role_page_access')
        .select('role_key, route, allowed')
        .eq('apartment_id', apartmentId);
    if (error) {
        if (/society_role_page_access/i.test(error.message)) return {};
        throw new Error(error.message);
    }
    const map = {};
    (data || []).forEach((row) => {
        map[row.role_key] = map[row.role_key] || {};
        map[row.role_key][row.route] = !!row.allowed;
    });
    return map;
}

/**
 * Build full editor state for all matrix roles.
 * @returns {{
 *   roles: string[],
 *   modules: typeof MODULE_CATALOG,
 *   pageGroups: ReturnType<typeof pageCatalogByModule>,
 *   resources: typeof CRUD_RESOURCES,
 *   pages: Record<string, Record<string, boolean>>,
 *   moduleEnabled: Record<string, Record<string, boolean>>,
 *   crud: Record<string, Record<string, {create:boolean,read:boolean,update:boolean,delete:boolean}>>,
 * }}
 */
export async function buildRbacMatrixState(apartmentId) {
    const roles = MATRIX_ROLE_KEYS;
    const [pageOverrides, moduleOverrides, crudOverrides, ...permLists] = await Promise.all([
        fetchAllSocietyRolePageMaps(apartmentId),
        fetchSocietyRoleModuleMap(apartmentId),
        fetchSocietyRoleCrudMap(apartmentId),
        ...roles.map((r) => fetchRolePermissionKeys(r)),
    ]);

    const pages = {};
    const moduleEnabled = {};
    const crud = {};

    roles.forEach((roleKey, idx) => {
        const permKeys = permLists[idx] || [];
        const societyPages = pageOverrides[roleKey] || {};
        pages[roleKey] = {};
        buildPageCatalog().forEach((page) => {
            if (Object.prototype.hasOwnProperty.call(societyPages, page.route)) {
                pages[roleKey][page.route] = societyPages[page.route];
            } else {
                pages[roleKey][page.route] = pageAllowedByPermissions(page, permKeys);
            }
        });

        moduleEnabled[roleKey] = {};
        MODULE_CATALOG.forEach(({ key }) => {
            const stored = moduleOverrides[roleKey]?.[key];
            if (typeof stored === 'boolean') {
                moduleEnabled[roleKey][key] = LOCKED_MODULE_KEYS.has(key) ? true : stored;
            } else {
                moduleEnabled[roleKey][key] = defaultModuleEnabled(key, roleKey, permKeys, pages[roleKey]);
            }
        });

        crud[roleKey] = {};
        CRUD_RESOURCES.forEach(({ key }) => {
            const stored = crudOverrides[roleKey]?.[key];
            crud[roleKey][key] = stored ? { ...emptyCrud(), ...stored } : defaultCrudFromPermKeys(key, permKeys);
        });
    });

    return {
        roles,
        modules: MODULE_CATALOG,
        pageGroups: pageCatalogByModule(true),
        resources: CRUD_RESOURCES,
        pages,
        moduleEnabled,
        crud,
    };
}

export async function saveSocietyRoleModules(apartmentId, moduleEnabledByRole) {
    if (!supabase || !apartmentId) throw new Error('Apartment required.');
    const rows = [];
    Object.entries(moduleEnabledByRole || {}).forEach(([roleKey, mods]) => {
        Object.entries(mods || {}).forEach(([moduleKey, enabled]) => {
            rows.push({
                apartment_id: apartmentId,
                role_key: roleKey,
                module_key: moduleKey,
                enabled: LOCKED_MODULE_KEYS.has(moduleKey) ? true : enabled !== false,
                updated_at: new Date().toISOString(),
            });
        });
    });

    const { error: delErr } = await supabase
        .from('society_role_module_access')
        .delete()
        .eq('apartment_id', apartmentId);
    if (delErr && !/society_role_module_access/i.test(delErr.message)) throw new Error(delErr.message);

    if (rows.length) {
        const { error } = await supabase.from('society_role_module_access').insert(rows);
        if (error) throw new Error(error.message);
    }
}

export async function saveSocietyRoleCrud(apartmentId, crudByRole) {
    if (!supabase || !apartmentId) throw new Error('Apartment required.');
    const rows = [];
    Object.entries(crudByRole || {}).forEach(([roleKey, resources]) => {
        Object.entries(resources || {}).forEach(([resourceKey, actions]) => {
            rows.push({
                apartment_id: apartmentId,
                role_key: roleKey,
                resource_key: resourceKey,
                can_create: !!actions.create,
                can_read: !!actions.read,
                can_update: !!actions.update,
                can_delete: !!actions.delete,
                updated_at: new Date().toISOString(),
            });
        });
    });

    const { error: delErr } = await supabase
        .from('society_role_crud_access')
        .delete()
        .eq('apartment_id', apartmentId);
    if (delErr && !/society_role_crud_access/i.test(delErr.message)) throw new Error(delErr.message);

    if (rows.length) {
        const { error } = await supabase.from('society_role_crud_access').insert(rows);
        if (error) throw new Error(error.message);
    }
}

/** Persist all three matrices for every role. */
export async function saveRbacMatrix(apartmentId, { pages, moduleEnabled, crud }) {
    if (!apartmentId) throw new Error('Apartment required.');
    const roles = Object.keys(pages || {});
    for (const roleKey of roles) {
        await saveSocietyRolePageAccess(apartmentId, roleKey, pages[roleKey] || {});
    }
    await saveSocietyRoleModules(apartmentId, moduleEnabled);
    await saveSocietyRoleCrud(apartmentId, crud);

    // Refresh runtime maps for signed-in user
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
        const map = await fetchSocietyRolePageMap(apartmentId, roleKey);
        portalState.pageAccess.societyRole = { [roleKey]: map };
    }
}

/** Runtime CRUD check — society matrix, else derive from effective permissions. */
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

export async function loadCrudAccessForRole(apartmentId, roleKey) {
    if (!apartmentId || !roleKey) {
        portalState.crudAccess = {};
        return {};
    }
    if (roleKey === 'system_admin' || SOCIETY_FULL_ADMIN_KEYS.has(roleKey)) {
        const full = {};
        CRUD_RESOURCES.forEach(({ key }) => {
            full[key] = { create: true, read: true, update: true, delete: true };
        });
        portalState.crudAccess = full;
        return full;
    }
    const map = await fetchSocietyRoleCrudMap(apartmentId);
    const stored = map[roleKey];
    if (stored && Object.keys(stored).length) {
        portalState.crudAccess = stored;
        return stored;
    }
    // Browser RLS may hide the matrix from non-rbac roles. Keep a boot/service-loaded map.
    if (portalState.crudAccess && Object.keys(portalState.crudAccess).length) {
        return portalState.crudAccess;
    }
    const permKeys = await fetchRolePermissionKeys(roleKey);
    const derived = {};
    CRUD_RESOURCES.forEach(({ key }) => {
        derived[key] = defaultCrudFromPermKeys(key, permKeys);
    });
    portalState.crudAccess = derived;
    return derived;
}

export async function loadRoleModuleAccess(apartmentId, roleKey) {
    portalState.moduleAccess = portalState.moduleAccess || { apartment: {}, user: {}, role: {} };
    if (!apartmentId || !roleKey) {
        portalState.moduleAccess.role = {};
        return {};
    }
    if (roleKey === 'system_admin' || SOCIETY_FULL_ADMIN_KEYS.has(roleKey)) {
        const all = {};
        MODULE_CATALOG.forEach(({ key }) => { all[key] = true; });
        portalState.moduleAccess.role = all;
        return all;
    }
    const map = await fetchSocietyRoleModuleMap(apartmentId);
    const stored = map[roleKey];
    if (stored && Object.keys(stored).length) {
        portalState.moduleAccess.role = stored;
        return stored;
    }
    portalState.moduleAccess.role = {};
    return {};
}
