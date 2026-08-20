/**
 * Shared locks for society boot / apartment switching.
 * Kept on globalThis so Vite HMR does not desync sticky flags from module-local Sets.
 */
export const accessLocks = globalThis.__sentryAccessLocks || (globalThis.__sentryAccessLocks = {});
for (const [key, value] of Object.entries({
    setActiveInflight: null,
    setActiveInflightId: null,
    syncAccessInflight: null,
    directoryInflight: null,
    resolveInflight: null,
    resolveInflightKey: null,
    workspaceBootInflight: null,
    workspaceBootInflightKey: null,
    lastWrittenLastApartmentId: null,
    suppressApartmentChangeDepth: 0,
    societyHydrating: false,
    readyApartmentId: null,
    workspaceReady: false,
    allowHeavyDomains: false,
    notificationsForApt: null,
    directoryForApt: null,
    navAbortController: null,
    routeGeneration: 0,
})) {
    if (!(key in accessLocks)) accessLocks[key] = value;
}
globalThis.__sentryAccessLocks = accessLocks;

export function isSocietyHydrating() {
    return !!accessLocks.societyHydrating || !!accessLocks.syncAccessInflight || !!accessLocks.setActiveInflight;
}

export function withApartmentSelectSuppressed(fn) {
    accessLocks.suppressApartmentChangeDepth = (accessLocks.suppressApartmentChangeDepth || 0) + 1;
    try {
        return fn();
    } finally {
        accessLocks.suppressApartmentChangeDepth = Math.max(
            0,
            (accessLocks.suppressApartmentChangeDepth || 1) - 1,
        );
    }
}

/** Hold select suppress across an async apartment switch / boot window. */
export async function withApartmentSelectSuppressedAsync(fn) {
    accessLocks.suppressApartmentChangeDepth = (accessLocks.suppressApartmentChangeDepth || 0) + 1;
    try {
        return await fn();
    } finally {
        accessLocks.suppressApartmentChangeDepth = Math.max(
            0,
            (accessLocks.suppressApartmentChangeDepth || 1) - 1,
        );
    }
}

export function isApartmentSelectSuppressed() {
    return (accessLocks.suppressApartmentChangeDepth || 0) > 0 || isSocietyHydrating();
}

export function invalidateWorkspaceAccess() {
    accessLocks.workspaceReady = false;
    accessLocks.readyApartmentId = null;
    accessLocks.notificationsForApt = null;
    accessLocks.directoryForApt = null;
    // Do NOT clear allowHeavyDomains here — that re-opens the boot gate mid-session
    // and causes Accounts to paint empty / re-fetch forever.
    accessLocks.lastWrittenLastApartmentId = null;
}

export function beginApartmentSwitch(apartmentId) {
    accessLocks.workspaceReady = false;
    accessLocks.readyApartmentId = null;
    accessLocks.notificationsForApt = null;
    accessLocks.directoryForApt = null;
    accessLocks.lastWrittenLastApartmentId = null;
    void apartmentId;
}

/** Abort prior route/dashboard loads when the user navigates away. */
export function beginNavigation() {
    try {
        accessLocks.navAbortController?.abort();
    } catch { /* ignore */ }
    accessLocks.navAbortController = new AbortController();
    accessLocks.routeGeneration = (accessLocks.routeGeneration || 0) + 1;
    return {
        signal: accessLocks.navAbortController.signal,
        generation: accessLocks.routeGeneration,
    };
}

export function isNavigationCurrent(generation) {
    return generation === accessLocks.routeGeneration;
}
