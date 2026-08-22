/**
 * Mongo workspace boot for New MPAs. Auth JWT only; identity/RBAC from /api/new/workspace-boot.
 */
import { portalState } from '../store.js';
import { setActiveApartmentIdForApi } from '../dbClient.js';

const BOOT_TIMEOUT_MS = 20_000;

export async function fetchWorkspaceBoot(apartmentId = null) {
    const q = apartmentId ? `?apartment_id=${encodeURIComponent(apartmentId)}` : '';
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl
        ? setTimeout(() => ctrl.abort(), BOOT_TIMEOUT_MS)
        : null;
    let res;
    try {
        res = await fetch(`/api/new/workspace-boot${q}`, {
            credentials: 'include',
            signal: ctrl?.signal,
        });
    } catch (err) {
        if (err?.name === 'AbortError') {
            throw new Error('Workspace boot timed out. Please refresh and try again.');
        }
        throw err;
    } finally {
        if (timer) clearTimeout(timer);
    }
    let json = {};
    try {
        json = await res.json();
    } catch { /* empty */ }
    if (!res.ok) {
        const err = new Error(json.error || res.statusText || 'Workspace boot failed');
        err.status = res.status;
        throw err;
    }
    return json;
}

export function apartmentsFromBoot(boot, fallbackId) {
    return (boot.apartments || []).map((a) => ({ id: a.id, name: a.name || a.id }))
        .filter((a) => a.id)
        .concat(fallbackId && !(boot.apartments || []).some((a) => a.id === fallbackId)
            ? [{ id: fallbackId, name: fallbackId }]
            : []);
}

export function sessionFieldsFromBoot(boot, apartmentId, apartments) {
    const apt = apartments.find((a) => a.id === apartmentId);
    return {
        apartmentId,
        apartmentName: apt?.name || '',
        userId: boot.profile?.id || boot.user?.id || '',
        userName: boot.profile?.full_name || boot.profile?.name || '',
        userEmail: boot.profile?.email || '',
        permissions: boot.permissions || [],
        apartments,
        effectiveRoleKey: boot.effectiveRoleKey || null,
        isSystemAdmin: boot.isSystemAdmin === true,
    };
}

export function applyMongoBoot(boot, ctx) {
    portalState.auth = {
        id: ctx.userId || boot.profile?.id || null,
        email: ctx.userEmail || boot.profile?.email || '',
        name: ctx.userName || boot.profile?.full_name || '',
        role: boot.profile?.role || portalState.auth?.role,
        effectiveRoleKey: boot.effectiveRoleKey || ctx.effectiveRoleKey || null,
        isSystemAdmin: boot.isSystemAdmin === true || ctx.isSystemAdmin === true,
    };
    portalState.authPermissions = boot.permissions || ctx.permissions || [];
    portalState.access = {
        ...(portalState.access || {}),
        apartments: ctx.apartments?.length
            ? ctx.apartments
            : [{ id: ctx.apartmentId, name: ctx.apartmentName || ctx.apartmentId }],
        activeApartmentId: ctx.apartmentId,
        activeUserId: ctx.userId || portalState.access?.activeUserId,
        users: Array.isArray(ctx.users) ? ctx.users : (portalState.access?.users || []),
    };
    portalState.community = {
        ...(portalState.community || {}),
        name: ctx.apartmentName || portalState.community?.name || 'CommunityHub',
    };
    if (boot.crudAccess) portalState.crudAccess = boot.crudAccess;
    if (boot.moduleAccess) portalState.moduleAccess = boot.moduleAccess;
    if (boot.pageAccess) portalState.pageAccess = boot.pageAccess;
    setActiveApartmentIdForApi(ctx.apartmentId);
    void import('../activityAudit.js')
        .then((m) => m.installActivityOutboxFlushers())
        .catch(() => {});
    return ctx;
}
