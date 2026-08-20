import { requireApartmentPermission } from './serverAuth.js';

/**
 * Exchange Microsoft authorization code for tokens (server-side only — uses client secret).
 * Stores refresh_token for unattended background sync via /api/sync cron.
 */
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { code, apartment_id, redirect_uri, code_verifier } = req.body || {};
    if (!code || !apartment_id || !redirect_uri) {
        return res.status(400).json({ error: 'code, apartment_id, and redirect_uri are required.' });
    }

    try {
    const { user, service: serviceClient } = await requireApartmentPermission(req, apartment_id, 'accounts.edit');

    const { data: app, error: appError } = await serviceClient
        .from('ledger_sync_oauth_apps')
        .select('*')
        .eq('apartment_id', apartment_id)
        .eq('provider', 'MICROSOFT')
        .maybeSingle();

    if (appError || !app?.client_id || !app?.client_secret) {
        return res.status(400).json({ error: 'Microsoft OAuth app or client secret is not configured. Save Client ID and Secret in Admin first.' });
    }

    const tokenParams = new URLSearchParams({
        client_id: app.client_id,
        client_secret: app.client_secret,
        code,
        redirect_uri,
        grant_type: 'authorization_code',
        scope: 'Files.ReadWrite User.Read offline_access',
    });
    if (code_verifier) tokenParams.set('code_verifier', code_verifier);

    const tokenRes = await fetch(
        `https://login.microsoftonline.com/${app.tenant_id || 'common'}/oauth2/v2.0/token`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: tokenParams,
        },
    );
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) {
        const msg = tokenJson.error_description || tokenJson.error || 'Token exchange failed.';
        const hint = /public clients can't send a client secret/i.test(msg)
            ? ' In Azure → App registrations → Authentication, add the redirect URI under **Web** (not Single-page application). Remove it from SPA if listed there, then try again.'
            : '';
        return res.status(400).json({ error: msg + hint });
    }

    if (!tokenJson.refresh_token) {
        return res.status(400).json({
            error: 'Microsoft did not return a refresh token. Re-connect and accept all permissions (offline_access).',
        });
    }

    let accountEmail = null;
    try {
        const profileRes = await fetch('https://graph.microsoft.com/v1.0/me', {
            headers: { Authorization: `Bearer ${tokenJson.access_token}` },
        });
        if (profileRes.ok) {
            const profile = await profileRes.json();
            accountEmail = profile.mail || profile.userPrincipalName || null;
        }
    } catch {
        // optional
    }

    const expiresAt = tokenJson.expires_in
        ? new Date(Date.now() + tokenJson.expires_in * 1000).toISOString()
        : null;

    const { error: connError } = await serviceClient.from('user_oauth_connections').upsert({
        user_id: user.id,
        apartment_id,
        provider: 'MICROSOFT',
        account_email: accountEmail,
        access_token: tokenJson.access_token,
        refresh_token: tokenJson.refresh_token,
        token_expires_at: expiresAt,
        scopes: 'Files.ReadWrite User.Read offline_access',
        provider_account_id: accountEmail,
        account_meta: { background_capable: true, web_oauth: true },
        updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,apartment_id,provider' });

    if (connError) {
        return res.status(500).json({ error: connError.message });
    }

    await serviceClient.from('ledger_sync_settings').update({
        last_synced_by: user.id,
        updated_at: new Date().toISOString(),
    }).eq('apartment_id', apartment_id);

    return res.status(200).json({
        ok: true,
        account_email: accountEmail,
        background_capable: true,
    });
    } catch (err) {
        console.error('oauth-microsoft error:', err);
        return res.status(500).json({ error: err.message || 'Microsoft OAuth failed.' });
    }
}
