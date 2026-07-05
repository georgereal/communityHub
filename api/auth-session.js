import { authHeaderFromRequest, clearSessionCookie, requireSession, setSessionCookie } from './serverAuth.js';

export default async function handler(req, res) {
    if (req.method === 'POST') {
        const authHeader = authHeaderFromRequest(req);
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Sign in required.' });
        }
        setSessionCookie(res, authHeader.slice('Bearer '.length));
        return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
        clearSessionCookie(res);
        return res.status(200).json({ ok: true });
    }

    if (req.method === 'GET') {
        try {
            const { user } = await requireSession(req);
            return res.status(200).json({
                ok: true,
                user: {
                    id: user.id,
                    email: user.email || '',
                },
            });
        } catch (err) {
            return res.status(err.status || 401).json({ error: err.message || 'Sign in required.' });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
