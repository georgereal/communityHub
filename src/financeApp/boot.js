/**
 * Finance MPA boot — cookie session + slim portalState for Finance-New UI modules.
 */
import { portalState } from '../store.js';
import { setActiveApartmentIdForApi } from '../dbClient.js';
import { readFinanceCtx, writeFinanceCtx, clearFinanceCtx } from './session.js';
import { goToLogin } from '../authRedirect.js';
import { restoreMpaNavPref } from '../appShell/navPref.js';

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
        activeUserId: ctx.userId || 'usr-finance',
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
export async function bootFinanceApp(opts = {}) {
    document.documentElement.dataset.financeApp = '1';
    document.documentElement.dataset.financePage = opts.page || '';
    restoreMpaNavPref();

    try {
        await fetchJson('/api/auth-session');
    } catch {
        goToLogin('Sign in required.', {
            next: `${window.location.pathname}${window.location.search || ''}`,
        });
        return null;
    }

    let ctx = readFinanceCtx();
    const needRefresh = !ctx?.apartmentId || !ctx.permissions?.length || ctx.permScope !== 'all';

    if (needRefresh) {
        const boot = await fetchJson(
            `/api/workspace-boot${ctx?.apartmentId ? `?apartment_id=${encodeURIComponent(ctx.apartmentId)}` : ''}`,
        );
        const apartments = (boot.apartments || []).map((a) => ({ id: a.id, name: a.name || a.id }));
        const apartmentId = boot.activeApartmentId || apartments[0]?.id || ctx?.apartmentId;
        if (!apartmentId) {
            throw new Error('No society assigned to this account.');
        }
        const apt = apartments.find((a) => a.id === apartmentId);
        ctx = writeFinanceCtx({
            apartmentId,
            apartmentName: apt?.name || '',
            userId: boot.profile?.id || boot.user?.id || '',
            userName: boot.profile?.full_name || boot.profile?.name || '',
            userEmail: boot.profile?.email || '',
            permissions: boot.permissions || [],
            apartments,
        });
    }

    seedPortalFromCtx(ctx);
    document.documentElement.dataset.financePage = opts.page || '';

    const { initFinancePackCache } = await import('../financeNew/packCache.js');
    initFinancePackCache(ctx.apartmentId);

    return ctx;
}

export async function switchFinanceApartment(apartmentId) {
    if (!apartmentId) return;
    const prev = readFinanceCtx();
    try {
        const { clearFinancePackCache } = await import('../financeNew/packCache.js');
        clearFinancePackCache(prev?.apartmentId);
        clearFinancePackCache(apartmentId);
    } catch { /* ignore */ }
    const boot = await fetchJson(
        `/api/workspace-boot?apartment_id=${encodeURIComponent(apartmentId)}`,
    );
    const apartments = (boot.apartments || []).map((a) => ({ id: a.id, name: a.name || a.id }));
    const apt = apartments.find((a) => a.id === apartmentId);
    writeFinanceCtx({
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

export { clearFinanceCtx, readFinanceCtx };
