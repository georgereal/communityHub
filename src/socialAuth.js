/**
 * Supabase social login (OAuth) for app sign-in.
 * Configure providers in Supabase Dashboard → Authentication → Providers.
 */

const LEDGER_OAUTH_PENDING_KEYS = [
    'ledger_oauth_pending',
    'google_service_oauth_pending',
    'ms_oauth_pending',
    'ms_web_oauth_pending',
    'ms_service_oauth_pending',
];

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
    const hash = window.location.hash || '';
    return `${window.location.origin}${window.location.pathname}${hash}`;
}

function hasLedgerOAuthPending() {
    try {
        return LEDGER_OAUTH_PENDING_KEYS.some((key) => sessionStorage.getItem(key) || localStorage.getItem(key));
    } catch {
        return false;
    }
}

/** True when URL looks like a Supabase Auth PKCE callback (not ledger spreadsheet OAuth). */
export function isSupabaseAuthRedirect() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code) return false;
    if (hasLedgerOAuthPending()) return false;
    return true;
}

export function cleanAuthRedirectFromUrl() {
    const hash = window.location.hash || '';
    window.history.replaceState({}, document.title, `${window.location.pathname}${hash}`);
}

export async function signInWithSocialProvider(supabase, provider) {
    if (!supabase) {
        return { data: null, error: { message: 'Supabase is not configured.' } };
    }

    const options = {
        redirectTo: getAuthRedirectUrl(),
    };

    if (provider === 'google') {
        options.queryParams = {
            access_type: 'offline',
            prompt: 'consent',
        };
    }

    return supabase.auth.signInWithOAuth({ provider, options });
}
