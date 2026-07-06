/**
 * Per-society OAuth app config + per-user SSO connections (stored in Supabase, not env/public)
 */
import { PublicClientApplication } from '@azure/msal-browser';
import { portalState, supabase, pullState } from './store.js';
import { proxyExternalRequest } from './dbClient.js';
import { hasClientPermission } from './rbac.js';

export const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
/** Excel workbook usedRange requires Files.ReadWrite on delegated accounts (MS Graph). */
export const MS_FILES_SCOPE = 'Files.ReadWrite';
export const MS_SCOPES = [MS_FILES_SCOPE, 'User.Read', 'offline_access'];

/** Blank callback page for MSAL popup — must not load the main app bundle. */
export const MICROSOFT_AUTH_PATH = '/microsoft-auth.html';

const OAUTH_PENDING_KEY = 'ledger_oauth_pending';
const PKCE_VERIFIER_KEY = 'ledger_oauth_pkce_verifier';
const RETURN_HASH_KEY = 'ledger_oauth_return_hash';
const MS_OAUTH_PENDING_KEY = 'ms_oauth_pending';
const MS_OAUTH_RESULT_KEY = 'ms_oauth_result';
const MS_OAUTH_ERROR_KEY = 'ms_oauth_error';
const MS_WEB_OAUTH_PENDING_KEY = 'ms_web_oauth_pending';
const SERVICE_MS_OAUTH_PENDING_KEY = 'ms_service_oauth_pending';
const SERVICE_GOOGLE_OAUTH_PENDING_KEY = 'google_service_oauth_pending';

export function getAppRedirectUri() {
    return `${window.location.origin}${window.location.pathname}`;
}

export function getMicrosoftRedirectUri() {
    return `${window.location.origin}${MICROSOFT_AUTH_PATH}`;
}

const redirectUri = getAppRedirectUri;

function base64UrlEncode(buffer) {
    const bytes = new Uint8Array(buffer);
    let str = '';
    bytes.forEach((b) => { str += String.fromCharCode(b); });
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomVerifier(len = 64) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => chars[b % chars.length]).join('');
}

async function pkceChallenge(verifier) {
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return base64UrlEncode(digest);
}

export function getOAuthApp(provider) {
    return (portalState.finances?.ledgerOAuthApps || []).find(
        (a) => a.provider === provider && a.enabled !== false,
    ) || null;
}

export function getMyOAuthConnection(provider) {
    return (portalState.finances?.myOAuthConnections || []).find((c) => c.provider === provider) || null;
}

export function getMyOAuthConnectionMeta(provider) {
    const c = getMyOAuthConnection(provider);
    if (!c) return null;
    return {
        account_email: c.account_email,
        connected_at: c.connected_at,
        token_expires_at: c.token_expires_at,
        is_expired: c.token_expires_at && new Date(c.token_expires_at) <= new Date(),
        background_capable: provider === 'GOOGLE'
            ? true
            : !!(c.account_meta?.background_capable),
    };
}

export function getServiceAccountStatus(provider) {
    return (portalState.finances?.syncServiceAccounts || []).find((c) => c.provider === provider) || null;
}

export function getServiceAccountMeta(provider) {
    const c = getServiceAccountStatus(provider);
    if (!c) return null;
    return {
        account_email: c.account_email,
        connected_at: c.connected_at,
        token_expires_at: c.token_expires_at,
        has_refresh_token: !!c.has_refresh_token,
        is_expired: c.token_expires_at && new Date(c.token_expires_at) <= new Date(),
    };
}

export function oauthAppHasClientSecret(provider) {
    return !!getOAuthApp(provider)?.client_secret_set;
}

