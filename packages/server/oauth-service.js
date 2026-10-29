import { getMongoDb } from './mongoClient.js';
import { requireApartmentPermission } from './serverAuth.js';
import { COL_OAUTH_APPS, COL_SERVICE_ACCOUNTS } from '../../apps/new/api/integrationsMongo/spreadsheetStore.js';

async function upsertServiceAccount(db, { apartment_id, provider, userId, tokenJson, accountEmail, scopes }) {
    const expiresAt = tokenJson.expires_in
        ? new Date(Date.now() + tokenJson.expires_in * 1000).toISOString()
        : null;

    await db.collection(COL_SERVICE_ACCOUNTS).updateOne(
        { apartment_id, provider },
        {
            $set: {
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
            },
            $setOnInsert: { created_at: new Date().toISOString() },
        },
        { upsert: true },
    );
}

/**
 * Service-account OAuth helpers (Google exchange + disconnect).
 * Microsoft service connect uses /api/oauth-microsoft with target=service.
 */
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = req.body || {};
    const { action, apartment_id, provider } = body;

    if (!apartment_id) {
        return res.status(400).json({ error: 'apartment_id is required.' });
    }

    let auth;
    try {
        auth = await requireApartmentPermission(req, apartment_id, 'accounts.edit');
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message });
    }
    const { user } = auth;
    const db = await getMongoDb();

    if (action === 'disconnect') {
        if (!provider || !['GOOGLE', 'MICROSOFT'].includes(provider)) {
            return res.status(400).json({ error: 'provider must be GOOGLE or MICROSOFT.' });
        }

        await db.collection(COL_SERVICE_ACCOUNTS).deleteOne({ apartment_id, provider });
        return res.status(200).json({ ok: true });
    }

    if (action === 'google_exchange') {
        const { code, redirect_uri, code_verifier } = body;
        if (!code || !redirect_uri) {
            return res.status(400).json({ error: 'code and redirect_uri are required.' });
        }

        const app = await db.collection(COL_OAUTH_APPS).findOne({ apartment_id, provider: 'GOOGLE' });
        if (!app?.client_id) {
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
            await upsertServiceAccount(db, {
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
