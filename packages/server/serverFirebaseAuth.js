/**
 * Firebase Auth verification for API routes.
 * Maps Firebase UID → stable app user_id via Mongo rbac_directory.
 *
 * firebase-admin is loaded lazily so Mongo session JWT verification
 * (and /api/auth-password) does not pull jwks-rsa/jose at module init.
 * package.json overrides pin jose@4 (CJS) for Vercel ERR_REQUIRE_ESM.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import {
    ensureRbacIndexes,
    resolveAppUserFromFirebase,
} from '../../apps/new/api/rbacMongo/service.js';
import { isAppSessionToken, verifyAppSessionToken } from './appSessionJwt.js';

const require = createRequire(import.meta.url);

let firebaseAdmin = null;

function loadFirebaseAdmin() {
    if (firebaseAdmin) return firebaseAdmin;
    const app = require('firebase-admin/app');
    const auth = require('firebase-admin/auth');
    firebaseAdmin = {
        initializeApp: app.initializeApp,
        getApps: app.getApps,
        getApp: app.getApp,
        cert: app.cert,
        applicationDefault: app.applicationDefault,
        getAuth: auth.getAuth,
    };
    return firebaseAdmin;
}

const USER_CACHE_TTL_MS = 60_000;
const userByToken = new Map();
const inflightByToken = new Map();
let warnedMissingCreds = false;

function pruneUserCache(now = Date.now()) {
    if (userByToken.size < 40) return;
    for (const [key, entry] of userByToken) {
        if (entry.expiresAt <= now) userByToken.delete(key);
    }
}

function parseJsonObject(raw, label) {
    const text = String(raw || '').trim();
    if (!text) return null;
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || !parsed.private_key) {
            throw new Error('JSON must include private_key (full service account).');
        }
        return parsed;
    } catch (err) {
        throw Object.assign(
            new Error(
                `${label} is not valid service-account JSON. `
                + 'Use FIREBASE_SERVICE_ACCOUNT_FILE=./firebase-service-account.json locally, '
                + 'or a single-line FIREBASE_SERVICE_ACCOUNT_JSON on Vercel. '
                + `Parse error: ${err?.message || err}`,
            ),
            { status: 500, cause: err },
        );
    }
}

/**
 * Load Admin credentials from:
 * 1) FIREBASE_SERVICE_ACCOUNT_FILE (path to JSON — preferred locally)
 * 2) FIREBASE_SERVICE_ACCOUNT_JSON (single-line JSON string)
 * 3) FIREBASE_SERVICE_ACCOUNT_BASE64 (base64 of the JSON)
 */
function parseServiceAccount() {
    const filePath = (process.env.FIREBASE_SERVICE_ACCOUNT_FILE || '').trim();
    if (filePath) {
        const abs = resolve(process.cwd(), filePath);
        if (!existsSync(abs)) {
            throw Object.assign(
                new Error(`FIREBASE_SERVICE_ACCOUNT_FILE not found: ${abs}`),
                { status: 500 },
            );
        }
        return parseJsonObject(readFileSync(abs, 'utf8'), 'FIREBASE_SERVICE_ACCOUNT_FILE');
    }

    const b64 = (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '').trim();
    if (b64) {
        try {
            return parseJsonObject(Buffer.from(b64, 'base64').toString('utf8'), 'FIREBASE_SERVICE_ACCOUNT_BASE64');
        } catch (err) {
            if (err?.status) throw err;
            throw Object.assign(
                new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 could not be decoded.'),
                { status: 500, cause: err },
            );
        }
    }

    const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
    if (!raw) return null;
    // Multline .env values often collapse to "{" — fail with a clear message.
    if (raw === '{' || (!raw.includes('private_key') && raw.length < 80)) {
        throw Object.assign(
            new Error(
                'FIREBASE_SERVICE_ACCOUNT_JSON looks truncated (multiline .env values are not supported). '
                + 'Prefer FIREBASE_SERVICE_ACCOUNT_FILE=./firebase-service-account.json',
            ),
            { status: 500 },
        );
    }
    return parseJsonObject(raw, 'FIREBASE_SERVICE_ACCOUNT_JSON');
}

export function getFirebaseAdminApp() {
    const {
        getApps,
        getApp,
        initializeApp,
        cert,
        applicationDefault,
    } = loadFirebaseAdmin();

    const existing = getApps();
    if (existing.length) return getApp();

    const projectId = (
        process.env.FIREBASE_PROJECT_ID
        || process.env.VITE_FIREBASE_PROJECT_ID
        || ''
    ).trim();
    const serviceAccount = parseServiceAccount();

    if (!projectId && !serviceAccount) {
        if (!warnedMissingCreds) {
            warnedMissingCreds = true;
            console.warn(
                '[serverFirebaseAuth] Missing FIREBASE_PROJECT_ID / service account. '
                + 'Set FIREBASE_SERVICE_ACCOUNT_FILE or FIREBASE_SERVICE_ACCOUNT_JSON.',
            );
        }
        throw Object.assign(
            new Error('Firebase Admin is not configured.'),
            { status: 500 },
        );
    }

    if (serviceAccount) {
        return initializeApp({
            credential: cert(serviceAccount),
            projectId: projectId || serviceAccount.project_id,
        });
    }

    return initializeApp({
        credential: applicationDefault(),
        projectId,
    });
}

