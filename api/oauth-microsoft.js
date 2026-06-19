import { createClient } from '@supabase/supabase-js';

/**
 * Exchange Microsoft authorization code for tokens (server-side only — uses client secret).
 * Stores refresh_token for unattended background sync via /api/sync cron.
 */
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
        return res.status(500).json({ error: 'Missing Supabase environment variables.' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Sign in required.' });
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
        return res.status(401).json({ error: 'Invalid session.' });
    }

    const { code, apartment_id, redirect_uri, code_verifier, target } = req.body || {};
    if (!code || !apartment_id || !redirect_uri) {
        return res.status(400).json({ error: 'code, apartment_id, and redirect_uri are required.' });
    }

    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    const { data: mapping } = await serviceClient
        .from('user_apartments')
        .select('apartment_id')
        .eq('user_id', user.id)
        .eq('apartment_id', apartment_id)
        .maybeSingle();

    if (!mapping) {
        return res.status(403).json({ error: 'No access to this society.' });
    }

    const isServiceTarget = target === 'service';
    if (isServiceTarget) {
        const allowed = await userCanAccountsEdit(serviceClient, user.id, apartment_id);
        if (!allowed) {
            return res.status(403).json({ error: 'Not permitted.' });
        }
    }

    const { data: app, error: appError } = await serviceClient
        .from('ledger_sync_oauth_apps')
        .select('*')
        .eq('apartment_id', apartment_id)
        .eq('provider', 'MICROSOFT')
        .maybeSingle();

    if (appError || !app?.client_id || !app?.client_secret) {
        return res.status(400).json({ error: 'Microsoft OAuth app or client secret is not configured.' });
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
        return res.status(400).json({
            error: tokenJson.error_description || tokenJson.error || 'Token exchange failed.',
        });
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

    if (isServiceTarget) {
        const { error: connError } = await serviceClient.from('ledger_sync_service_accounts').upsert({
            apartment_id,
            provider: 'MICROSOFT',
            account_email: accountEmail,
            access_token: tokenJson.access_token,
            refresh_token: tokenJson.refresh_token,
            token_expires_at: expiresAt,
            scopes: 'Files.ReadWrite User.Read offline_access',
            provider_account_id: accountEmail,
            account_meta: { background_capable: true, service_account: true, web_oauth: true },
            connected_by: user.id,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'apartment_id,provider' });

        if (connError) {
            return res.status(500).json({ error: connError.message });
        }

        return res.status(200).json({
            ok: true,
            account_email: accountEmail,
            background_capable: true,
            service_account: true,
        });
    }

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

    return res.status(200).json({
        ok: true,
        account_email: accountEmail,
        background_capable: true,
    });
}

async function userCanAccountsEdit(supabase, userId, apartmentId) {
    try {
        const { data: roles } = await supabase
            .from('user_role_assignments')
            .select('role_key, scope, apartment_id')
            .eq('user_id', userId);

        const aptRoleKeys = (roles || [])
            .filter((r) => r.scope === 'apartment' && String(r.apartment_id) === String(apartmentId))
            .map((r) => r.role_key);

        if (aptRoleKeys.length) {
            const { data: rp } = await supabase
                .from('role_permissions')
                .select('permission_key')
                .in('role_key', aptRoleKeys);
            const perms = new Set((rp || []).map((x) => x.permission_key));
            if (perms.has('accounts.edit')) return true;
        }
    } catch {
        // fall back to v1
    }

    const { data: prof } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .maybeSingle();
    return ['admin', 'accounts_manager'].includes(prof?.role);
}
