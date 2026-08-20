/**
 * Shared MPA session context (sessionStorage) for non-finance multi-page apps.
 * Stores apartment + user + full permission list for shell chrome and /api calls.
 */
const CTX_KEY = 'ch_mpa_ctx';

export function readMpaCtx() {
    try {
        const raw = sessionStorage.getItem(CTX_KEY);
        if (!raw) return null;
        const ctx = JSON.parse(raw);
        if (!ctx?.apartmentId) return null;
        return {
            apartmentId: String(ctx.apartmentId),
            apartmentName: ctx.apartmentName ? String(ctx.apartmentName) : '',
            userId: ctx.userId ? String(ctx.userId) : '',
            userName: ctx.userName ? String(ctx.userName) : '',
            userEmail: ctx.userEmail ? String(ctx.userEmail) : '',
            permissions: Array.isArray(ctx.permissions) ? ctx.permissions.map(String) : [],
            apartments: Array.isArray(ctx.apartments) ? ctx.apartments : [],
            updatedAt: ctx.updatedAt || null,
        };
    } catch {
        return null;
    }
}

export function writeMpaCtx(partial = {}) {
    const prev = readMpaCtx() || {};
    const next = {
        apartmentId: partial.apartmentId ?? prev.apartmentId ?? null,
        apartmentName: partial.apartmentName ?? prev.apartmentName ?? '',
        userId: partial.userId ?? prev.userId ?? '',
        userName: partial.userName ?? prev.userName ?? '',
        userEmail: partial.userEmail ?? prev.userEmail ?? '',
        permissions: Array.isArray(partial.permissions)
            ? partial.permissions.map(String)
            : (prev.permissions || []),
        apartments: Array.isArray(partial.apartments)
            ? partial.apartments
            : (prev.apartments || []),
        updatedAt: new Date().toISOString(),
    };
    if (!next.apartmentId) {
        throw new Error('writeMpaCtx requires apartmentId.');
    }
    sessionStorage.setItem(CTX_KEY, JSON.stringify(next));
    return next;
}

export function clearMpaCtx() {
    try {
        sessionStorage.removeItem(CTX_KEY);
    } catch { /* ignore */ }
}

/** Map SPA portalState → MPA ctx before navigating to an MPA page. */
export function writeMpaCtxFromPortal(portalState) {
    const aptId = portalState?.access?.activeApartmentId;
    if (!aptId) throw new Error('No active apartment to write MPA context.');
    const apt = (portalState.access?.apartments || []).find((a) => a.id === aptId);
    const perms = Array.isArray(portalState.authPermissions) ? portalState.authPermissions : [];
    const auth = portalState.auth || {};
    return writeMpaCtx({
        apartmentId: aptId,
        apartmentName: apt?.name || portalState.community?.name || '',
        userId: auth.id || portalState.access?.activeUserId || '',
        userName: auth.name || auth.full_name || auth.email || '',
        userEmail: auth.email || '',
        permissions: perms,
        apartments: (portalState.access?.apartments || []).map((a) => ({
            id: a.id,
            name: a.name || a.id,
        })),
    });
}