export function getFirebaseAuth() {
    const { getAuth } = loadFirebaseAdmin();
    getFirebaseAdminApp();
    return getAuth();
}

/**
 * Ensure custom claim app_user_id matches the stable Mongo user_id.
 * @returns {Promise<boolean>} true if the client should force-refresh the ID token
 */
export async function ensureAppUserClaim(firebaseUid, appUserId, decodedToken = null) {
    if (!firebaseUid || !appUserId) return false;
    if (decodedToken?.app_user_id && String(decodedToken.app_user_id) === String(appUserId)) {
        return false;
    }
    const auth = getFirebaseAuth();
    const userRecord = await auth.getUser(firebaseUid);
    const current = userRecord.customClaims?.app_user_id;
    if (current && String(current) === String(appUserId)) return false;
    await auth.setCustomUserClaims(firebaseUid, {
        ...(userRecord.customClaims || {}),
        app_user_id: appUserId,
    });
    return true;
}

function providersFromToken(decoded) {
    const names = [];
    const firebase = decoded.firebase || {};
    if (firebase.sign_in_provider) names.push(String(firebase.sign_in_provider));
    const identities = firebase.identities || {};
    for (const key of Object.keys(identities)) {
        if (!names.includes(key)) names.push(key);
    }
    return names;
}

/**
 * Verify a Bearer token: CommunityHub Mongo session JWT, else Firebase ID token.
 * Maps to stable app user_id via Mongo rbac_directory.
 */
export async function getUserFromAuthHeader(authHeader, { setClaims = false } = {}) {
    if (!authHeader?.startsWith('Bearer ')) {
        return { user: null, error: 'Sign in required.' };
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) return { user: null, error: 'Sign in required.' };

    const now = Date.now();
    const cached = userByToken.get(token);
    if (cached && cached.expiresAt > now) {
        return { user: cached.user, error: null, claimsUpdated: false };
    }

    // Mongo email/password session (does not touch Firebase).
    if (isAppSessionToken(token)) {
        const verified = verifyAppSessionToken(token);
        if (verified.user) {
            userByToken.set(token, { user: verified.user, expiresAt: now + USER_CACHE_TTL_MS });
            pruneUserCache(now);
            return { user: verified.user, error: null, claimsUpdated: false };
        }
        return { user: null, error: verified.error || 'Sign in required.' };
    }

    let pending = inflightByToken.get(token);
    if (!pending) {
        pending = (async () => {
            let decoded;
            try {
                decoded = await getFirebaseAuth().verifyIdToken(token, true);
            } catch (err) {
                const message = err?.code === 'auth/id-token-expired'
                    ? 'Sign in required. Session expired.'
                    : (err?.message || 'Sign in required.');
                return { user: null, error: message, claimsUpdated: false };
            }

            const firebaseUid = decoded.uid;
            const email = decoded.email || '';
            const emailVerified = !!decoded.email_verified;
            const displayName = decoded.name || decoded.user_metadata?.full_name || '';

            try {
                await ensureRbacIndexes();
            } catch {
                /* indexes are best-effort */
            }

            let linked;
            try {
                linked = await resolveAppUserFromFirebase({
                    firebaseUid,
                    email,
                    emailVerified,
                    displayName,
                    providers: providersFromToken(decoded),
                    preferredUserId: decoded.app_user_id || null,
                });
            } catch (err) {
                return {
                    user: null,
                    error: err?.message || 'Could not link identity.',
                    claimsUpdated: false,
                };
            }

            let claimsUpdated = false;
            if (setClaims) {
                try {
                    claimsUpdated = await ensureAppUserClaim(firebaseUid, linked.userId, decoded);
                } catch (err) {
                    console.warn('[serverFirebaseAuth] setCustomUserClaims failed:', err?.message || err);
                }
            }

            const user = {
                id: linked.userId,
                email: linked.email || email || '',
                firebaseUid,
                role: 'authenticated',
                authProvider: 'firebase',
                email_verified: emailVerified,
                app_metadata: {},
                user_metadata: {
                    full_name: displayName || linked.fullName || '',
                },
            };

            userByToken.set(token, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
            pruneUserCache();
            return { user, error: null, claimsUpdated };
        })().finally(() => {
            inflightByToken.delete(token);
        });
        inflightByToken.set(token, pending);
    }

    return pending;
}
