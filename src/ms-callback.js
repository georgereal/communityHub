import { PublicClientApplication } from '@azure/msal-browser';

const MS_OAUTH_PENDING_KEY = 'ms_oauth_pending';
const MS_OAUTH_RESULT_KEY = 'ms_oauth_result';
const MS_OAUTH_ERROR_KEY = 'ms_oauth_error';
const MICROSOFT_AUTH_PATH = '/microsoft-auth.html';

function returnToApp(pending, extra = {}) {
    const hash = pending?.return_hash || '#finance-ledger';
    if (extra.error) {
        sessionStorage.setItem(MS_OAUTH_ERROR_KEY, extra.error);
        localStorage.setItem(MS_OAUTH_ERROR_KEY, extra.error);
    }
    const url = window.location.origin + '/' + hash.replace(/^#/, '#');
    window.location.replace(url);
}

async function run() {
    console.log('MSAL Callback: Starting bundled run...');
    const statusEl = document.getElementById('status');
    const setStatus = (msg) => { if (statusEl) statusEl.innerText = msg; };
    const pendingRaw = sessionStorage.getItem(MS_OAUTH_PENDING_KEY) || localStorage.getItem(MS_OAUTH_PENDING_KEY);

    if (!pendingRaw) {
        console.error('MSAL Callback: No pending state found.');
        const url = new URL(window.location.href);
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
        cache: { cacheLocation: 'sessionStorage' }
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
