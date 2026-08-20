/**
 * Residents MPA boot — cookie session + portalState seed for resident CRUD.
 */
import { portalState } from '../store.js';
import { setActiveApartmentIdForApi } from '../dbClient.js';
import { readMpaCtx, writeMpaCtx, clearMpaCtx } from '../appShell/mpaSession.js';
import { goToLogin } from '../authRedirect.js';

async function fetchJson(path, init = {}) {
    const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
    const res = await fetch(path, {
        credentials: 'include',
        ...init,
        headers,
    });
    let json = {};
    try {
        json = await res.json();
    } catch { /* empty */ }
    if (!res.ok) {
        const err = new Error(json.error || res.statusText || 'Request failed');
        err.status = res.status;
        throw err;
    }
    return json;
}

function seedPortalFromCtx(ctx) {
    portalState.auth = {
        id: ctx.userId || null,
        email: ctx.userEmail || '',
        name: ctx.userName || '',
    };
    portalState.authPermissions = ctx.permissions || [];
    portalState.access = {
        ...(portalState.access || {}),
        apartments: ctx.apartments?.length
            ? ctx.apartments
            : [{ id: ctx.apartmentId, name: ctx.apartmentName || ctx.apartmentId }],
        activeApartmentId: ctx.apartmentId,
        activeUserId: ctx.userId || 'usr-residents',
        users: portalState.access?.users || [],
    };
    portalState.community = {
        ...(portalState.community || {}),
        name: ctx.apartmentName || portalState.community?.name || 'CommunityHub',
    };
    setActiveApartmentIdForApi(ctx.apartmentId);
}

/**
 * @param {{ page?: string }} [opts]
 */
export async function bootResidentsApp(opts = {}) {
    try {
        await fetchJson('/api/auth-session');
    } catch {
        goToLogin('Sign in required.', {
            next: `${window.location.pathname}${window.location.search || ''}`,
        });
        return null;
    }

    let ctx = readMpaCtx();
    const needRefresh = !ctx?.apartmentId || !ctx.permissions?.length;

    if (needRefresh) {
        const boot = await fetchJson(
            `/api/new/workspace-boot${ctx?.apartmentId ? `?apartment_id=${encodeURIComponent(ctx.apartmentId)}` : ''}`,
        );
        const apartments = (boot.apartments || []).map((a) => ({ id: a.id, name: a.name || a.id }));
        const apartmentId = boot.activeApartmentId || apartments[0]?.id || ctx?.apartmentId;
        if (!apartmentId) {
            throw new Error('No society assigned to this account.');
        }
        const apt = apartments.find((a) => a.id === apartmentId);
        ctx = writeMpaCtx({
            apartmentId,
            apartmentName: apt?.name || '',
            userId: boot.profile?.id || boot.user?.id || '',
            userName: boot.profile?.full_name || boot.profile?.name || '',
            userEmail: boot.profile?.email || '',
            permissions: boot.permissions || [],
            apartments,
        });
        if (boot.crudAccess) portalState.crudAccess = boot.crudAccess;
        ctx.effectiveRoleKey = boot.effectiveRoleKey || null;
        ctx.isSystemAdmin = boot.isSystemAdmin === true;
    }

    seedPortalFromCtx(ctx);
    if (ctx.effectiveRoleKey || ctx.isSystemAdmin) {
        portalState.auth = {
            ...(portalState.auth || {}),
            effectiveRoleKey: ctx.effectiveRoleKey || null,
            isSystemAdmin: ctx.isSystemAdmin === true,
        };
    }

    document.documentElement.dataset.mpaApp = '1';
    document.documentElement.dataset.residentsApp = '1';
    document.documentElement.dataset.residentsPage = opts.page || '';

    return ctx;
}

export async function switchResidentsApartment(apartmentId) {
    if (!apartmentId) return;
    const boot = await fetchJson(
        `/api/new/workspace-boot?apartment_id=${encodeURIComponent(apartmentId)}`,
    );
    const apartments = (boot.apartments || []).map((a) => ({ id: a.id, name: a.name || a.id }));
    const apt = apartments.find((a) => a.id === apartmentId);
    const ctx = writeMpaCtx({
        apartmentId,
        apartmentName: apt?.name || '',
        userId: boot.profile?.id || boot.user?.id || '',
        userName: boot.profile?.full_name || boot.profile?.name || '',
        userEmail: boot.profile?.email || '',
        permissions: boot.permissions || [],
        apartments,
    });
    seedPortalFromCtx(ctx);
    window.location.reload();
    return ctx;
}

export { clearMpaCtx };
