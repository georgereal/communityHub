/**
 * Shared locks for MPA boot / apartment switching.
 */
export const accessLocks = globalThis.__sentryAccessLocks || (globalThis.__sentryAccessLocks = {});
for (const [key, value] of Object.entries({
    workspaceReady: false,
    allowHeavyDomains: false,
})) {
    if (!(key in accessLocks)) accessLocks[key] = value;
}
globalThis.__sentryAccessLocks = accessLocks;
