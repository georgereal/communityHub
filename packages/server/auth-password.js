/**
 * POST /api/auth-password — Mongo email/password login & signup.
 * Body: { action: 'login'|'signup', email, password, full_name? }
 */
import { setSessionCookie } from './serverAuth.js';
import { loginPasswordUser, registerPasswordUser } from './mongoPasswordAuth.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = typeof req.body === 'object' && req.body ? req.body : {};
    const action = String(body.action || 'login').toLowerCase();
    const email = body.email;
    const password = body.password;
    const fullName = body.full_name || body.fullName || '';

    try {
        let result;
        if (action === 'signup' || action === 'register') {
            result = await registerPasswordUser({ email, password, fullName });
        } else if (action === 'login' || action === 'signin') {
            result = await loginPasswordUser({ email, password });
        } else {
            return res.status(400).json({ error: 'action must be login or signup.' });
        }

        setSessionCookie(res, result.access_token);
        return res.status(200).json({
            ok: true,
            access_token: result.access_token,
            user: result.user,
            created: !!result.created,
            linked: !!result.linked,
        });
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message || 'Auth failed.' });
    }
}