export async function saveOAuthApp({ provider, client_id, tenant_id, client_secret }) {
    if (!hasClientPermission('accounts.edit')) {
        throw new Error('Only accounts managers can configure spreadsheet OAuth apps.');
    }
    const apartment_id = portalState.access?.activeApartmentId;
    const { data: { user } } = await supabase.auth.getUser();
    const { data: existing } = await supabase
        .from('ledger_sync_oauth_apps')
        .select('id')
        .eq('apartment_id', apartment_id)
        .eq('provider', provider)
        .maybeSingle();

    const secretTrimmed = client_secret?.trim();
    const row = {
        id: existing?.id || crypto.randomUUID(),
        apartment_id,
        provider,
        client_id: client_id.trim(),
        tenant_id: (tenant_id || 'common').trim(),
        redirect_uri: provider === 'MICROSOFT' ? getMicrosoftRedirectUri() : redirectUri(),
        enabled: true,
        configured_by: user?.id,
        updated_at: new Date().toISOString(),
    };
    if (secretTrimmed) {
        row.client_secret = secretTrimmed;
        row.client_secret_set = true;
    }

    const { error } = await supabase.from('ledger_sync_oauth_apps').upsert(row, { onConflict: 'apartment_id,provider' });
    if (error) throw new Error(error.message);
    await pullState();
}

async function upsertConnection(row, apartmentIdOverride) {
    const { data: { user } } = await supabase.auth.getUser();
    const apartment_id = apartmentIdOverride || portalState.access?.activeApartmentId;
    if (!apartment_id || apartment_id === 'apt-default') {
        throw new Error('Select a society before connecting your account.');
    }
    if (!user) {
        throw new Error('Sign in to CommunityHub before connecting your account.');
    }

    // Use onConflict to update existing row for this user/apartment/provider combo.
    const { error } = await supabase.from('user_oauth_connections').upsert({
        user_id: user.id,
        apartment_id,
        provider: row.provider,
        account_email: row.account_email,
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        token_expires_at: row.token_expires_at,
        scopes: row.scopes,
        provider_account_id: row.provider_account_id,
        account_meta: row.account_meta || {},
        updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,apartment_id,provider' });

    if (error) {
        console.error('Upsert connection error:', error);
        throw new Error(error.message);
    }
    await pullState();
}

async function fetchConnectionWithTokens(provider) {
    const apartment_id = portalState.access?.activeApartmentId;
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase
        .from('user_oauth_connections')
        .select('*')
        .eq('user_id', user.id)
        .eq('apartment_id', apartment_id)
        .eq('provider', provider)
        .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
}

export async function disconnectOAuth(provider) {
    const apartment_id = portalState.access?.activeApartmentId;
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('user_oauth_connections')
        .delete()
        .eq('user_id', user.id)
        .eq('apartment_id', apartment_id)
        .eq('provider', provider);
    await pullState();
}

export async function startGoogleConnect() {
    const app = getOAuthApp('GOOGLE');
    if (!app?.client_id) {
        throw new Error('Google OAuth is not configured for this society. An accounts manager must add the Client ID first.');
    }
    const verifier = randomVerifier();
    const challenge = await pkceChallenge(verifier);
    sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
    sessionStorage.setItem(OAUTH_PENDING_KEY, 'GOOGLE');
    sessionStorage.setItem(RETURN_HASH_KEY, window.location.hash || '#finance-ledger');

    const params = new URLSearchParams({
        client_id: app.client_id,
        redirect_uri: app.redirect_uri || redirectUri(),
        response_type: 'code',
        scope: GOOGLE_SHEETS_SCOPE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
    });
    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function completeGoogleOAuthCallback(code) {
    const app = getOAuthApp('GOOGLE');
    const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
    if (!app?.client_id || !verifier) throw new Error('OAuth session expired. Try connecting again.');

    const proxy = await proxyExternalRequest('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: app.client_id,
            code,
            redirect_uri: app.redirect_uri || redirectUri(),
            grant_type: 'authorization_code',
            code_verifier: verifier,
        }).toString(),
    });
    const json = proxy.json || {};
    if (!proxy.ok) throw new Error(json.error_description || json.error || 'Google token exchange failed.');

    const expiresAt = json.expires_in
        ? new Date(Date.now() + json.expires_in * 1000).toISOString()
        : null;

    let accountEmail = null;
    try {
        const profile = await proxyExternalRequest('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${json.access_token}` },
        });
        const p = profile.json || {};
        accountEmail = p.email || null;
    } catch { /* optional */ }

    await upsertConnection({
        provider: 'GOOGLE',
        account_email: accountEmail,
        access_token: json.access_token,
        refresh_token: json.refresh_token || null,
        token_expires_at: expiresAt,
        scopes: GOOGLE_SHEETS_SCOPE,
        provider_account_id: accountEmail,
        account_meta: { background_capable: true },
    });

    sessionStorage.removeItem(PKCE_VERIFIER_KEY);
    sessionStorage.removeItem(OAUTH_PENDING_KEY);
    const hash = sessionStorage.getItem(RETURN_HASH_KEY) || '#finance-ledger';
    sessionStorage.removeItem(RETURN_HASH_KEY);
    window.history.replaceState({}, '', `${window.location.pathname}${hash}`);
}

