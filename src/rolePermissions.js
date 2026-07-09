/**
 * Role permissions: platform defaults + per-society overrides.
 */
import { portalState, supabase } from './store.js';
import { ROLE_OPTIONS } from './rbac.js';

const FALLBACK_PERMISSIONS = [
    { key: 'vehicle_registry.view', module: 'vehicle_registry', description: 'View vehicle registry' },
    { key: 'vehicle_registry.edit', module: 'vehicle_registry', description: 'Edit vehicle registry' },
    { key: 'accounts.view', module: 'accounts', description: 'View accounts and ledger' },
    { key: 'accounts.edit', module: 'accounts', description: 'Create and edit transactions' },
    { key: 'setup.view', module: 'setup', description: 'View setup' },
    { key: 'setup.edit', module: 'setup', description: 'Edit setup and policies' },
    { key: 'rbac.view', module: 'rbac', description: 'View access control' },
    { key: 'rbac.edit', module: 'rbac', description: 'Edit roles and permissions' },
    { key: 'apartment_mgmt.view', module: 'apartment_mgmt', description: 'View residents and units' },
    { key: 'apartment_mgmt.edit', module: 'apartment_mgmt', description: 'Edit residents and units' },
    { key: 'security.view', module: 'security', description: 'View security portal' },
    { key: 'portal.view', module: 'portal', description: 'View resident portal' },
];

const MODULE_LABELS = {
    vehicle_registry: 'Vehicle Registry',
    accounts: 'Accounts & Finance',
    setup: 'Setup & Configuration',
    rbac: 'Access Control',
    apartment_mgmt: 'Property Management',
    security: 'Security',
    portal: 'Resident Portal',
    system: 'Platform (system only)',
};

const SOCIETY_EXCLUDED_PERMISSION_PREFIXES = ['system.'];

let roleCatalogCache = null;
let permissionCatalogCache = null;

export function permissionModuleLabel(moduleKey) {
    return MODULE_LABELS[moduleKey] || String(moduleKey || '').replace(/_/g, ' ');
}

export function isSocietyConfigurablePermission(permissionKey) {
    return !SOCIETY_EXCLUDED_PERMISSION_PREFIXES.some((prefix) => permissionKey.startsWith(prefix));
}

export async function loadRoleCatalog({ force = false } = {}) {
    if (!force && roleCatalogCache) return roleCatalogCache;
    if (!supabase) {
        roleCatalogCache = ROLE_OPTIONS.map((r) => ({
            key: r.key,
            scope: r.key === 'system_admin' ? 'system' : 'apartment',
            label: r.label,
            description: r.label,
        }));
        return roleCatalogCache;
    }
    const { data, error } = await supabase
        .from('roles')
        .select('key, scope, label, description')
        .order('label');
    if (error) {
        if (/roles/i.test(error.message)) {
            roleCatalogCache = ROLE_OPTIONS.map((r) => ({
                key: r.key,
                scope: r.key === 'system_admin' ? 'system' : 'apartment',
                label: r.label,
                description: r.label,
            }));
            return roleCatalogCache;
        }
        throw new Error(error.message);
    }
    roleCatalogCache = (data || []).length ? data : ROLE_OPTIONS.map((r) => ({
        key: r.key,
        scope: r.key === 'system_admin' ? 'system' : 'apartment',
        label: r.label,
        description: r.label,
    }));
    return roleCatalogCache;
}

export async function getSocietyRoleOptions() {
    const roles = await loadRoleCatalog();
    return roles.filter((r) => r.scope === 'apartment');
}

export async function loadPermissionCatalog({ force = false } = {}) {
    if (!force && permissionCatalogCache) return permissionCatalogCache;
    if (!supabase) {
        permissionCatalogCache = FALLBACK_PERMISSIONS;
        return permissionCatalogCache;
    }
    const { data, error } = await supabase
        .from('permissions')
        .select('key, module, description')
        .order('module')
        .order('key');
    if (error) {
        if (/permissions/i.test(error.message)) {
            permissionCatalogCache = FALLBACK_PERMISSIONS;
            return permissionCatalogCache;
        }
        throw new Error(error.message);
    }
    permissionCatalogCache = (data || []).length ? data : FALLBACK_PERMISSIONS;
    return permissionCatalogCache;
}

export function permissionsByModule(catalog = FALLBACK_PERMISSIONS) {
    const grouped = new Map();
    catalog.forEach((perm) => {
        if (!isSocietyConfigurablePermission(perm.key)) return;
        const mod = perm.module || 'other';
        if (!grouped.has(mod)) grouped.set(mod, []);
        grouped.get(mod).push(perm);
    });
    return Array.from(grouped.entries()).map(([module, permissions]) => ({
        module,
        moduleLabel: permissionModuleLabel(module),
        permissions,
    }));
}

export async function fetchPlatformRolePermissionKeys(roleKey) {
    if (!supabase || !roleKey) return [];
    const { data, error } = await supabase
        .from('role_permissions')
        .select('permission_key')
        .eq('role_key', roleKey);
    if (error) {
        if (/role_permissions/i.test(error.message)) return [];
        throw new Error(error.message);
    }
    return (data || []).map((row) => row.permission_key);
}

