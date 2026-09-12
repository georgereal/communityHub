/**
 * Auth domain router — Mongo password + Firebase/app session cookie.
 * vercel.json rewrites keep /api/auth-session and /api/auth-password URLs.
 * Handlers are loaded lazily so password login does not pull firebase-admin.
 */
function authPathFromReq(req) {
    const rewritten = req.query?.__authPath;
    if (typeof rewritten === 'string' && rewritten) return rewritten.replace(/^\/+|\/+$/g, '');
    try {
        const raw = req.url || '';
        const u = new URL(raw.startsWith('http') ? raw : `http://local${raw}`);
        const path = u.pathname.replace(/\/+$/, '');
        if (path.endsWith('/auth-session') || path.endsWith('/auth/session')) return 'session';
        if (path.endsWith('/auth-password') || path.endsWith('/auth/password')) return 'password';
        const idx = path.indexOf('/api/auth/');
        if (idx >= 0) return path.slice(idx + '/api/auth/'.length).split('/').filter(Boolean)[0] || '';
    } catch { /* ignore */ }
    return '';
}

export default async function handler(req, res) {
    const path = authPathFromReq(req);
    if (path === 'session' || path === 'auth-session') {
        const { default: authSession } = await import('../../../packages/server/auth-session.js');
        return authSession(req, res);
    }
    if (path === 'password' || path === 'auth-password') {
        const { default: authPassword } = await import('../../../packages/server/auth-password.js');
        return authPassword(req, res);
    }
    return res.status(404).json({
        error: `No route for auth path "${path || '(empty)'}". Use /api/auth-session or /api/auth-password.`,
    });
}
