/**
 * Runtime page access resolution (no navigation import — avoids circular deps).
 */
import { portalState } from './store.js';

const ROLE_V1_TO_V2 = {
    admin: 'apartment_admin',
    apartment_admin: 'apartment_admin',
    property_manager: 'property_manager',
    accounts_manager: 'accounts_manager',
    security: 'security',
    resident_viewer: 'resident_viewer',
};

function activeRoleKey() {
    if (portalState.auth?.effectiveRoleKey) return portalState.auth.effectiveRoleKey;
    const v1 = portalState.auth?.role;
    return ROLE_V1_TO_V2[v1] || v1 || 'resident_viewer';
}

function isApartmentAdminUser() {
    return portalState.auth?.effectiveRoleKey === 'apartment_admin'
        || portalState.auth?.role === 'admin';
}

/** @returns {boolean|null} null = inherit permission check */
export function resolvePageAccess(route) {
    const userMap = portalState.pageAccess?.user || {};
    if (userMap[route] === 'deny') return false;
    if (userMap[route] === 'grant') return true;

    if (portalState.auth?.isSystemAdmin || portalState.auth?.effectiveRoleKey === 'system_admin') {
        return null;
    }

    if (!isApartmentAdminUser()) {
        const roleKey = activeRoleKey();
        const societyMap = portalState.pageAccess?.societyRole?.[roleKey];
        if (societyMap && Object.prototype.hasOwnProperty.call(societyMap, route)) {
            return societyMap[route];
        }
    }
    return null;
}

export function pageAccessBlocksRoute(route) {
    return resolvePageAccess(route) === false;
}

export function pageAccessGrantsRoute(route) {
    return resolvePageAccess(route) === true;
}
