/**
 * App-issued session JWTs for Mongo email/password auth (not Firebase).
 * HS256, iss=communityhub, typ=mongo_session.
 */
import crypto from 'node:crypto';

export const APP_JWT_ISS = 'communityhub';
export const APP_JWT_TYP = 'mongo_session';
export const APP_SESSION_TTL_SECONDS = 60 * 60 * 8;

function b64url(buf) {
    return Buffer.from(buf)
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

function b64urlJson(obj) {
    return b64url(JSON.stringify(obj));
}

function fromB64urlJson(segment) {
    const padded = segment + '='.repeat((4 - (segment.length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
}

export function getAppSessionSecret() {
    const secret = (
        process.env.AUTH_SESSION_SECRET
        || process.env.JWT_SECRET
        || process.env.SUPABASE_JWT_SECRET
        || ''
    ).trim();
    if (!secret) {
        throw Object.assign(
            new Error(
                'Missing AUTH_SESSION_SECRET (or JWT_SECRET). Required for email/password sessions.',
            ),
            { status: 500 },
        );
    }
    return secret;
}

export function signAppSessionToken({ userId, email }, ttlSeconds = APP_SESSION_TTL_SECONDS) {
    const secret = getAppSessionSecret();
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = {
        iss: APP_JWT_ISS,
        typ: APP_JWT_TYP,
        sub: String(userId),
        email: String(email || '').trim().toLowerCase(),
        role: 'authenticated',
        iat: now,
        exp: now + ttlSeconds,
    };
    const body = `${b64urlJson(header)}.${b64urlJson(payload)}`;
    const sig = crypto.createHmac('sha256', secret).update(body).digest();
    return `${body}.${b64url(sig)}`;
}

/** Peek JWT payload without verifying (for routing Firebase vs app tokens). */
export function peekJwtPayload(token) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length !== 3) return null;
        return fromB64urlJson(parts[1]);
    } catch {
        return null;
    }
}

export function isAppSessionToken(token) {
    const payload = peekJwtPayload(token);
    return payload?.iss === APP_JWT_ISS && payload?.typ === APP_JWT_TYP;
}

/**
 * @returns {{ user: object|null, error: string|null }}
 */
export function verifyAppSessionToken(token) {
    if (!token) return { user: null, error: 'Sign in required.' };
    const parts = String(token).split('.');
    if (parts.length !== 3) return { user: null, error: 'Sign in required.' };

    let secret;
    try {
        secret = getAppSessionSecret();
    } catch (err) {
        return { user: null, error: err.message || 'Session secret not configured.' };
    }

    try {
        const [headerB64, payloadB64, sigB64] = parts;
        const expected = crypto
            .createHmac('sha256', secret)
            .update(`${headerB64}.${payloadB64}`)
            .digest();
        const actualPadded = sigB64 + '='.repeat((4 - (sigB64.length % 4)) % 4);
        const actual = Buffer.from(actualPadded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
            return { user: null, error: 'Sign in required.' };
        }

        const payload = fromB64urlJson(payloadB64);
        if (payload.iss !== APP_JWT_ISS || payload.typ !== APP_JWT_TYP) {
            return { user: null, error: 'Sign in required.' };
        }
        const expMs = Number(payload.exp || 0) * 1000;
        if (!payload.sub || !expMs || expMs <= Date.now() + 5_000) {
            return { user: null, error: 'Sign in required. Session expired.' };
        }

        return {
            user: {
                id: payload.sub,
                email: payload.email || '',
                role: payload.role || 'authenticated',
                authProvider: 'password',
                app_metadata: { provider: 'password' },
                user_metadata: {},
            },
            error: null,
        };
    } catch {
        return { user: null, error: 'Sign in required.' };
    }
}