export async function fetchSocietyRolePermissionMap(apartmentId, roleKey) {
    if (!supabase || !apartmentId || !roleKey) return {};
    const { data, error } = await supabase
        .from('society_role_permissions')
        .select('permission_key, granted')
        .eq('apartment_id', apartmentId)
        .eq('role_key', roleKey);
    if (error) {
        if (/society_role_permissions/i.test(error.message)) return {};
        throw new Error(error.message);
    }
    const map = {};
    (data || []).forEach((row) => { map[row.permission_key] = row.granted; });
    return map;
}

export async function effectiveRolePermissionKeys(apartmentId, roleKey) {
    const [platformKeys, societyMap, catalog] = await Promise.all([
        fetchPlatformRolePermissionKeys(roleKey),
        fetchSocietyRolePermissionMap(apartmentId, roleKey),
        loadPermissionCatalog(),
    ]);
    const keys = [];
    catalog.forEach((perm) => {
        if (!isSocietyConfigurablePermission(perm.key)) return;
        if (Object.prototype.hasOwnProperty.call(societyMap, perm.key)) {
            if (societyMap[perm.key]) keys.push(perm.key);
            return;
        }
        if (platformKeys.includes(perm.key)) keys.push(perm.key);
    });
    return keys;
}

export async function effectiveRolePermissionKeysForRoles(apartmentId, roleKeys = []) {
    const unique = Array.from(new Set((roleKeys || []).filter(Boolean)));
    if (!unique.length) return [];
    const sets = await Promise.all(unique.map((roleKey) => effectiveRolePermissionKeys(apartmentId, roleKey)));
    return Array.from(new Set(sets.flat()));
}

export async function buildRolePermissionEditorState(apartmentId, roleKey) {
    const [platformKeys, societyMap, catalog] = await Promise.all([
        fetchPlatformRolePermissionKeys(roleKey),
        fetchSocietyRolePermissionMap(apartmentId, roleKey),
        loadPermissionCatalog(),
    ]);
    const states = {};
    catalog.forEach((perm) => {
        if (!isSocietyConfigurablePermission(perm.key)) return;
        if (Object.prototype.hasOwnProperty.call(societyMap, perm.key)) {
            states[perm.key] = societyMap[perm.key];
        } else {
            states[perm.key] = platformKeys.includes(perm.key);
        }
    });
    return { states, platformKeys, societyMap, catalog };
}

/**
 * Save society role permission template (sparse: only rows that differ from platform defaults).
 * @param {Record<string, boolean>} permissionStates permission_key -> checked
 */
export async function saveSocietyRolePermissions(apartmentId, roleKey, permissionStates) {
    if (!supabase || !apartmentId || !roleKey) throw new Error('Apartment and role required.');
    const platformKeys = await fetchPlatformRolePermissionKeys(roleKey);
    const catalog = await loadPermissionCatalog();

    const toUpsert = [];
    const toDelete = [];

    catalog.forEach((perm) => {
        if (!isSocietyConfigurablePermission(perm.key)) return;
        const checked = permissionStates[perm.key] === true;
        const defaultGranted = platformKeys.includes(perm.key);
        if (checked === defaultGranted) {
            toDelete.push(perm.key);
        } else {
            toUpsert.push({
                apartment_id: apartmentId,
                role_key: roleKey,
                permission_key: perm.key,
                granted: checked,
            });
        }
    });

    if (toDelete.length) {
        const { error } = await supabase
            .from('society_role_permissions')
            .delete()
            .eq('apartment_id', apartmentId)
            .eq('role_key', roleKey)
            .in('permission_key', toDelete);
        if (error && !/society_role_permissions/i.test(error.message)) throw new Error(error.message);
    }

    if (toUpsert.length) {
        const { error } = await supabase.from('society_role_permissions').upsert(
            toUpsert.map((row) => ({ ...row, updated_at: new Date().toISOString() })),
            { onConflict: 'apartment_id,role_key,permission_key' },
        );
        if (error) throw new Error(error.message);
    }

    portalState.rolePermissions = portalState.rolePermissions || { societyRole: {} };
    const map = await fetchSocietyRolePermissionMap(apartmentId, roleKey);
    portalState.rolePermissions.societyRole = portalState.rolePermissions.societyRole || {};
    portalState.rolePermissions.societyRole[roleKey] = map;
}

export async function loadSocietyRolePermissions(apartmentId, roleKey) {
    portalState.rolePermissions = portalState.rolePermissions || { societyRole: {} };
    if (!supabase || !apartmentId || !roleKey) {
        portalState.rolePermissions.societyRole = {};
        return portalState.rolePermissions;
    }
    const map = await fetchSocietyRolePermissionMap(apartmentId, roleKey);
    portalState.rolePermissions.societyRole = portalState.rolePermissions.societyRole || {};
    portalState.rolePermissions.societyRole[roleKey] = map;
    return portalState.rolePermissions;
}
