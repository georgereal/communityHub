/**
 * Cookie session for MPA pages. The SPA stores the user in Supabase localStorage;
 * /api/* uses an httpOnly cookie. Refresh the access token before posting it so
 * /api/state and /api/db are not called with an expired JWT.
 */
import { ensureAuthInitialized, authClient } from '../authClient.js';

function tokenExpiresSoon(token, skewMs = 60_000) {
    if (!token) return true;
    try {
        const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        const expMs = Number(payload.exp || 0) * 1000;
        return !expMs || expMs <= Date.now() + skewMs;
    } catch {
        return true;
    }
}

async function getAccessToken({ refreshIfNeeded = true } = {}) {
    const primed = await ensureAuthInitialized();
    let token = primed?.session?.access_token || '';
    if (!authClient) return token;

    if (refreshIfNeeded && (!token || tokenExpiresSoon(token))) {
        try {
            const { data, error } = await authClient.auth.refreshSession();
            if (!error && data?.session?.access_token) return data.session.access_token;
        } catch { /* fall through */ }
    }

    if (token) return token;
    try {
        const { data } = await authClient.auth.getSession() || {};
        return data?.session?.access_token || '';
    } catch {
        return '';
    }
}

async function postCookie(accessToken) {
    const res = await fetch('/api/auth-session', {
        method: 'POST',
        credentials: 'include',
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
        const err = new Error('Could not establish session.');
        err.status = res.status;
        throw err;
    }
}

/**
 * @returns {Promise<boolean>} true if a backend cookie session is available
 */
export async function ensureMpaCookieSession() {
    const token = await getAccessToken({ refreshIfNeeded: true });
    if (token) {
        try {
            await postCookie(token);
            return true;
        } catch { /* cookie POST failed — try existing cookie */ }
    }

    try {
        const res = await fetch('/api/auth-session', { credentials: 'include' });
        if (res.ok) return true;
    } catch { /* ignore */ }

    return false;
}