function msalErrorMessage(err) {
    const code = err?.errorCode || err?.name;
    const msg = err?.message || err?.errorMessage || String(err);
    if (msg.includes('AADSTS50011') || /redirect uri.*does not match/i.test(msg)) {
        return `Azure redirect URI mismatch.\n\nAdd this exact URI in Azure → App registrations → Authentication → Single-page application:\n\n${getMicrosoftRedirectUri()}\n\nThen Save in Azure and try Connect Microsoft again.`;
    }
    if (code === 'interaction_in_progress' || msg.includes('interaction_in_progress')) {
        return 'Microsoft sign-in is still open or was interrupted. Close any Microsoft popup, wait a few seconds, then click Connect Microsoft once.';
    }
    if (code === 'no_token_request_cache_error' || msg.includes('no_token_request_cache_error')) {
        return 'Microsoft sign-in was interrupted. Click Connect Microsoft again (the page will redirect to Microsoft login).';
    }
    if (code === 'user_cancelled' || code === 'UserCancelledError') {
        return 'Microsoft sign-in was cancelled.';
    }
    if (code === 'popup_window_error' || code === 'BrowserAuthError') {
        return 'Sign-in popup was blocked. Allow popups for this site, then try Connect Microsoft again.';
    }
    return msg;
}

let msalInstance = null;
let msalInstanceKey = '';

async function getMsalClient(app) {
    const tenant = app.tenant_id || 'common';
    const key = `${app.client_id}:${tenant}`;
    const msRedirect = getMicrosoftRedirectUri();

    if (!msalInstance || msalInstanceKey !== key) {
        msalInstance = new PublicClientApplication({
            auth: {
                clientId: app.client_id,
                authority: `https://login.microsoftonline.com/${tenant}`,
                redirectUri: msRedirect,
            },
            cache: { cacheLocation: 'sessionStorage' },
        });
        msalInstanceKey = key;
        await msalInstance.initialize();
    }

    // Always handle redirect promise to clear any pending state
    try {
        await msalInstance.handleRedirectPromise();
    } catch (e) {
        console.warn('MSAL handleRedirectPromise error:', e);
    }

    return msalInstance;
}

function clearMsalInteraction() {
    for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key && (key.includes('msal.interaction') || key.includes('msal.state'))) {
            sessionStorage.removeItem(key);
            i--;
        }
    }
}

