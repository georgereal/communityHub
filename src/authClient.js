/**
 * Dedicated Supabase auth client (browser-only, not wrapped by API proxy).
 * detectSessionInUrl is OFF — boot exchanges ?code= manually to avoid races.
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const authClient = (SUPABASE_URL && SUPABASE_ANON_KEY)
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
            flowType: 'pkce',
            detectSessionInUrl: false,
            persistSession: true,
            autoRefreshToken: true,
        },
    })
    : null;

let authInitPromise = null;

function hasActiveLedgerOAuthPending() {
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

function logAuth(step, detail = {}) {
    console.log('[auth]', step, detail);
}

/** Exchange OAuth callback (?code= or hash tokens) before the rest of the app boots. */
export async function primeAuthSessionFromUrl() {
    if (!authClient) return { session: null, error: null };

    const search = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const oauthError = search.get('error') || hash.get('error');
    if (oauthError) {
        const message = search.get('error_description') || hash.get('error_description') || oauthError;
        logAuth('oauth-error', { message });
        return { session: null, error: { message } };
    }

    const code = search.get('code');
    if (code) {
        if (hasActiveLedgerOAuthPending()) {
            logAuth('skip-exchange-ledger-pending', {});
            return { session: null, error: null };
        }
        logAuth('exchange-code-start', { hasCode: true });
        const { data, error } = await authClient.auth.exchangeCodeForSession(code);
        if (!error && data?.session) {
            logAuth('exchange-code-ok', { email: data.session.user?.email || null });
            return { session: data.session, error: null };
        }
        logAuth('exchange-code-failed', { message: error?.message || 'unknown' });
        const { data: retry } = await authClient.auth.getSession();
        if (retry?.session) {
            logAuth('exchange-code-retry-session', { email: retry.session.user?.email || null });
            return { session: retry.session, error: null };
        }
        return {
            session: null,
            error: error || { message: 'Google sign-in could not be completed. Try again.' },
        };
    }

    const accessToken = hash.get('access_token');
    if (accessToken) {
        logAuth('hash-token-start', {});
        const refreshToken = hash.get('refresh_token') || '';
        const { data, error } = await authClient.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
        });
        if (!error && data?.session) {
            logAuth('hash-token-ok', { email: data.session.user?.email || null });
            return { session: data.session, error: null };
        }
        logAuth('hash-token-failed', { message: error?.message || 'unknown' });
        return { session: null, error: error || { message: 'Sign-in could not be completed.' } };
    }

    const { data } = await authClient.auth.getSession();
    if (data?.session) {
        logAuth('stored-session', { email: data.session.user?.email || null });
    } else {
        logAuth('no-session', { href: window.location.href });
    }
    return { session: data?.session ?? null, error: null };
}

export function ensureAuthInitialized() {
    if (!authClient) return Promise.resolve({ session: null, error: null });
    if (!authInitPromise) {
        authInitPromise = primeAuthSessionFromUrl();
    }
    return authInitPromise;
}
