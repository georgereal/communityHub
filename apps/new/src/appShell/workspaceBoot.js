/**
 * Mongo workspace hydrate for New MPAs.
 * Cookie/JWT proves identity on every /api call. workspace-boot is only for
 * client chrome (societies + permissions) and is cached in sessionStorage —
 * fetched on login (cold cache) or society switch, not on every page load.
 */
import { portalState } from '../store.js';
import { setActiveApartmentIdForApi } from '../dbClient.js';
import { readMpaCtx, writeMpaCtx, clearMpaCtx } from './mpaSession.js';

const BOOT_TIMEOUT_MS = 20_000;
const BOOT_CACHE_KEY = 'ch_workspace_boot_v1';

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

export function readCachedWorkspaceBoot() {
    try {
        const raw = sessionStorage.getItem(BOOT_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed?.boot?.profile?.id || !parsed?.apartmentId) return null;
        return parsed;
    } catch {
        return null;
    }
}

export function writeCachedWorkspaceBoot(boot, apartmentId) {
    if (!boot?.profile?.id || !apartmentId) return;
    try {
        sessionStorage.setItem(BOOT_CACHE_KEY, JSON.stringify({
            apartmentId: String(apartmentId),
            userId: String(boot.profile.id),
            boot,
            cachedAt: new Date().toISOString(),
        }));
    } catch { /* ignore quota */ }
}

export function clearCachedWorkspaceBoot() {
    try {
        sessionStorage.removeItem(BOOT_CACHE_KEY);
    } catch { /* ignore */ }
}

function cacheMatchesHint(cached, apartmentHint) {
    if (!cached) return false;
    if (!apartmentHint) return true;
    return String(cached.apartmentId) === String(apartmentHint);
}

async function syncCtxStores(fields) {
    writeMpaCtx(fields);
    try {
        const { writeFinanceCtx } = await import('../financeApp/session.js');
        writeFinanceCtx(fields);
    } catch { /* finance session optional */ }
}

/**
 * Hydrate portalState + session ctx from cache, or fetch workspace-boot once.
 * @param {{ apartmentHint?: string|null, force?: boolean }} opts
 *   force — society switch / explicit refresh (always hits network)
 */
export async function hydrateWorkspaceSession({ apartmentHint = null, force = false } = {}) {
    const hint = apartmentHint
        || readMpaCtx()?.apartmentId
        || null;

    let boot = null;
    let fromCache = false;

    if (!force) {
        const cached = readCachedWorkspaceBoot();
        if (cached && cacheMatchesHint(cached, hint)) {
            boot = cached.boot;
            fromCache = true;
        }
    }

    if (!boot) {
        boot = await fetchWorkspaceBoot(force ? (apartmentHint || hint) : hint);
        fromCache = false;
    }

    const apartments = apartmentsFromBoot(boot, hint);
    const apartmentId = (force && apartmentHint)
        ? apartmentHint
        : (boot.activeApartmentId || apartments[0]?.id || hint);
    if (!apartmentId) {
        throw new Error('No society assigned to this account.');
    }

    // If we forced a different society, ensure boot payload matches (network path already queried it).
    if (!fromCache) {
        writeCachedWorkspaceBoot(boot, apartmentId);
    } else if (String(boot.activeApartmentId || '') !== String(apartmentId)) {
        // Cache for this apartment but active id drift — keep cached apartmentId.
    }

    const ctx = sessionFieldsFromBoot(boot, apartmentId, apartments);
    await syncCtxStores(ctx);
    applyMongoBoot(boot, ctx);

    return { boot, ctx, apartmentId, fromCache };
}

/** Clear chrome session caches (logout). Does not clear the httpOnly cookie by itself. */
export function clearWorkspaceSessionCaches() {
    clearCachedWorkspaceBoot();
    clearMpaCtx();
    try {
        sessionStorage.removeItem('ch_finance_ctx');
    } catch { /* ignore */ }
}
