/** Spreadsheet / ledger OAuth markers — must not interfere with app sign-in. */

export const LEDGER_OAUTH_PENDING_KEYS = [
    'ledger_oauth_pending',
    'google_service_oauth_pending',
    'ms_oauth_pending',
    'ms_web_oauth_pending',
    'ms_service_oauth_pending',
];

export function hasLedgerOAuthPending() {
    try {
        if (sessionStorage.getItem('ledger_oauth_pending')) return true;
        if (sessionStorage.getItem('google_service_oauth_pending')) return true;
        if (sessionStorage.getItem('ms_web_oauth_pending')) return true;
        if (sessionStorage.getItem('ms_service_oauth_pending')) return true;
        const msPending = sessionStorage.getItem('ms_oauth_pending') || localStorage.getItem('ms_oauth_pending');
        if (msPending && sessionStorage.getItem('ledger_oauth_pkce_verifier')) return true;
        return false;
    } catch {
        return false;
    }
}

export function clearLedgerOAuthPendingMarkers() {
    try {
        LEDGER_OAUTH_PENDING_KEYS.forEach((key) => {
            sessionStorage.removeItem(key);
            localStorage.removeItem(key);
        });
        sessionStorage.removeItem('ledger_oauth_pkce_verifier');
        sessionStorage.removeItem('ledger_oauth_return_hash');
    } catch {
        /* ignore */
    }
}

/** Clear stale ledger markers before app auth redirect handling. */
export function prepareAuthCallback() {
    clearLedgerOAuthPendingMarkers();
}

/** @deprecated Use prepareAuthCallback */
export function prepareSupabaseAuthCallback() {
    prepareAuthCallback();
}
