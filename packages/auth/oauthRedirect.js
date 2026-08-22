/** OAuth redirect URL + post-login destination (avoid query strings in Supabase allowlist). */

export const AUTH_OAUTH_NEXT_KEY = 'ch_auth_oauth_next';

export function getSupabaseAuthRedirectUrl() {
    return `${window.location.origin}/login.html`;
}

export function stashOAuthNextFromUrl() {
    try {
        const next = new URLSearchParams(window.location.search).get('next') || '';
        if (next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login')) {
            sessionStorage.setItem(AUTH_OAUTH_NEXT_KEY, next);
        }
    } catch {
        /* ignore */
    }
}

export function consumeOAuthNext() {
    try {
        const next = sessionStorage.getItem(AUTH_OAUTH_NEXT_KEY) || '';
        sessionStorage.removeItem(AUTH_OAUTH_NEXT_KEY);
        if (next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login')) {
            return next;
        }
    } catch {
        /* ignore */
    }
    return null;
}
