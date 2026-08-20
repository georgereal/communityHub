/**
 * Cookie session for MPA pages. The SPA stores the user in Supabase localStorage;
 * /api/* uses an httpOnly cookie. If the cookie is missing, restore it from the
 * browser session instead of bouncing through /login.
 */
import { ensureAuthInitialized, authClient } from '../authClient.js';

async function getAccessToken() {
    const primed = await ensureAuthInitialized();
    if (primed?.session?.access_token) return primed.session.access_token;
    try {
        const { data } = await authClient?.auth.getSession?.() || {};
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
    try {
        const res = await fetch('/api/auth-session', { credentials: 'include' });
        if (res.ok) return true;
    } catch { /* restore from supabase below */ }

    const token = await getAccessToken();
    if (!token) return false;
    try {
        await postCookie(token);
        return true;
    } catch {
        return false;
    }
}
