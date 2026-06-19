import { PublicClientApplication } from '@azure/msal-browser';
import { supabase } from './store.js';
import { getMicrosoftRedirectUri } from './ledgerOAuth.js';

const MS_OAUTH_PENDING_KEY = 'ms_oauth_pending';
const MS_OAUTH_RESULT_KEY = 'ms_oauth_result';
const MS_OAUTH_ERROR_KEY = 'ms_oauth_error';
const MS_WEB_OAUTH_PENDING_KEY = 'ms_web_oauth_pending';
const SERVICE_MS_OAUTH_PENDING_KEY = 'ms_service_oauth_pending';
const PKCE_VERIFIER_KEY = 'ledger_oauth_pkce_verifier';
const MICROSOFT_AUTH_PATH = '/microsoft-auth.html';

function returnToApp(pending, extra = {}) {
    const hash = pending?.return_hash || '#finance-ledger';
    if (extra.error) {
        sessionStorage.setItem(MS_OAUTH_ERROR_KEY, extra.error);
        localStorage.setItem(MS_OAUTH_ERROR_KEY, extra.error);
    }
    window.location.replace(window.location.origin + '/' + hash.replace(/^#/, '#'));
}

async function completeMicrosoftWebOAuth(code, { target } = {}) {
    const pendingKey = target === 'service' ? SERVICE_MS_OAUTH_PENDING_KEY : MS_WEB_OAUTH_PENDING_KEY;
    const pendingRaw = sessionStorage.getItem(pendingKey);
    if (!pendingRaw) throw new Error('Microsoft sign-in session expired. Try Connect again.');
    const pending = JSON.parse(pendingRaw);
    const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);

    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
        throw new Error('Sign in to CommunityHub before connecting Microsoft.');
    }

    const res = await fetch('/api/oauth-microsoft', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
            code,
            apartment_id: pending.apartment_id,
            redirect_uri: getMicrosoftRedirectUri(),
            code_verifier: verifier,
            target: target === 'service' ? 'service' : undefined,
        }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Microsoft token exchange failed.');

    sessionStorage.removeItem(pendingKey);
    sessionStorage.removeItem(PKCE_VERIFIER_KEY);
    sessionStorage.setItem('ms_oauth_just_connected', '1');
    localStorage.setItem('ms_oauth_just_connected', '1');
    return pending;
}

async function run() {
    console.log('MSAL Callback: Starting bundled run...');
    const statusEl = document.getElementById('status');
    const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };

    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const oauthError = url.searchParams.get('error');
    const webPendingRaw = sessionStorage.getItem(MS_WEB_OAUTH_PENDING_KEY);
    const servicePendingRaw = sessionStorage.getItem(SERVICE_MS_OAUTH_PENDING_KEY);
    const oauthPendingRaw = webPendingRaw || servicePendingRaw;
    const oauthTarget = servicePendingRaw ? 'service' : undefined;

    if (oauthError && oauthPendingRaw) {
        sessionStorage.removeItem(MS_WEB_OAUTH_PENDING_KEY);
        sessionStorage.removeItem(SERVICE_MS_OAUTH_PENDING_KEY);
        sessionStorage.removeItem(PKCE_VERIFIER_KEY);
        const pending = JSON.parse(oauthPendingRaw);
        returnToApp(pending, { error: url.searchParams.get('error_description') || oauthError });
        return;
    }

    if (code && oauthPendingRaw) {
        try {
            setStatus(oauthTarget === 'service'
                ? 'Saving service account for background sync…'
                : 'Saving Microsoft connection for background sync…');
            const pending = await completeMicrosoftWebOAuth(code, { target: oauthTarget });
            setStatus('Success! Returning to app…');
            returnToApp(pending);
        } catch (err) {
            console.error('Microsoft web OAuth error:', err);
            const pending = JSON.parse(oauthPendingRaw);
            returnToApp(pending, { error: err.message || String(err) });
        }
        return;
    }

    const pendingRaw = sessionStorage.getItem(MS_OAUTH_PENDING_KEY) || localStorage.getItem(MS_OAUTH_PENDING_KEY);

    if (!pendingRaw) {
        console.error('MSAL Callback: No pending state found.');
        if (url.searchParams.has('code') || url.hash.includes('access_token')) {
            setStatus('Session found in URL, redirecting...');
            window.location.replace(window.location.origin + '/#finance-ledger');
            return;
        }
        setStatus('Sign-in session expired. Please return to the app and try again.');
        return;
    }

    const pending = JSON.parse(pendingRaw);
    localStorage.setItem(MS_OAUTH_PENDING_KEY, pendingRaw);

    const msalConfig = {
        auth: {
            clientId: pending.client_id,
            authority: `https://login.microsoftonline.com/${pending.tenant_id || 'common'}`,
            redirectUri: window.location.origin + MICROSOFT_AUTH_PATH,
        },
        cache: { cacheLocation: 'sessionStorage' },
    };

    try {
        const pca = new PublicClientApplication(msalConfig);
        await pca.initialize();
        const result = await pca.handleRedirectPromise();

        if (result) {
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
            sessionStorage.setItem('ms_oauth_just_connected', '1');
            localStorage.setItem('ms_oauth_just_connected', '1');
            setStatus('Success! Returning to app...');
            returnToApp(pending);
        } else {
            setStatus('No result from Microsoft. Returning...');
            returnToApp(pending);
        }
    } catch (err) {
        console.error('MSAL Callback Error:', err);
        setStatus('Error: ' + (err.message || String(err)));
        returnToApp(pending, { error: err.message || String(err) });
    }
}

run();
