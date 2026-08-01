/**
 * RBAC v2 — effective permissions, user role assignments, route gating
 */
import { portalState, supabase } from './store.js';
import { pageIsVisible, findPage } from './navigation.js';
import { isModuleEnabled } from './moduleAccess.js';
import { logActivity } from './activityAudit.js';

export const ROLE_OPTIONS = [
    { key: 'system_admin', v1Key: 'admin', label: 'System Administrator' },
    { key: 'apartment_admin', v1Key: 'admin', label: 'Association Office Bearer' },
    { key: 'property_manager', v1Key: 'property_manager', label: 'Office Manager' },
    { key: 'accounts_manager', v1Key: 'accounts_manager', label: 'Accounts Manager' },
    { key: 'office_staff', v1Key: 'office_staff', label: 'Office Staff' },
    { key: 'security', v1Key: 'security', label: 'Security' },
    { key: 'resident_viewer', v1Key: 'resident_viewer', label: 'Resident Viewer' },
];

const V1_PERMISSION_MATRIX = {
    admin: [
        'vehicle_registry.view', 'vehicle_registry.edit',
        'accounts.view', 'accounts.edit', 'accounts.bills_entry',
        'setup.view', 'setup.edit',
        'rbac.view', 'rbac.edit',
        'apartment_mgmt.view', 'apartment_mgmt.edit',
        'portal.view', 'security.view',
    ],
    property_manager: [
        'vehicle_registry.view', 'vehicle_registry.edit',
        'apartment_mgmt.view', 'apartment_mgmt.edit',
        'portal.view', 'security.view', 'accounts.bills_entry',
    ],
    accounts_manager: ['accounts.view', 'accounts.edit', 'accounts.bills_entry', 'apartment_mgmt.view', 'portal.view'],
    office_staff: ['accounts.bills_entry'],
    security: ['vehicle_registry.view', 'vehicle_registry.edit', 'security.view'],
    resident_viewer: ['portal.view'],
};

export const v1RoleToV2Key = (role) =>
    ROLE_OPTIONS.find((r) => r.v1Key === role || r.key === role)?.key || 'resident_viewer';

export const v2KeyToLabel = (key) =>
    ROLE_OPTIONS.find((r) => r.key === key)?.label || key;

export const permissionsFromV1Role = (role) => {
    const v1 = ROLE_OPTIONS.find((r) => r.key === role || r.v1Key === role)?.v1Key || role;
    return V1_PERMISSION_MATRIX[v1] || V1_PERMISSION_MATRIX.resident_viewer;
};

export function isSystemAdminUser(auth = portalState.auth) {
    return auth?.isSystemAdmin === true || auth?.effectiveRoleKey === 'system_admin';
}

export function isApartmentAdminUser(auth = portalState.auth) {
    return isSystemAdminUser(auth)
        || auth?.effectiveRoleKey === 'apartment_admin'
        || auth?.role === 'admin';
}

export function rolePermissionFloor(roleKey = portalState.auth?.effectiveRoleKey) {
    if (roleKey === 'system_admin' || portalState.auth?.isSystemAdmin) {
        return permissionsFromV1Role('admin');
    }
    const key = roleKey || v1RoleToV2Key(portalState.auth?.role || 'resident_viewer');
    const v1 = ROLE_OPTIONS.find((r) => r.key === key)?.v1Key || portalState.auth?.role || 'resident_viewer';
    return permissionsFromV1Role(v1);
}

const roleBook = globalThis.__sentryRoleBook || (globalThis.__sentryRoleBook = {
    cache: { userId: null, rows: [] },
    inflight: null,
    inflightUserId: null,
    allPermissionKeys: null,
    allPermissionKeysInflight: null,
});

export function clearRoleAssignmentsCache() {
    roleBook.cache = { userId: null, rows: [] };
    roleBook.inflight = null;
    roleBook.inflightUserId = null;
}

