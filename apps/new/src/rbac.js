/**
 * New-app RBAC — Mongo /api/rbac-mongo only. No Postgres.
 */
import { portalState } from './store.js';
import { persistMongoAssignment } from './rbacMongoClient.js';

export const ROLE_OPTIONS = [
    { key: 'system_admin', v1Key: 'admin', label: 'System Administrator', scope: 'system' },
    { key: 'society_admin', v1Key: 'admin', label: 'Society Administrator', scope: 'apartment' },
    { key: 'apartment_admin', v1Key: 'admin', label: 'Association Office Bearer', scope: 'apartment' },
    { key: 'property_manager', v1Key: 'property_manager', label: 'Office Manager', scope: 'apartment' },
    { key: 'accounts_manager', v1Key: 'accounts_manager', label: 'Accounts Manager', scope: 'apartment' },
    { key: 'office_staff', v1Key: 'office_staff', label: 'Office Staff', scope: 'apartment' },
    { key: 'security', v1Key: 'security', label: 'Security', scope: 'apartment' },
    { key: 'resident_viewer', v1Key: 'resident_viewer', label: 'Resident Viewer', scope: 'apartment' },
];

const FULL_SOCIETY_ADMIN_PERMS = [
    'vehicle_registry.view', 'vehicle_registry.edit',
    'accounts.view', 'accounts.edit', 'accounts.bills_entry',
    'setup.view', 'setup.edit',
    'rbac.view', 'rbac.edit',
    'apartment_mgmt.view', 'apartment_mgmt.edit',
    'portal.view', 'security.view',
];

const OFFICE_BEARER_PERMS = [
    'vehicle_registry.view', 'vehicle_registry.edit',
    'accounts.view', 'accounts.edit', 'accounts.bills_entry',
    'setup.view', 'setup.edit',
    'apartment_mgmt.view', 'apartment_mgmt.edit',
    'portal.view', 'security.view',
];

const V1_PERMISSION_MATRIX = {
    admin: FULL_SOCIETY_ADMIN_PERMS,
    society_admin: FULL_SOCIETY_ADMIN_PERMS,
    apartment_admin: OFFICE_BEARER_PERMS,
    property_manager: [
        'vehicle_registry.view', 'vehicle_registry.edit',
        'apartment_mgmt.view', 'apartment_mgmt.edit',
        'portal.view', 'security.view',
        'accounts.view', 'accounts.bills_entry',
    ],
    accounts_manager: ['accounts.view', 'accounts.edit', 'accounts.bills_entry', 'apartment_mgmt.view', 'portal.view'],
    office_staff: ['accounts.bills_entry'],
    security: ['vehicle_registry.view', 'vehicle_registry.edit', 'security.view'],
    resident_viewer: ['portal.view'],
};

export const SOCIETY_FULL_ADMIN_KEYS = new Set(['society_admin']);

export const v1RoleToV2Key = (role) => {
    if (role === 'society_admin') return 'society_admin';
    if (role === 'system_admin') return 'system_admin';
    if (role === 'apartment_admin') return 'apartment_admin';
    if (role === 'admin') return 'society_admin';
    return ROLE_OPTIONS.find((r) => r.v1Key === role || r.key === role)?.key || 'resident_viewer';
};

export const v2KeyToLabel = (key) =>
    ROLE_OPTIONS.find((r) => r.key === key)?.label || key;

export const permissionsFromV1Role = (role) => {
    if (role === 'system_admin' || role === 'society_admin') return FULL_SOCIETY_ADMIN_PERMS;
    if (role === 'apartment_admin') return OFFICE_BEARER_PERMS;
    const v1 = ROLE_OPTIONS.find((r) => r.key === role || r.v1Key === role)?.v1Key || role;
    return V1_PERMISSION_MATRIX[v1] || V1_PERMISSION_MATRIX.resident_viewer;
};

export function isSystemAdminUser(auth = portalState.auth) {
    return auth?.isSystemAdmin === true || auth?.effectiveRoleKey === 'system_admin';
}

export function isSocietyAdminUser(auth = portalState.auth) {
    if (isSystemAdminUser(auth)) return true;
    return auth?.effectiveRoleKey === 'society_admin' || SOCIETY_FULL_ADMIN_KEYS.has(auth?.effectiveRoleKey);
}

export function isApartmentAdminUser(auth = portalState.auth) {
    return isSocietyAdminUser(auth) || auth?.effectiveRoleKey === 'apartment_admin';
}

export function resolveEffectivePermissions() {
    if (Array.isArray(portalState.authPermissions)) return portalState.authPermissions;
    return [];
}

export function hasClientPermission(perm, perms = resolveEffectivePermissions()) {
    if (!perm) return false;
    if (!Array.isArray(perms) || !perms.length) return false;
    return perms.includes(perm);
}

export function primaryRoleFromAssignments(assignments = []) {
    if (!assignments.length) return 'resident_viewer';
    const priority = [
        'society_admin',
        'apartment_admin',
        'accounts_manager',
        'property_manager',
        'office_staff',
        'security',
        'resident_viewer',
    ];
    for (const key of priority) {
        if (assignments.some((a) => a.role_key === key)) return key;
    }
    return assignments[0].role_key;
}

async function fetchRbacPack(apartmentId) {
    const res = await fetch(`/api/rbac-mongo?apartment_id=${encodeURIComponent(apartmentId)}`, {
        credentials: 'include',
    });
    if (!res.ok) return null;
    return res.json().catch(() => null);
}

export async function loadUserRoleAssignments(userId) {
    const apartmentId = portalState.access?.activeApartmentId;
    if (!apartmentId || !userId) return [];
    const json = await fetchRbacPack(apartmentId);
    return (json?.assignments || []).filter((r) => r.user_id === userId);
}

export async function loadAllUserRoleAssignments(userId) {
    const apartmentId = portalState.access?.activeApartmentId;
    if (!apartmentId || !userId) return [];
    const json = await fetchRbacPack(apartmentId);
    return json?.self?.assignments || [];
}

export async function saveUserAccess({
    userId,
    name,
    email,
    roleKey,
    apartmentIds,
    managedApartmentIds = null,
}) {
    if (!isSocietyAdminUser()) {
        throw new Error('Only a Society Administrator can assign or change roles.');
    }
    const v2Role = v1RoleToV2Key(roleKey);
    const scopeIds = managedApartmentIds?.length
        ? managedApartmentIds
        : (portalState.access?.apartments || []).map((a) => a.id);
    const targetApartmentIds = Array.from(new Set((apartmentIds || []).filter(Boolean)));

    for (const aid of scopeIds) {
        const role = targetApartmentIds.includes(aid) ? v2Role : null;
        await persistMongoAssignment({
            userId,
            apartmentId: aid,
            roleKey: role,
            email,
            fullName: name,
        });
    }
}

export function isOfficeManager(roleKey = portalState.auth?.effectiveRoleKey) {
    return roleKey === 'property_manager';
}

export function canReviewAudit(roleKey = portalState.auth?.effectiveRoleKey) {
    return isSocietyAdminUser() || roleKey === 'apartment_admin';
}

export function routeIsAllowed() {
    return true;
}

export async function refreshAuthPermissions() {
    return portalState.authPermissions || [];
}
