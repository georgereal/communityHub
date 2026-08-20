import { portalState, loadStateDomains } from '../store.js';
import { setActiveApartmentIdForApi } from '../dbClient.js';
import { readMpaCtx, writeMpaCtx, clearMpaCtx } from '../appShell/mpaSession.js';
import { goToLogin } from '../authRedirect.js';
import { accessLocks } from '../accessLocks.js';
import { MPA_ROUTE_PATHS } from '../appShell/routes.js';
import { ensureMpaCookieSession } from '../appShell/mpaAuth.js';
import { isNewUi } from '../uiMode.js';

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
        role: portalState.auth?.role,
        effectiveRoleKey: portalState.auth?.effectiveRoleKey,
        isSystemAdmin: portalState.auth?.isSystemAdmin,
    };
    portalState.authPermissions = ctx.permissions || [];
    portalState.access = {
        ...(portalState.access || {}),
        apartments: ctx.apartments?.length
            ? ctx.apartments
            : [{ id: ctx.apartmentId, name: ctx.apartmentName || ctx.apartmentId }],
        activeApartmentId: ctx.apartmentId,
        activeUserId: ctx.userId || 'usr-admin',
        users: Array.isArray(ctx.users) ? ctx.users : [],
    };
    portalState.community = {
        ...(portalState.community || {}),
        name: ctx.apartmentName || portalState.community?.name || 'CommunityHub',
    };
    setActiveApartmentIdForApi(ctx.apartmentId);
}

export async function bootAdminApp({ route = 'an-society' } = {}) {
    const ok = await ensureMpaCookieSession();
    if (!ok) {
        goToLogin('Sign in required.', {
            next: `${window.location.pathname}${window.location.search || ''}`,
        });
        return null;
    }

    let ctx = readMpaCtx();
    const boot = await fetchJson(
        `/api/new/workspace-boot${ctx?.apartmentId ? `?apartment_id=${encodeURIComponent(ctx.apartmentId)}` : ''}`,
    );
    const apartments = (boot.apartments || []).map((a) => ({ id: a.id, name: a.name || a.id }));
    const apartmentId = boot.activeApartmentId || apartments[0]?.id || ctx?.apartmentId;
    if (!apartmentId) throw new Error('No society assigned to this account.');
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

    seedPortalFromCtx(ctx);
    portalState.auth = {
        ...portalState.auth,
        role: boot.profile?.role || portalState.auth.role,
        effectiveRoleKey: boot.effectiveRoleKey || null,
        isSystemAdmin: boot.isSystemAdmin === true,
    };
    if (boot.crudAccess) portalState.crudAccess = boot.crudAccess;
    accessLocks.allowHeavyDomains = true;
    accessLocks.workspaceReady = true;

    try {
        if (isNewUi()) {
            const { refreshFinanceCategoryCatalog } = await import('./api.js');
            await refreshFinanceCategoryCatalog();
        } else {
            await loadStateDomains(['core', 'admin', 'portal', 'property', 'finance']);
        }
    } catch (err) {
        console.warn('[adminApp] domain load:', err);
    }

    document.documentElement.dataset.mpaApp = '1';
    document.documentElement.dataset.adminApp = '1';
    try {
        window.__mpaRoutePaths = MPA_ROUTE_PATHS;
    } catch { /* ignore */ }

    return { ctx, route };
}

export async function switchAdminApartment(apartmentId) {
    if (!apartmentId) return;
    const boot = await fetchJson(
        `/api/new/workspace-boot?apartment_id=${encodeURIComponent(apartmentId)}`,
    );
    const apartments = (boot.apartments || []).map((a) => ({ id: a.id, name: a.name || a.id }));
    const apt = apartments.find((a) => a.id === apartmentId);
    writeMpaCtx({
        apartmentId,
        apartmentName: apt?.name || '',
        userId: boot.profile?.id || boot.user?.id || '',
        userName: boot.profile?.full_name || boot.profile?.name || '',
        userEmail: boot.profile?.email || '',
        permissions: boot.permissions || [],
        apartments,
    });
    window.location.reload();
}

export { clearMpaCtx };
