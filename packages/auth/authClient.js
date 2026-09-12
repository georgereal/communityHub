/**
 * Firebase Auth client (browser). Exposes a Supabase-shaped `.auth` facade so
 * Classic/New call sites (getSession / getUser / onAuthStateChange / signOut) keep working.
 */
import { initializeApp, getApps } from 'firebase/app';
import {
    getAuth,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    GoogleAuthProvider,
    GithubAuthProvider,
    OAuthProvider,
    signOut as firebaseSignOut,
    getIdToken,
} from 'firebase/auth';
import { clearLedgerOAuthPendingMarkers } from './oauthMarkers.js';

const MONGO_SESSION_KEY = 'ch_mongo_session';

function readFirebaseWebConfig() {
    const apiKey = import.meta.env.VITE_FIREBASE_API_KEY || '';
    const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || '';
    const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID || '';
    const appId = import.meta.env.VITE_FIREBASE_APP_ID || '';
    const messagingSenderId = import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '';
    const storageBucket = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || '';
    if (!apiKey || !projectId) return null;
    return {
        apiKey,
        authDomain: authDomain || `${projectId}.firebaseapp.com`,
        projectId,
        appId: appId || undefined,
        messagingSenderId: messagingSenderId || undefined,
        storageBucket: storageBucket || undefined,
    };
}

const firebaseConfig = readFirebaseWebConfig();
const firebaseApp = firebaseConfig
    ? (getApps().length ? getApps()[0] : initializeApp(firebaseConfig))
    : null;
export const firebaseAuth = firebaseApp ? getAuth(firebaseApp) : null;

let authInitPromise = null;
let cachedAppUser = null;
const authListeners = new Set();

function logAuth(step, detail = {}) {
    console.log('[auth]', step, detail);
}

function tokenExpMs(token) {
    try {
        const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        return Number(payload.exp || 0) * 1000;
    } catch {
        return 0;
    }
}

/** Persist Mongo email/password session (not Firebase). */
export function setMongoSession({ access_token, user } = {}) {
    if (!access_token || !user?.id) return;
    try {
        localStorage.setItem(MONGO_SESSION_KEY, JSON.stringify({
            access_token,
            user: {
                id: user.id,
                email: user.email || '',
                auth_class: user.auth_class || 'local',
                auth_methods: user.auth_methods || ['password'],
            },
            storedAt: Date.now(),
        }));
    } catch { /* ignore */ }
    cachedAppUser = { id: user.id, email: user.email || '' };
}

export function clearMongoSession() {
    try {
        localStorage.removeItem(MONGO_SESSION_KEY);
    } catch { /* ignore */ }
}