export async function startMicrosoftConnect() {
    const app = getOAuthApp('MICROSOFT');
    if (!app?.client_id) {
        throw new Error('Microsoft OAuth is not configured for this society. An accounts manager must add the Application (client) ID first.');
    }

    // When a client secret is saved, use web OAuth so refresh_token is stored for cron sync.
    if (app.client_secret_set) {
        return startMicrosoftWebConnect();
    }

    const pending = {
        client_id: app.client_id,
        tenant_id: app.tenant_id || 'common',
        return_hash: window.location.hash || '#finance-ledger',
        apartment_id: portalState.access?.activeApartmentId,
    };
    sessionStorage.setItem(MS_OAUTH_PENDING_KEY, JSON.stringify(pending));
    localStorage.setItem(MS_OAUTH_PENDING_KEY, JSON.stringify(pending));

    const pca = await getMsalClient(app);
    const msRedirect = getMicrosoftRedirectUri();
    console.log('startMicrosoftConnect: using redirectUri=', msRedirect);

    try {
        await pca.loginRedirect({
            scopes: MS_SCOPES,
            prompt: 'select_account',
            redirectUri: msRedirect,
        });
    } catch (err) {
        const msg = err?.message || String(err);
        if (msg.includes('interaction_in_progress')) {
            clearMsalInteraction();
            // Try one more time after clearing
            await pca.loginRedirect({
                scopes: MS_SCOPES,
                prompt: 'select_account',
            });
            return;
        }
        throw new Error(msalErrorMessage(err));
    }
}

async function saveMicrosoftConnection(result, apartmentIdOverride) {
    await upsertConnection({
        provider: 'MICROSOFT',
        account_email: result.account_email || result.account?.username || null,
        access_token: result.access_token || result.accessToken,
        refresh_token: null,
        token_expires_at: result.expiresOn || (result.expires_on ?? null),
        scopes: MS_SCOPES.join(' '),
        provider_account_id: result.home_account_id || result.account?.homeAccountId || null,
        account_meta: {
            home_account_id: result.home_account_id || result.account?.homeAccountId,
            tenant_id: result.tenant_id || result.account?.tenantId,
            username: result.username || result.account?.username,
            background_capable: false,
            web_oauth: false,
        },
    }, apartmentIdOverride);
}

/** Web OAuth (client secret) — stores refresh_token for background cron sync. */
export async function startMicrosoftWebConnect() {
    const app = getOAuthApp('MICROSOFT');
    if (!app?.client_id) {
        throw new Error('Microsoft OAuth is not configured for this society.');
    }
    if (!app.client_secret_set) {
        throw new Error('Save a Microsoft Client Secret first (Administration → Spreadsheet Sync).');
    }

    const verifier = randomVerifier();
    const challenge = await pkceChallenge(verifier);
    sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
    sessionStorage.setItem(MS_WEB_OAUTH_PENDING_KEY, JSON.stringify({
        apartment_id: portalState.access?.activeApartmentId,
        return_hash: window.location.hash || '#admin-sync',
    }));
    sessionStorage.setItem(RETURN_HASH_KEY, window.location.hash || '#admin-sync');

    const redirectUri = getMicrosoftRedirectUri();
    const tenant = app.tenant_id || 'common';
    const params = new URLSearchParams({
        client_id: app.client_id,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: MS_SCOPES.join(' '),
        response_mode: 'query',
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
    });
    window.location.href = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params}`;
}

/** Connect a dedicated Microsoft account for background cron sync (not tied to app user). */
export async function startServiceAccountMicrosoftConnect() {
    const app = getOAuthApp('MICROSOFT');
    if (!app?.client_id) {
        throw new Error('Microsoft OAuth is not configured for this society.');
    }
    if (!app.client_secret_set) {
        throw new Error('Save a Microsoft Client Secret first — required for background sync.');
    }

    const verifier = randomVerifier();
    const challenge = await pkceChallenge(verifier);
    sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
    sessionStorage.setItem(SERVICE_MS_OAUTH_PENDING_KEY, JSON.stringify({
        apartment_id: portalState.access?.activeApartmentId,
        return_hash: window.location.hash || '#admin-sync',
    }));
    sessionStorage.setItem(RETURN_HASH_KEY, window.location.hash || '#admin-sync');

    const redirectUri = getMicrosoftRedirectUri();
    const tenant = app.tenant_id || 'common';
    const params = new URLSearchParams({
        client_id: app.client_id,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: MS_SCOPES.join(' '),
        response_mode: 'query',
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
    });
    window.location.href = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params}`;
}

