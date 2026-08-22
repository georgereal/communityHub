/**
 * Supabase social login (OAuth) for app sign-in.
 * Configure providers in Supabase Dashboard → Authentication → Providers.
 */
import {
    clearLedgerOAuthPendingMarkers,
    prepareSupabaseAuthCallback,
} from '@auth/oauthMarkers.js';
import {
    getSupabaseAuthRedirectUrl,
    stashOAuthNextFromUrl,
} from '@auth/oauthRedirect.js';

export const SOCIAL_AUTH_PROVIDERS = [
    { id: 'google', label: 'Google', iconClass: 'fa-brands fa-google' },
    { id: 'github', label: 'GitHub', iconClass: 'fa-brands fa-github' },
    { id: 'apple', label: 'Apple', iconClass: 'fa-brands fa-apple' },
    { id: 'facebook', label: 'Facebook', iconClass: 'fa-brands fa-facebook' },
    { id: 'azure', label: 'Microsoft', iconClass: 'fa-brands fa-microsoft' },
];

function parseProviderList(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const ids = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!ids.length) return [];
    const allowed = new Set(SOCIAL_AUTH_PROVIDERS.map((p) => p.id));
    return SOCIAL_AUTH_PROVIDERS.filter((p) => ids.includes(p.id) && allowed.has(p.id));
}

export function getEnabledSocialProviders() {
    const configured = parseProviderList(import.meta.env.VITE_SOCIAL_AUTH_PROVIDERS);
    if (configured) return configured;
    return SOCIAL_AUTH_PROVIDERS.filter((p) => ['google', 'github'].includes(p.id));
}

export function getAuthRedirectUrl() {
    return getSupabaseAuthRedirectUrl();
}

/** True when URL looks like a Supabase Auth PKCE callback (not ledger spreadsheet OAuth). */
export function isSupabaseAuthRedirect() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code) return false;
    prepareSupabaseAuthCallback();
    return true;
}

export function clearStaleLedgerOAuthMarkersForSupabaseAuth() {
    prepareSupabaseAuthCallback();
}

export function cleanAuthRedirectFromUrl() {
    const hash = window.location.hash || '';
    const keepHash = hash && !hash.includes('access_token=') ? hash : '';
    const params = new URLSearchParams(window.location.search);
    params.delete('code');
    params.delete('error');
    params.delete('error_description');
    const q = params.toString();
    window.history.replaceState({}, document.title, `${window.location.pathname}${q ? `?${q}` : ''}${keepHash}`);
}

/** Exchange PKCE code (or read session if auto-detect already ran). */
export async function resolveSessionAfterOAuthRedirect(supabase) {
    if (!supabase) {
        return { session: null, error: { message: 'Supabase is not configured.' } };
    }

    clearStaleLedgerOAuthMarkersForSupabaseAuth();

    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get('error');
    if (oauthError) {
        return {
            session: null,
            error: { message: params.get('error_description') || oauthError },
        };
    }

    const code = params.get('code');
    if (!code) {
        const { data } = await supabase.auth.getSession();
        return { session: data?.session ?? null, error: null };
    }

    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data?.session) {
        return { session: data.session, error: null };
    }

    // Auto-detect may have consumed the code before boot ran.
    const { data: retry } = await supabase.auth.getSession();
    if (retry?.session) {
        return { session: retry.session, error: null };
    }

    return {
        session: null,
        error: error || { message: 'Social sign-in did not complete. Please try again.' },
    };
}

import { authClient, ensureAuthInitialized, resetAuthInit } from '@auth/authClient.js';

/** Wait for Supabase session after OAuth redirect or stored session. */
export async function waitForBootAuthSession(supabase, { attempts = 12, delayMs = 250 } = {}) {
    const client = authClient || supabase;
    if (!client) return { session: null, error: null };

    clearStaleLedgerOAuthMarkersForSupabaseAuth();

    const params = new URLSearchParams(window.location.search);
    const hasOAuthCode = !!params.get('code');
    const hasHashToken = window.location.hash.includes('access_token=');

    const primed = await ensureAuthInitialized();
    if (primed.session) {
        if (hasOAuthCode || hasHashToken) cleanAuthRedirectFromUrl();
        return primed;
    }
    if (primed.error) {
        if (hasOAuthCode || hasHashToken) cleanAuthRedirectFromUrl();
        return primed;
    }

    for (let i = 0; i < attempts; i++) {
        const { data } = await client.auth.getSession();
        if (data?.session) {
            console.log('[auth] session-ready-after-wait', { email: data.session.user?.email || null, attempt: i });
            if (hasOAuthCode || hasHashToken) cleanAuthRedirectFromUrl();
            return { session: data.session, error: null };
        }
        if (i < attempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }

    console.warn('[auth] boot-session-missing', {
        hasOAuthCode,
        hasHashToken,
        href: window.location.href,
    });
    return { session: null, error: null };
}

export const NO_SOCIETY_ACCESS_RESIDENT_MESSAGE =
    'You are signed in. Choose your society below — an admin will approve access and assign your role or flat link.';

export const NO_SOCIETY_ACCESS_OFFICE_MESSAGE =
    'You are signed in. Choose your society below — a society administrator will assign your role after approval.';

export async function signInWithSocialProvider(supabase, provider) {
    const client = authClient || supabase;
    if (!client) {
        return { data: null, error: { message: 'Supabase is not configured.' } };
    }

    stashOAuthNextFromUrl();
    clearLedgerOAuthPendingMarkers();
    resetAuthInit();

    const options = {
        redirectTo: getAuthRedirectUrl(),
    };

    if (provider === 'google') {
        options.queryParams = {
            access_type: 'offline',
            prompt: 'consent',
        };
    }

    console.log('[auth] oauth-start', { provider, redirectTo: options.redirectTo });
    const result = await client.auth.signInWithOAuth({ provider, options });
    if (!result.error && result.data?.url) {
        window.location.assign(result.data.url);
    }
    return result;
}