export function readMongoSession() {
    try {
        const raw = localStorage.getItem(MONGO_SESSION_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const token = parsed?.access_token;
        if (!token || !parsed?.user?.id) return null;
        const exp = tokenExpMs(token);
        if (exp && exp <= Date.now() + 5_000) {
            clearMongoSession();
            return null;
        }
        return {
            access_token: token,
            token_type: 'bearer',
            user: {
                id: parsed.user.id,
                email: parsed.user.email || '',
                role: 'authenticated',
                authProvider: 'password',
                app_metadata: { provider: 'password' },
                user_metadata: {},
            },
        };
    } catch {
        return null;
    }
}

function mapFirebaseUser(fbUser, accessToken = '', appUser = null) {
    if (!fbUser) return null;
    const id = appUser?.id || fbUser.uid;
    return {
        id,
        email: appUser?.email || fbUser.email || '',
        role: 'authenticated',
        app_metadata: {},
        user_metadata: {
            full_name: fbUser.displayName || '',
            avatar_url: fbUser.photoURL || '',
        },
        firebaseUid: fbUser.uid,
        email_verified: !!fbUser.emailVerified,
        // Supabase-shaped session fields used across the app
        access_token: accessToken,
        user: undefined,
    };
}

async function buildSession(fbUser, { forceRefresh = false } = {}) {
    if (!fbUser) return null;
    const accessToken = await getIdToken(fbUser, forceRefresh);
    const mapped = mapFirebaseUser(fbUser, accessToken, cachedAppUser);
    const session = {
        access_token: accessToken,
        token_type: 'bearer',
        user: {
            id: mapped.id,
            email: mapped.email,
            role: 'authenticated',
            app_metadata: mapped.app_metadata,
            user_metadata: mapped.user_metadata,
            email_verified: mapped.email_verified,
            firebaseUid: mapped.firebaseUid,
        },
    };
    return session;
}

function emitAuthEvent(event, session) {
    for (const cb of authListeners) {
        try {
            cb(event, session);
        } catch {
            /* ignore listener errors */
        }
    }
}

async function syncAppUserFromSessionApi(accessToken, { forceRefreshToken = false } = {}) {
    if (!accessToken || !firebaseAuth?.currentUser) return cachedAppUser;
    try {
        const res = await fetch('/api/auth-session', {
            method: 'POST',
            credentials: 'include',
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) return cachedAppUser;
        const json = await res.json().catch(() => ({}));
        if (json?.user?.id) {
            cachedAppUser = { id: json.user.id, email: json.user.email || '' };
        }
        if (json?.claimsUpdated || forceRefreshToken) {
            await getIdToken(firebaseAuth.currentUser, true);
        }
    } catch {
        /* ignore */
    }
    return cachedAppUser;
}

function providerForId(providerId) {
    const id = String(providerId || '').toLowerCase();
    if (id === 'google') return new GoogleAuthProvider();
    if (id === 'github') return new GithubAuthProvider();
    if (id === 'apple') return new OAuthProvider('apple.com');
    if (id === 'facebook') return new OAuthProvider('facebook.com');
    if (id === 'azure' || id === 'microsoft') return new OAuthProvider('microsoft.com');
    return null;
}

/** Exchange OAuth redirect / restore stored session before the rest of the app boots. */
export async function primeAuthSessionFromUrl() {
    const mongo = readMongoSession();
    if (mongo) {
        cachedAppUser = { id: mongo.user.id, email: mongo.user.email || '' };
        logAuth('mongo-session', { email: mongo.user.email || null });
        return { session: mongo, error: null };
    }

    if (!firebaseAuth) return { session: null, error: null };

    try {
        const redirect = await getRedirectResult(firebaseAuth);
        if (redirect?.user) {
            logAuth('redirect-result-ok', { email: redirect.user.email || null });
            const session = await buildSession(redirect.user);
            await syncAppUserFromSessionApi(session.access_token);
            const refreshed = await buildSession(redirect.user, { forceRefresh: true });
            emitAuthEvent('SIGNED_IN', refreshed);
            return { session: refreshed, error: null };
        }
    } catch (err) {
        logAuth('redirect-result-failed', { message: err?.message || 'unknown' });
        return { session: null, error: { message: err?.message || 'Social sign-in could not be completed.' } };
    }

    const fbUser = firebaseAuth.currentUser;
    if (fbUser) {
        const session = await buildSession(fbUser);
        logAuth('stored-session', { email: session?.user?.email || null });
        return { session, error: null };
    }

    // Wait briefly for persistence restore
    const session = await new Promise((resolve) => {
        let settled = false;
        const unsub = onAuthStateChanged(firebaseAuth, async (user) => {
            if (settled) return;
            settled = true;
            unsub();
            if (!user) {
                resolve(null);
                return;
            }
            resolve(await buildSession(user));
        });
        setTimeout(() => {
            if (settled) return;
            settled = true;
            unsub();
            resolve(null);
        }, 2500);
    });

    if (session) {
        logAuth('stored-session', { email: session.user?.email || null });
    } else {
        logAuth('no-session', { href: window.location.href });
    }
    return { session, error: null };
}

export function ensureAuthInitialized() {
    // Mongo email/password sessions work without Firebase configured.
    if (!authInitPromise) {
        authInitPromise = primeAuthSessionFromUrl();
    }
    return authInitPromise;
}

export function resetAuthInit() {
    authInitPromise = null;
}

export async function signOutAuth() {
    try {
        await fetch('/api/auth-session', { method: 'DELETE', credentials: 'include' });
    } catch { /* ignore */ }

    authInitPromise = null;
    cachedAppUser = null;
    clearLedgerOAuthPendingMarkers();
    clearMongoSession();

    try {
        sessionStorage.removeItem('ch_workspace_boot_v1');
        sessionStorage.removeItem('ch_mpa_ctx');
        sessionStorage.removeItem('ch_finance_ctx');
    } catch { /* ignore */ }

    if (firebaseAuth) {
        try {
            await firebaseSignOut(firebaseAuth);
        } catch { /* ignore */ }
    }
}

/** Supabase-compatible auth surface used by Classic + New. */
const authApi = {
    async getSession() {
        const mongo = readMongoSession();
        if (mongo) return { data: { session: mongo }, error: null };

        if (!firebaseAuth?.currentUser) {
            await ensureAuthInitialized();
        }
        const again = readMongoSession();
        if (again) return { data: { session: again }, error: null };

        const user = firebaseAuth?.currentUser;
        if (!user) return { data: { session: null }, error: null };
        const session = await buildSession(user);
        return { data: { session }, error: null };
    },

    async getUser() {
        const { data, error } = await authApi.getSession();
        return { data: { user: data.session?.user || null }, error };
    },

    async refreshSession() {
        const mongo = readMongoSession();
        if (mongo) {
            emitAuthEvent('TOKEN_REFRESHED', mongo);
            return { data: { session: mongo }, error: null };
        }
        const user = firebaseAuth?.currentUser;
        if (!user) return { data: { session: null }, error: null };
        // Force-refresh ID token only — callers post /api/auth-session themselves.
        const refreshed = await buildSession(user, { forceRefresh: true });
        emitAuthEvent('TOKEN_REFRESHED', refreshed);
        return { data: { session: refreshed }, error: null };
    },

    async signInWithPassword({ email, password }) {
        if (!firebaseAuth) {
            return { data: { session: null, user: null }, error: { message: 'Firebase is not configured.' } };
        }
        try {
            const cred = await signInWithEmailAndPassword(firebaseAuth, email, password);
            let session = await buildSession(cred.user);
            await syncAppUserFromSessionApi(session.access_token);
            session = await buildSession(cred.user, { forceRefresh: true });
            emitAuthEvent('SIGNED_IN', session);
            return { data: { session, user: session.user }, error: null };
        } catch (err) {
            return { data: { session: null, user: null }, error: { message: err?.message || 'Sign-in failed.' } };
        }
    },

    async signUp({ email, password }) {
        if (!firebaseAuth) {
            return { data: { session: null, user: null }, error: { message: 'Firebase is not configured.' } };
        }
        try {
            const cred = await createUserWithEmailAndPassword(firebaseAuth, email, password);
            let session = await buildSession(cred.user);
            await syncAppUserFromSessionApi(session.access_token);
            session = await buildSession(cred.user, { forceRefresh: true });
            emitAuthEvent('SIGNED_IN', session);
            return { data: { session, user: session.user }, error: null };
        } catch (err) {
            return { data: { session: null, user: null }, error: { message: err?.message || 'Could not create account.' } };
        }
    },

    async signInWithOAuth({ provider, options = {} } = {}) {
        if (!firebaseAuth) {
            return { data: null, error: { message: 'Firebase is not configured.' } };
        }
        const oauthProvider = providerForId(provider);
        if (!oauthProvider) {
            return { data: null, error: { message: `Unsupported provider: ${provider}` } };
        }
        const useRedirect = options.skipBrowserRedirect === false || options.useRedirect === true;
        try {
            if (useRedirect) {
                await signInWithRedirect(firebaseAuth, oauthProvider);
                return { data: { provider, url: null }, error: null };
            }
            const cred = await signInWithPopup(firebaseAuth, oauthProvider);
            let session = await buildSession(cred.user);
            await syncAppUserFromSessionApi(session.access_token);
            session = await buildSession(cred.user, { forceRefresh: true });
            emitAuthEvent('SIGNED_IN', session);
            return { data: { session, user: session.user, provider, url: null }, error: null };
        } catch (err) {
            // Popup blocked → fall back to redirect. Do NOT treat user-closed popup as blocked
            // (that caused redirect churn).
            if (/popup-blocked/i.test(String(err?.code || err?.message || ''))) {
                try {
                    await signInWithRedirect(firebaseAuth, oauthProvider);
                    return { data: { provider, url: null }, error: null };
                } catch (redirectErr) {
                    return { data: null, error: { message: redirectErr?.message || 'Social sign-in failed.' } };
                }
            }
            return { data: null, error: { message: err?.message || 'Social sign-in failed.' } };
        }
    },

    async signOut() {
        await signOutAuth();
        emitAuthEvent('SIGNED_OUT', null);
        return { error: null };
    },

    onAuthStateChange(callback) {
        if (typeof callback !== 'function') {
            return { data: { subscription: { unsubscribe() {} } }, error: null };
        }
        authListeners.add(callback);
        let unsubFirebase = () => {};
        const mongo = readMongoSession();
        if (mongo) {
            callback('INITIAL_SESSION', mongo);
        } else if (firebaseAuth) {
            let initial = true;
            unsubFirebase = onAuthStateChanged(firebaseAuth, async (user) => {
                if (readMongoSession()) return;
                if (!user) {
                    cachedAppUser = null;
                    if (!initial) emitAuthEvent('SIGNED_OUT', null);
                    else callback('INITIAL_SESSION', null);
                    initial = false;
                    return;
                }
                const session = await buildSession(user);
                if (initial) {
                    callback('INITIAL_SESSION', session);
                    initial = false;
                } else {
                    emitAuthEvent('SIGNED_IN', session);
                }
            });
        } else {
            callback('INITIAL_SESSION', null);
        }
        return {
            data: {
                subscription: {
                    unsubscribe() {
                        authListeners.delete(callback);
                        unsubFirebase();
                    },
                },
            },
            error: null,
        };
    },
};

export const authClient = {
    auth: authApi,
    // Storage moved to /api/storage (R2). Keep a stub so accidental calls fail clearly.
    storage: {
        from() {
            return {
                async upload() {
                    return { data: null, error: { message: 'Use /api/storage for uploads.' } };
                },
                async remove() {
                    return { data: null, error: { message: 'Use /api/storage for deletes.' } };
                },
                async createSignedUrl() {
                    return { data: null, error: { message: 'Use /api/storage for signed URLs.' } };
                },
            };
        },
    },
};

export { syncAppUserFromSessionApi, buildSession, firebaseAuth as hasFirebaseAuth };