/** Connect a dedicated Google account for background cron sync (not tied to app user). */
export async function startServiceAccountGoogleConnect() {
    const app = getOAuthApp('GOOGLE');
    if (!app?.client_id) {
        throw new Error('Google OAuth is not configured for this society.');
    }
    if (!oauthAppHasClientSecret('GOOGLE')) {
        throw new Error('Save a Google Client Secret first — required for background sync token refresh.');
    }

    const verifier = randomVerifier();
    const challenge = await pkceChallenge(verifier);
    sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
    sessionStorage.setItem(SERVICE_GOOGLE_OAUTH_PENDING_KEY, JSON.stringify({
        apartment_id: portalState.access?.activeApartmentId,
        return_hash: window.location.hash || '#admin-sync',
    }));
    sessionStorage.setItem(RETURN_HASH_KEY, window.location.hash || '#admin-sync');

    const params = new URLSearchParams({
        client_id: app.client_id,
        redirect_uri: app.redirect_uri || redirectUri(),
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
    });
    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function disconnectServiceAccount(provider) {
    if (!hasClientPermission('accounts.edit')) {
        throw new Error('Only accounts managers can disconnect the service account.');
    }
    const apartment_id = portalState.access?.activeApartmentId;

    const res = await fetch('/api/oauth-service', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'disconnect', apartment_id, provider }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Could not disconnect service account.');
    await pullState();
}

async function completeServiceAccountGoogleCallback(code) {
    const pendingRaw = sessionStorage.getItem(SERVICE_GOOGLE_OAUTH_PENDING_KEY);
    if (!pendingRaw) throw new Error('Google service-account session expired. Try again.');
    const pending = JSON.parse(pendingRaw);
    const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);

    const res = await fetch('/api/oauth-service', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            action: 'google_exchange',
            code,
            apartment_id: pending.apartment_id,
            redirect_uri: getAppRedirectUri(),
            code_verifier: verifier,
        }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Google service account connect failed.');

    sessionStorage.removeItem(SERVICE_GOOGLE_OAUTH_PENDING_KEY);
    sessionStorage.removeItem(PKCE_VERIFIER_KEY);
    await pullState();

    const hash = pending.return_hash || '#admin-sync';
    window.history.replaceState({}, '', `${window.location.pathname}${hash}`);
}

async function completeMicrosoftOAuth() {
    const err = sessionStorage.getItem(MS_OAUTH_ERROR_KEY) || localStorage.getItem(MS_OAUTH_ERROR_KEY);
    if (err) {
        sessionStorage.removeItem(MS_OAUTH_ERROR_KEY);
        localStorage.removeItem(MS_OAUTH_ERROR_KEY);
        console.error('Microsoft OAuth error found in storage:', err);
        throw new Error(err);
    }

    const raw = sessionStorage.getItem(MS_OAUTH_RESULT_KEY) || localStorage.getItem(MS_OAUTH_RESULT_KEY);
    console.log('completeMicrosoftOAuth: ms_result in storage=', !!raw);
    if (!raw) {
        return false;
    }

    const pendingRaw = sessionStorage.getItem(MS_OAUTH_PENDING_KEY) || localStorage.getItem(MS_OAUTH_PENDING_KEY);
    if (!pendingRaw) {
        console.warn('Microsoft OAuth result found but no pending state (ms_pending) exists.');
    }
    const pending = pendingRaw ? JSON.parse(pendingRaw) : {};

    try {
        const result = JSON.parse(raw);
        console.log('Attempting to save Microsoft connection for apartment:', pending.apartment_id);
        await saveMicrosoftConnection(result, pending.apartment_id);
        
        // Success! Clear the keys.
        sessionStorage.removeItem(MS_OAUTH_RESULT_KEY);
        localStorage.removeItem(MS_OAUTH_RESULT_KEY);
        sessionStorage.removeItem(MS_OAUTH_PENDING_KEY);
        localStorage.removeItem(MS_OAUTH_PENDING_KEY);
        sessionStorage.setItem('ms_oauth_just_connected', '1');
        localStorage.setItem('ms_oauth_just_connected', '1');
        console.log('Microsoft connection saved successfully.');
        return true;
    } catch (e) {
        console.error('Failed to save Microsoft connection:', e);
        // If it's a "no society" error, we keep the keys so we can try again after society loads.
        if (e.message.includes('Select a society')) {
            console.log('Waiting for society to load before retrying save...');
            return false;
        }
        
        // For other errors, clear and throw.
        sessionStorage.removeItem(MS_OAUTH_RESULT_KEY);
        localStorage.removeItem(MS_OAUTH_RESULT_KEY);
        sessionStorage.removeItem(MS_OAUTH_PENDING_KEY);
        localStorage.removeItem(MS_OAUTH_PENDING_KEY);
        throw e;
    }
}