export function seedRoleAssignmentsCache(userId, rows = []) {
    if (!userId) return;
    roleBook.cache = { userId, rows: rows || [] };
}

export async function loadAllUserRoleAssignmentsCached(userId, { force = false } = {}) {
    if (!supabase || !userId) return [];
    if (!force && roleBook.cache.userId === userId) return roleBook.cache.rows;
    if (!force && roleBook.inflight && roleBook.inflightUserId === userId) return roleBook.inflight;

    roleBook.inflightUserId = userId;
    roleBook.inflight = (async () => {
        const rows = await loadAllUserRoleAssignments(userId);
        roleBook.cache = { userId, rows };
        return rows;
    })().finally(() => {
        if (roleBook.inflightUserId === userId) {
            roleBook.inflight = null;
            roleBook.inflightUserId = null;
        }
    });
    return roleBook.inflight;
}

async function loadAllPermissionKeys() {
    if (roleBook.allPermissionKeys) return roleBook.allPermissionKeys;
    if (roleBook.allPermissionKeysInflight) return roleBook.allPermissionKeysInflight;
    roleBook.allPermissionKeysInflight = (async () => {
        const { data: perms } = await supabase.from('permissions').select('key');
        roleBook.allPermissionKeys = (perms || []).map((p) => p.key);
        return roleBook.allPermissionKeys;
    })().finally(() => {
        roleBook.allPermissionKeysInflight = null;
    });
    return roleBook.allPermissionKeysInflight;
}

export async function fetchEffectivePermissions(apartmentId, rolesOverride = null) {
    if (!supabase || !apartmentId) return null;
    let userId = portalState.auth?.id;
    if (!userId) {
        const { data: s } = await supabase.auth.getSession();
        userId = s?.session?.user?.id;
    }
    if (!userId) return null;

    // Always go through the coalesced cache — never issue parallel role selects.
    const roles = rolesOverride || await loadAllUserRoleAssignmentsCached(userId);
    if (!roles?.length) return null;

    const isSystemAdmin = roles.some((r) => r.scope === 'system' && r.role_key === 'system_admin');
    if (isSystemAdmin) {
        return loadAllPermissionKeys();
    }

    const aptRoleKeys = roles
        .filter((r) => r.scope === 'apartment' && r.apartment_id === apartmentId)
        .map((r) => r.role_key);

    if (!aptRoleKeys.length) return null;

    const { data: rp } = await supabase
        .from('role_permissions')
        .select('permission_key')
        .in('role_key', aptRoleKeys);

    return Array.from(new Set((rp || []).map((x) => x.permission_key)));
}

export function resolveEffectivePermissions(apartmentId) {
    if (portalState.authPermissions?.length) return portalState.authPermissions;
    const v1Role = portalState.auth?.role || 'resident_viewer';
    return permissionsFromV1Role(v1Role);
}

export function hasClientPermission(perm, perms = resolveEffectivePermissions()) {
    if (!perm) return true;
    return (perms || []).includes(perm);
}

export function routeIsAllowed(route, offline = !supabase) {
    const meta = findPage(route);
    if (!meta) return false;
    if (!isModuleEnabled(meta.module.id)) return false;
    const perms = resolveEffectivePermissions();
    if (offline) return pageIsVisible(meta.page, new Set(perms), true, meta.module.id);
    return pageIsVisible(meta.page, new Set(perms), false, meta.module.id);
}

export async function refreshAuthPermissions(apartmentId, rolesOverride = null) {
    const floor = rolePermissionFloor();
    try {
        const dbPerms = await fetchEffectivePermissions(apartmentId, rolesOverride);
        if (dbPerms?.length) {
            portalState.authPermissions = [...new Set([...floor, ...dbPerms])];
            return portalState.authPermissions;
        }
    } catch { /* ignore */ }
    portalState.authPermissions = floor;
    return portalState.authPermissions;
}

