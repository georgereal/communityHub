import { authHeaderFromRequest, clearSessionCookie, requireSession, setSessionCookie } from './serverAuth.js';
import { getUserFromAuthHeader } from './serverFirebaseAuth.js';

function logAuth(op, ok, detail = {}) {
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        layer: 'api/auth-session',
        op,
        ok,
        ...detail,
    }));
}

export default async function handler(req, res) {
    if (req.method === 'POST') {
        const authHeader = authHeaderFromRequest(req);
        if (!authHeader?.startsWith('Bearer ')) {
            logAuth('POST', false, { error: 'missing Bearer token', hasCookie: Boolean(req.headers?.cookie) });
            return res.status(401).json({ error: 'Sign in required.' });
        }
        const { user, error, claimsUpdated } = await getUserFromAuthHeader(authHeader, { setClaims: true });
        if (error || !user?.id) {
            logAuth('POST', false, { error: error || 'Sign in required.' });
            return res.status(401).json({ error: error || 'Sign in required.' });
        }
        setSessionCookie(res, authHeader.slice('Bearer '.length));
        logAuth('POST', true, {
            userId: user.id,
            email: user.email || '',
            claimsUpdated: !!claimsUpdated,
            cookieSecure: process.env.SESSION_COOKIE_SECURE,
        });
        return res.status(200).json({
            ok: true,
            claimsUpdated: !!claimsUpdated,
            user: {
                id: user.id,
                email: user.email || '',
            },
        });
    }

    if (req.method === 'DELETE') {
        clearSessionCookie(res);
        logAuth('DELETE', true, {});
        return res.status(200).json({ ok: true });
    }

    if (req.method === 'GET') {
        try {
            const { user } = await requireSession(req);
            logAuth('GET', true, { userId: user.id });
            return res.status(200).json({
                ok: true,
                user: {
                    id: user.id,
                    email: user.email || '',
                },
            });
        } catch (err) {
            logAuth('GET', false, { error: err.message || 'Sign in required.' });
            return res.status(err.status || 401).json({ error: err.message || 'Sign in required.' });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