async function refreshGoogleToken(conn, app) {
    if (!conn.refresh_token) throw new Error('Google session expired. Connect your Google account again.');
    const proxy = await proxyExternalRequest('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: app.client_id,
            refresh_token: conn.refresh_token,
            grant_type: 'refresh_token',
        }).toString(),
    });
    const json = proxy.json || {};
    if (!proxy.ok) throw new Error(json.error_description || 'Could not refresh Google access. Connect again.');

    const expiresAt = json.expires_in
        ? new Date(Date.now() + json.expires_in * 1000).toISOString()
        : null;

    await upsertConnection({
        provider: 'GOOGLE',
        account_email: conn.account_email,
        access_token: json.access_token,
        refresh_token: conn.refresh_token,
        token_expires_at: expiresAt,
        scopes: conn.scopes,
        provider_account_id: conn.provider_account_id,
        account_meta: conn.account_meta || {},
    });

    return json.access_token;
}

async function refreshMicrosoftToken(conn, app) {
    const pca = await getMsalClient(app);

    const accounts = pca.getAllAccounts();
    const account = accounts.find((a) => a.homeAccountId === conn.provider_account_id)
        || accounts.find((a) => a.username === conn.account_email);

    if (!account) {
        throw new Error('Microsoft session expired. Connect your Microsoft account again.');
    }

    let result;
    try {
        result = await pca.acquireTokenSilent({ scopes: MS_SCOPES, account }).catch(() =>
            pca.acquireTokenPopup({ scopes: MS_SCOPES, account }),
        );
    } catch (err) {
        throw new Error(msalErrorMessage(err));
    }

    const expiresAt = result.expiresOn ? result.expiresOn.toISOString() : null;
    await upsertConnection({
        provider: 'MICROSOFT',
        account_email: result.account?.username || conn.account_email,
        access_token: result.accessToken,
        refresh_token: null,
        token_expires_at: expiresAt,
        scopes: MS_SCOPES.join(' '),
        provider_account_id: result.account?.homeAccountId || conn.provider_account_id,
        account_meta: conn.account_meta || {},
    });

    return result.accessToken;
}

export async function ensureOAuthConnected(provider) {
    let conn = await fetchConnectionWithTokens(provider);
    if (conn) return conn;
    const label = provider === 'GOOGLE' ? 'Google' : 'Microsoft';
    if (provider === 'GOOGLE') {
        const proceed = confirm(
            `Your ${label} account is not connected yet.\n\nClick OK to sign in with ${label}, then sync again.`,
        );
        if (!proceed) throw new Error(`Connect your ${label} account before syncing.`);
        await startGoogleConnect();
        throw new Error('Complete Google sign-in, then click Sync now again.');
    }
    throw new Error('Connect your Microsoft account before syncing.');
}

