/**
 * RBAC v2 — effective permissions, user role assignments, route gating
 */
import { portalState, supabase } from './store.js';
import { pageIsVisible, findPage } from './navigation.js';
import { isModuleEnabled } from './moduleAccess.js';
import { logActivity } from './activityAudit.js';

export const ROLE_OPTIONS = [
    { key: 'apartment_admin', v1Key: 'admin', label: 'Association Office Bearer' },
    { key: 'property_manager', v1Key: 'property_manager', label: 'Office Manager' },
    { key: 'accounts_manager', v1Key: 'accounts_manager', label: 'Accounts Manager' },
    { key: 'security', v1Key: 'security', label: 'Security' },
    { key: 'resident_viewer', v1Key: 'resident_viewer', label: 'Resident Viewer' },
];

const V1_PERMISSION_MATRIX = {
    admin: [
        'vehicle_registry.view', 'vehicle_registry.edit',
        'accounts.view', 'accounts.edit',
        'setup.view', 'setup.edit',
        'rbac.view', 'rbac.edit',
        'apartment_mgmt.view', 'apartment_mgmt.edit',
        'portal.view', 'security.view',
    ],
    property_manager: [
        'vehicle_registry.view', 'vehicle_registry.edit',
        'apartment_mgmt.view', 'apartment_mgmt.edit',
        'portal.view', 'security.view',
    ],
    accounts_manager: ['accounts.view', 'accounts.edit', 'apartment_mgmt.view', 'portal.view'],
    security: ['vehicle_registry.view', 'vehicle_registry.edit', 'security.view'],
    resident_viewer: ['portal.view'],
};

export const v1RoleToV2Key = (role) =>
    ROLE_OPTIONS.find((r) => r.v1Key === role || r.key === role)?.key || 'resident_viewer';

export const v2KeyToLabel = (key) =>
    ROLE_OPTIONS.find((r) => r.key === key)?.label || key;

export const permissionsFromV1Role = (role) =>
    V1_PERMISSION_MATRIX[role] || V1_PERMISSION_MATRIX.resident_viewer;

export async function fetchEffectivePermissions(apartmentId) {
    if (!supabase || !apartmentId) return null;
    const { data: s } = await supabase.auth.getSession();
    const uid = s?.session?.user?.id;
    if (!uid) return null;

    const { data: roles, error } = await supabase
        .from('user_role_assignments')
        .select('role_key, scope, apartment_id')
        .eq('user_id', uid);

    if (error) {
        if (/user_role_assignments/i.test(error.message)) return null;
        throw error;
    }
    if (!roles?.length) return null;

    const isSystemAdmin = roles.some((r) => r.scope === 'system' && r.role_key === 'system_admin');
    if (isSystemAdmin) {
        const { data: perms } = await supabase.from('permissions').select('key');
        return (perms || []).map((p) => p.key);
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

export async function refreshAuthPermissions(apartmentId) {
    const v1Fallback = permissionsFromV1Role(portalState.auth?.role || 'resident_viewer');
    try {
        const perms = await fetchEffectivePermissions(apartmentId);
        if (perms?.length) {
            portalState.authPermissions = perms;
            return portalState.authPermissions;
        }
    } catch { /* ignore */ }
    portalState.authPermissions = v1Fallback;
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
