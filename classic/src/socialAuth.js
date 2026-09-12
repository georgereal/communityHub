/**
 * Social login (OAuth) via Firebase Auth for app sign-in.
 * Configure providers in Firebase Console → Authentication → Sign-in method.
 */
import { clearLedgerOAuthPendingMarkers } from '@auth/oauthMarkers.js';
import {
    getAuthRedirectUrl,
    stashOAuthNextFromUrl,
} from '@auth/oauthRedirect.js';
import { authClient, ensureAuthInitialized, resetAuthInit } from '@auth/authClient.js';

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

export { getAuthRedirectUrl };

/** @deprecated Firebase uses popup/redirect; kept for login page URL cleanup. */
export function isSupabaseAuthRedirect() {
    return false;
}

export function clearStaleLedgerOAuthMarkersForSupabaseAuth() {
    clearLedgerOAuthPendingMarkers();
}

export function cleanAuthRedirectFromUrl() {
    const hash = window.location.hash || '';
    const keepHash = hash && !hash.includes('access_token=') ? hash : '';
    const params = new URLSearchParams(window.location.search);
    params.delete('code');
    params.delete('error');
    params.delete('error_description');
    params.delete('apiKey');
    params.delete('mode');
    params.delete('oobCode');
    const q = params.toString();
    window.history.replaceState({}, document.title, `${window.location.pathname}${q ? `?${q}` : ''}${keepHash}`);
}

/** Wait for Firebase session after OAuth redirect or stored session. */
export async function waitForBootAuthSession(_unused, { attempts = 12, delayMs = 250 } = {}) {
    if (!authClient) return { session: null, error: null };

    clearStaleLedgerOAuthMarkersForSupabaseAuth();

    const primed = await ensureAuthInitialized();
    if (primed.session) {
        cleanAuthRedirectFromUrl();
        return primed;
    }
    if (primed.error) {
        cleanAuthRedirectFromUrl();
        return primed;
    }

    for (let i = 0; i < attempts; i++) {
        const { data } = await authClient.auth.getSession();
        if (data?.session) {
            console.log('[auth] session-ready-after-wait', {
                email: data.session.user?.email || null,
                attempt: i,
            });
            cleanAuthRedirectFromUrl();
            return { session: data.session, error: null };
        }
        if (i < attempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }

    console.warn('[auth] boot-session-missing', { href: window.location.href });
    return { session: null, error: null };
}

export const NO_SOCIETY_ACCESS_RESIDENT_MESSAGE =
    'You are signed in. Choose your society below — an admin will approve access and assign your role or flat link.';

export const NO_SOCIETY_ACCESS_OFFICE_MESSAGE =
    'You are signed in. Choose your society below — a society administrator will assign your role after approval.';

export async function signInWithSocialProvider(_unused, provider) {
    if (!authClient) {
        return { data: null, error: { message: 'Firebase is not configured.' } };
    }

    stashOAuthNextFromUrl();
    clearLedgerOAuthPendingMarkers();
    resetAuthInit();

    console.log('[auth] oauth-start', { provider, redirectTo: getAuthRedirectUrl() });
    return authClient.auth.signInWithOAuth({
        provider,
        options: { useRedirect: false },
    });
}
