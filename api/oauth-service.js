import { createClient } from '@supabase/supabase-js';

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

async function assertAccountsAccess(serviceClient, userId, apartmentId) {
    const { data: mapping } = await serviceClient
        .from('user_apartments')
        .select('apartment_id')
        .eq('user_id', userId)
        .eq('apartment_id', apartmentId)
        .maybeSingle();

    if (!mapping) {
        throw Object.assign(new Error('No access to this society.'), { status: 403 });
    }

    const allowed = await userCanAccountsEdit(serviceClient, userId, apartmentId);
    if (!allowed) {
        throw Object.assign(new Error('Not permitted.'), { status: 403 });
    }
}

async function upsertServiceAccount(serviceClient, { apartment_id, provider, userId, tokenJson, accountEmail, scopes }) {
    const expiresAt = tokenJson.expires_in
        ? new Date(Date.now() + tokenJson.expires_in * 1000).toISOString()
        : null;

    const { error } = await serviceClient.from('ledger_sync_service_accounts').upsert({
        apartment_id,
        provider,
        account_email: accountEmail,
        access_token: tokenJson.access_token,
        refresh_token: tokenJson.refresh_token || null,
        token_expires_at: expiresAt,
        scopes,
        provider_account_id: accountEmail,
        account_meta: { background_capable: true, service_account: true },
        connected_by: userId,
        updated_at: new Date().toISOString(),
    }, { onConflict: 'apartment_id,provider' });

    if (error) throw Object.assign(new Error(error.message), { status: 500 });
}

/**
 * Service-account OAuth helpers (Google exchange + disconnect).
 * Microsoft service connect uses /api/oauth-microsoft with target=service.
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

    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);
    const body = req.body || {};
    const { action, apartment_id, provider } = body;

    if (!apartment_id) {
        return res.status(400).json({ error: 'apartment_id is required.' });
    }

    try {
        await assertAccountsAccess(serviceClient, user.id, apartment_id);
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message });
    }

    if (action === 'disconnect') {
        if (!provider || !['GOOGLE', 'MICROSOFT'].includes(provider)) {
            return res.status(400).json({ error: 'provider must be GOOGLE or MICROSOFT.' });
        }

        const { error } = await serviceClient
            .from('ledger_sync_service_accounts')
            .delete()
            .eq('apartment_id', apartment_id)
            .eq('provider', provider);

        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true });
    }

    if (action === 'google_exchange') {
        const { code, redirect_uri, code_verifier } = body;
        if (!code || !redirect_uri) {
            return res.status(400).json({ error: 'code and redirect_uri are required.' });
        }

        const { data: app, error: appError } = await serviceClient
            .from('ledger_sync_oauth_apps')
            .select('*')
            .eq('apartment_id', apartment_id)
            .eq('provider', 'GOOGLE')
            .maybeSingle();

        if (appError || !app?.client_id) {
            return res.status(400).json({ error: 'Google OAuth app is not configured.' });
        }

        const params = {
            client_id: app.client_id,
            code,
            redirect_uri,
            grant_type: 'authorization_code',
        };
        if (code_verifier) params.code_verifier = code_verifier;
        if (app.client_secret) params.client_secret = app.client_secret;

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(params),
        });
        const tokenJson = await tokenRes.json();
        if (!tokenRes.ok) {
            return res.status(400).json({
                error: tokenJson.error_description || tokenJson.error || 'Token exchange failed.',
            });
        }

        if (!tokenJson.refresh_token) {
            return res.status(400).json({
                error: 'Google did not return a refresh token. Disconnect the app in Google Account settings and connect again with consent.',
            });
        }

        let accountEmail = null;
        try {
            const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                headers: { Authorization: `Bearer ${tokenJson.access_token}` },
            });
            if (profileRes.ok) {
                const profile = await profileRes.json();
                accountEmail = profile.email || null;
            }
        } catch {
            // optional
        }

        try {
            await upsertServiceAccount(serviceClient, {
                apartment_id,
                provider: 'GOOGLE',
                userId: user.id,
                tokenJson,
                accountEmail,
                scopes: 'https://www.googleapis.com/auth/spreadsheets',
            });
        } catch (err) {
            return res.status(err.status || 500).json({ error: err.message });
        }

        return res.status(200).json({ ok: true, account_email: accountEmail });
    }

    return res.status(400).json({ error: 'Unknown action.' });
}