export async function loadUserRoleAssignments(userId) {
    if (!supabase || !userId) return [];
    const { data } = await supabase
        .from('user_role_assignments')
        .select('role_key, apartment_id, scope')
        .eq('user_id', userId)
        .eq('scope', 'apartment');
    return data || [];
}

export async function loadAllUserRoleAssignments(userId) {
    if (!supabase || !userId) return [];
    const { data } = await supabase
        .from('user_role_assignments')
        .select('role_key, apartment_id, scope')
        .eq('user_id', userId);
    return data || [];
}

export async function userHasSystemAdminRole(userId) {
    const rows = await loadAllUserRoleAssignmentsCached(userId);
    return rows.some((r) => r.scope === 'system' && r.role_key === 'system_admin');
}

export function primaryRoleFromAssignments(assignments = []) {
    if (!assignments.length) return 'resident_viewer';
    const priority = ['apartment_admin', 'accounts_manager', 'property_manager', 'security', 'resident_viewer'];
    for (const key of priority) {
        if (assignments.some((a) => a.role_key === key)) return key;
    }
    return assignments[0].role_key;
}

export async function saveUserAccess({
    userId,
    name,
    email,
    roleKey,
    apartmentIds,
    previousAssignments = [],
    managedApartmentIds = null,
}) {
    if (!supabase) throw new Error('Supabase is not configured.');
    const v2Role = v1RoleToV2Key(roleKey);
    const scopeIds = managedApartmentIds?.length
        ? managedApartmentIds
        : (portalState.access?.apartments || []).map((a) => a.id);

    const { error: profileErr } = await supabase
        .from('profiles')
        .update({ full_name: name, role: ROLE_OPTIONS.find((r) => r.key === v2Role)?.v1Key || roleKey })
        .eq('id', userId);
    if (profileErr) throw new Error(profileErr.message);

    const targetApartmentIds = Array.from(new Set(apartmentIds.filter(Boolean)));
    for (const aid of scopeIds) {
        if (targetApartmentIds.includes(aid)) {
            const { error } = await supabase
                .from('user_apartments')
                .upsert({ user_id: userId, apartment_id: aid }, { onConflict: 'user_id,apartment_id' });
            if (error) throw new Error(error.message);
        } else {
            const { error } = await supabase
                .from('user_apartments')
                .delete()
                .eq('user_id', userId)
                .eq('apartment_id', aid);
            if (error) throw new Error(error.message);
        }
    }

    for (const aid of scopeIds) {
        const { error: delErr } = await supabase
            .from('user_role_assignments')
            .delete()
            .eq('user_id', userId)
            .eq('scope', 'apartment')
            .eq('apartment_id', aid);
        if (delErr && !/user_role_assignments/i.test(delErr.message)) {
            throw new Error(delErr.message);
        }
    }

    for (const aid of targetApartmentIds) {
        const { error } = await supabase.from('user_role_assignments').insert({
            user_id: userId,
            role_key: v2Role,
            scope: 'apartment',
            apartment_id: aid,
        });
        if (error && !/user_role_assignments/i.test(error.message)) {
            throw new Error(error.message);
        }
    }

    const aptId = portalState.access?.activeApartmentId;
    if (aptId) {
        await logActivity({
            entityType: 'ROLE',
            entityId: userId,
            action: 'GRANT',
            summary: `Role ${v2KeyToLabel(v2Role)} for ${email || userId}`,
            oldData: { assignments: previousAssignments },
            newData: { role_key: v2Role, apartment_ids: apartmentIds },
        });
    }
}

/** Office manager role — operational staff whose audit entries require review */
export function isOfficeManager(roleKey = portalState.auth?.effectiveRoleKey) {
    return roleKey === 'property_manager';
}

/** Association office bearers who can approve/reject pending audit entries */
export function canReviewAudit(roleKey = portalState.auth?.effectiveRoleKey) {
    return roleKey === 'apartment_admin' || roleKey === 'accounts_manager';
}
