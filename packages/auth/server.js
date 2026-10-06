/**
 * Firebase Auth session for API routes. No table reads beyond identity link.
 */
import { getUserFromAuthHeader } from '../server/serverFirebaseAuth.js';

const SESSION_COOKIE = 'communityhub_session';
const SESSION_TTL_SECONDS = 60 * 60 * 8;

function cookieAttrs({ clearing = false } = {}) {
    // Secure cookies are not stored/sent on plain HTTP. For IP-first VPS smoke tests
    // set SESSION_COOKIE_SECURE=0 in /etc/communityhub.env (turn back on for HTTPS).
    const secureFlag = process.env.SESSION_COOKIE_SECURE;
    const useSecure = secureFlag === '1' || secureFlag === 'true'
        || (secureFlag !== '0' && secureFlag !== 'false' && process.env.NODE_ENV === 'production');
    return [
        clearing ? 'Max-Age=0' : `Max-Age=${SESSION_TTL_SECONDS}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        useSecure ? 'Secure' : '',
    ].filter(Boolean).join('; ');
}

export function parseCookies(cookieHeader = '') {
    return Object.fromEntries(
        String(cookieHeader || '')
            .split(';')
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => {
                const idx = part.indexOf('=');
                if (idx < 0) return [part, ''];
                return [decodeURIComponent(part.slice(0, idx)), decodeURIComponent(part.slice(idx + 1))];
            }),
    );
}

function bearerFromHeader(headers = {}) {
    const authHeader = headers.authorization || headers.Authorization || '';
    return typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader
        : '';
}

export function setSessionCookie(res, accessToken) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(accessToken)}; ${cookieAttrs()}`);
}

export function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${cookieAttrs({ clearing: true })}`);
}

export function authHeaderFromRequest(req) {
    const direct = bearerFromHeader(req.headers);
    if (direct) return direct;
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies[SESSION_COOKIE];
    return token ? `Bearer ${token}` : '';
}

export async function requireSession(req) {
    const authHeader = authHeaderFromRequest(req);
    const { user, error } = await getUserFromAuthHeader(authHeader);
    if (error || !user?.id) {
        throw Object.assign(new Error(error || 'Sign in required.'), { status: 401 });
    }
    return { user, authHeader };
}