export async function getAccessTokenForProvider(provider) {
    const app = getOAuthApp(provider);
    if (!app?.client_id) {
        throw new Error(`${provider === 'GOOGLE' ? 'Google' : 'Microsoft'} is not configured for this society.`);
    }

    let conn = await fetchConnectionWithTokens(provider);
    if (!conn) {
        throw new Error(`Connect your ${provider === 'GOOGLE' ? 'Google' : 'Microsoft'} account before syncing.`);
    }

    const expired = conn.token_expires_at && new Date(conn.token_expires_at) <= new Date(Date.now() + 60_000);
    if (!expired) return conn.access_token;

    if (provider === 'GOOGLE') return refreshGoogleToken(conn, app);
    return refreshMicrosoftToken(conn, app);
}

export async function handleOAuthRedirectIfPresent() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const error = params.get('error');
    const pending = sessionStorage.getItem(OAUTH_PENDING_KEY);
    const serviceGooglePending = sessionStorage.getItem(SERVICE_GOOGLE_OAUTH_PENDING_KEY);

    console.log('handleOAuthRedirectIfPresent: checking URL and storage...');

    if (error && serviceGooglePending) {
        sessionStorage.removeItem(SERVICE_GOOGLE_OAUTH_PENDING_KEY);
        sessionStorage.removeItem(PKCE_VERIFIER_KEY);
        const hash = sessionStorage.getItem(RETURN_HASH_KEY) || '#admin-sync';
        sessionStorage.removeItem(RETURN_HASH_KEY);
        window.history.replaceState({}, '', `${window.location.pathname}${hash}`);
        throw new Error(params.get('error_description') || error);
    }

    if (code && serviceGooglePending) {
        await completeServiceAccountGoogleCallback(code);
        return true;
    }

    // 1. Handle Google (Query-based)
    if (error && pending === 'GOOGLE') {
        sessionStorage.removeItem(OAUTH_PENDING_KEY);
        sessionStorage.removeItem(PKCE_VERIFIER_KEY);
        const hash = sessionStorage.getItem(RETURN_HASH_KEY) || '#finance-ledger';
        sessionStorage.removeItem(RETURN_HASH_KEY);
        window.history.replaceState({}, '', `${window.location.pathname}${hash}`);
        throw new Error(params.get('error_description') || error);
    }

    if (code && pending === 'GOOGLE') {
        await completeGoogleOAuthCallback(code);
        return true;
    }

    // 2. Handle Microsoft (Hash-based, requires MSAL handleRedirectPromise)
    const msPendingRaw = sessionStorage.getItem(MS_OAUTH_PENDING_KEY) || localStorage.getItem(MS_OAUTH_PENDING_KEY);
    console.log('handleOAuthRedirectIfPresent: msPending=', !!msPendingRaw);
    
    if (msPendingRaw) {
        const msPending = JSON.parse(msPendingRaw);
        const app = getOAuthApp('MICROSOFT');
        console.log('handleOAuthRedirectIfPresent: msApp found=', !!app);
        
        if (app && app.client_id === msPending.client_id) {
            try {
                console.log('handleOAuthRedirectIfPresent: Initializing MSAL to check for redirect result...');
                const pca = await getMsalClient(app);
                const result = await pca.handleRedirectPromise();
                console.log('handleOAuthRedirectIfPresent: handleRedirectPromise result=', !!result);
                
                if (result) {
                    console.log('MSAL: Found redirect result in URL, saving to storage...');
                    const resultStr = JSON.stringify({
                        access_token: result.accessToken,
                        expiresOn: result.expiresOn ? result.expiresOn.toISOString() : null,
                        account_email: result.account?.username || null,
                        home_account_id: result.account?.homeAccountId || null,
                        tenant_id: result.account?.tenantId || null,
                        username: result.account?.username || null,
                    });
                    sessionStorage.setItem(MS_OAUTH_RESULT_KEY, resultStr);
                    localStorage.setItem(MS_OAUTH_RESULT_KEY, resultStr);
                }
            } catch (err) {
                console.warn('MSAL: Error handling redirect promise:', err);
            }
        }
    }

    if (await completeMicrosoftOAuth()) {
        return true;
    }
    return false;
}
