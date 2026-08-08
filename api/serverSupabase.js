import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import ws from 'ws';

/** Reuse one service client in the Node/Vite process — avoids per-request TLS setup. */
let serviceClientSingleton = null;

/** Short-lived auth cache — avoids re-hitting Auth API on every /api call. */
const userByToken = new Map();
/** Coalesce concurrent getUser calls for the same token (HMR / boot stampede). */
const inflightUserByToken = new Map();
const USER_CACHE_TTL_MS = 60_000;
const GET_USER_TIMEOUT_MS = 8_000;
let warnedBadJwtSecret = false;

function serverClientOptions(authHeader = '') {
    return {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
        },
        global: authHeader ? { headers: { Authorization: authHeader } } : undefined,
        // Node 20 has no global WebSocket — supabase-js refuses to construct without this.
        realtime: {
            transport: ws,
        },
    };
}

export function getSupabaseEnv() {
    const supabaseUrl = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const jwtSecret = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || '';

    if (!supabaseUrl || !supabaseAnonKey) {
        throw Object.assign(
            new Error('Missing Supabase environment variables. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'),
            { status: 500 },
        );
    }

    return { supabaseUrl, supabaseAnonKey, supabaseServiceKey, jwtSecret };
}

export function createUserClient(authHeader) {
    const { supabaseUrl, supabaseAnonKey } = getSupabaseEnv();
    return createClient(supabaseUrl, supabaseAnonKey, serverClientOptions(authHeader));
}

export function createServiceClient() {
    if (serviceClientSingleton) return serviceClientSingleton;
    const { supabaseUrl, supabaseServiceKey } = getSupabaseEnv();
    if (!supabaseServiceKey) {
        throw Object.assign(
            new Error('Missing Supabase environment variable SUPABASE_SERVICE_ROLE_KEY.'),
            { status: 500 },
        );
    }
    serviceClientSingleton = createClient(supabaseUrl, supabaseServiceKey, serverClientOptions());
    return serviceClientSingleton;
}

function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((_, reject) => {
            timer = setTimeout(() => {
                reject(Object.assign(new Error(`${label} timed out after ${ms}ms.`), { status: 401 }));
            }, ms);
        }),
    ]);
}

function pruneUserCache(now = Date.now()) {
    if (userByToken.size < 40) return;
    for (const [key, entry] of userByToken) {
        if (entry.expiresAt <= now) userByToken.delete(key);
    }
}

function b64urlJson(segment) {
    const padded = segment + '='.repeat((4 - (segment.length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
}

function warnIfJwtSecretLooksWrong(jwtSecret) {
    if (warnedBadJwtSecret || !jwtSecret) return;
    // Opaque API keys (sb_secret_ / sb_publishable_) are not HS256 JWT secrets.
    if (/^sb_(secret|publishable)_/i.test(jwtSecret)) {
        warnedBadJwtSecret = true;
        console.warn(
            '[serverSupabase] SUPABASE_JWT_SECRET looks like an API key (sb_secret_/sb_publishable_), not the Legacy JWT secret. '
            + 'Local JWT verify is skipped; every /api call will hit Auth getUser() (slow / can time out). '
            + 'Set SUPABASE_JWT_SECRET to Project Settings → API → JWT Secret (Legacy HS256).',
        );
    }
}

/**
 * Verify Supabase access token locally (HS256) when SUPABASE_JWT_SECRET is set.
 * Avoids a network round-trip to Auth on every API call.
 */
function userFromVerifiedJwt(token, jwtSecret) {
    if (!jwtSecret || !token) return null;
    warnIfJwtSecretLooksWrong(jwtSecret);
    if (/^sb_(secret|publishable)_/i.test(jwtSecret)) return null;

    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    try {
        const header = b64urlJson(headerB64);
        if (header.alg && header.alg !== 'HS256') return null;

        const expected = crypto
            .createHmac('sha256', jwtSecret)
            .update(`${headerB64}.${payloadB64}`)
            .digest();
        const actualPadded = sigB64 + '='.repeat((4 - (sigB64.length % 4)) % 4);
        const actual = Buffer.from(actualPadded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
            return null;
        }

        const payload = b64urlJson(payloadB64);
        const expMs = Number(payload.exp || 0) * 1000;
        if (!payload.sub || !expMs || expMs <= Date.now() + 5_000) return null;

        return {
            id: payload.sub,
            email: payload.email || payload.user_metadata?.email || '',
            role: payload.role || 'authenticated',
            app_metadata: payload.app_metadata || {},
            user_metadata: payload.user_metadata || {},
        };
    } catch {
        return null;
    }
}

async function fetchUserFromAuthApi(token) {
    // Prefer service-role getUser(jwt) — one shared client, no per-request anon client.
    try {
        const service = createServiceClient();
        const { data, error } = await withTimeout(
            service.auth.getUser(token),
            GET_USER_TIMEOUT_MS,
            'Auth validation',
        );
        const user = data?.user || null;
        if (!error && user) return { user, error: null };
        if (error) {
            return { user: null, error: error.message || 'Sign in required.' };
        }
    } catch (err) {
        if (err?.status === 401 || /timed out/i.test(String(err?.message || ''))) {
            return { user: null, error: err?.message || 'Sign in required.' };
        }
        // Fall through to anon client if service key missing / unexpected.
    }

    const userClient = createUserClient(`Bearer ${token}`);
    const { data, error } = await withTimeout(
        userClient.auth.getUser(token),
        GET_USER_TIMEOUT_MS,
        'Auth validation',
    );
    const user = data?.user || null;
    if (error || !user) {
        return { user: null, error: error?.message || 'Sign in required.' };
    }
    return { user, error: null };
}

export async function getUserFromAuthHeader(authHeader) {
    if (!authHeader?.startsWith('Bearer ')) {
        return { user: null, error: 'Sign in required.' };
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) return { user: null, error: 'Sign in required.' };

    const now = Date.now();
    const cached = userByToken.get(token);
    if (cached && cached.expiresAt > now) {
        return { user: cached.user, error: null };
    }

    const { jwtSecret } = getSupabaseEnv();
    const localUser = userFromVerifiedJwt(token, jwtSecret);
    if (localUser) {
        userByToken.set(token, { user: localUser, expiresAt: now + USER_CACHE_TTL_MS });
        pruneUserCache(now);
        return { user: localUser, error: null };
    }

    let pending = inflightUserByToken.get(token);
    if (!pending) {
        pending = fetchUserFromAuthApi(token)
            .then((result) => {
                if (result.user) {
                    userByToken.set(token, { user: result.user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
                    pruneUserCache();
                }
                return result;
            })
            .finally(() => {
                inflightUserByToken.delete(token);
            });
        inflightUserByToken.set(token, pending);
    }

    try {
        return await pending;
    } catch (err) {
        return { user: null, error: err?.message || 'Sign in required.' };
    }
}
