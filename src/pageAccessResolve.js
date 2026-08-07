/**
 * Runtime page access resolution (no navigation import — avoids circular deps).
 */
import { portalState } from './store.js';

const ROLE_V1_TO_V2 = {
    admin: 'society_admin',
    society_admin: 'society_admin',
    apartment_admin: 'apartment_admin',
    property_manager: 'property_manager',
    accounts_manager: 'accounts_manager',
    office_staff: 'office_staff',
    security: 'security',
    resident_viewer: 'resident_viewer',
};

function activeRoleKey() {
    if (portalState.auth?.effectiveRoleKey) return portalState.auth.effectiveRoleKey;
    const v1 = portalState.auth?.role;
    return ROLE_V1_TO_V2[v1] || v1 || 'resident_viewer';
}

function isFullSocietyAdminUser() {
    return portalState.auth?.effectiveRoleKey === 'society_admin'
        || (portalState.auth?.role === 'admin' && portalState.auth?.effectiveRoleKey !== 'apartment_admin');
}

/** @returns {boolean|null} null = inherit permission check; true grant never elevates above role perms */
export function resolvePageAccess(route) {
    const userMap = portalState.pageAccess?.user || {};
    if (userMap[route] === 'deny') return false;
    // Explicit grant only removes a society-role deny — callers must still pass permission checks
    if (userMap[route] === 'grant') return null;

    if (portalState.auth?.isSystemAdmin || portalState.auth?.effectiveRoleKey === 'system_admin') {
        return null;
    }

    if (!isFullSocietyAdminUser()) {
        const roleKey = activeRoleKey();
        const societyMap = portalState.pageAccess?.societyRole?.[roleKey];
        if (societyMap && Object.prototype.hasOwnProperty.call(societyMap, route)) {
            // Only deny is enforced; true/"grant" cannot elevate above role permissions
            const v = societyMap[route];
            if (v === false || v === 'deny') return false;
            return null;
        }
    }
    return null;
}

export function pageAccessBlocksRoute(route) {
    return resolvePageAccess(route) === false;
}

/** @deprecated Grants must not bypass RBAC — always false for elevation checks. */
export function pageAccessGrantsRoute(_route) {
    return false;
}
