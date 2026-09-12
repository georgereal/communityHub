/**
 * Mongo email/password auth — credentials live on rbac_directory.
 * Same email as a social (Firebase) user resolves to the same user_id.
 */
import bcrypt from 'bcryptjs';
import {
    ensureRbacIndexes,
    findDirectoryByEmail,
    getDirectoryProfile,
} from '../../apps/new/api/rbacMongo/service.js';
import { getMongoDb } from './mongoClient.js';
import { signAppSessionToken } from './appSessionJwt.js';

const COL_DIRECTORY = 'rbac_directory';
const BCRYPT_ROUNDS = 10;

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function classifyAuthMethods(methods = []) {
    const set = [...new Set((methods || []).map(String).filter(Boolean))];
    const hasPassword = set.includes('password');
    const hasSocial = set.some((m) => m !== 'password');
    let authClass = 'local';
    if (hasPassword && hasSocial) authClass = 'hybrid';
    else if (hasSocial) authClass = 'social';
    return { auth_methods: set, auth_class: authClass };
}

async function directoryCol() {
    const db = await getMongoDb();
    return db.collection(COL_DIRECTORY);
}

async function mergeAuthMethods(userId, methodsToAdd = []) {
    const col = await directoryCol();
    const row = await col.findOne({ user_id: userId });
    const merged = classifyAuthMethods([
        ...(row?.auth_methods || []),
        ...(row?.auth_providers || []),
        ...methodsToAdd,
    ]);
    await col.updateOne(
        { user_id: userId },
        {
            $set: {
                auth_methods: merged.auth_methods,
                auth_class: merged.auth_class,
                updated_at: new Date(),
            },
        },
    );
    return merged;
}

/**
 * Register or attach a password credential for an email.
 * - New email → new user_id + password
 * - Existing social-only email → add password to same user_id
 * - Existing password email → error (use sign-in)
 */
export async function registerPasswordUser({ email, password, fullName = '' } = {}) {
    const emailKey = normalizeEmail(email);
    const pass = String(password || '');
    if (!emailKey || !emailKey.includes('@')) {
        throw Object.assign(new Error('A valid email is required.'), { status: 400 });
    }
    if (pass.length < 8) {
        throw Object.assign(new Error('Password must be at least 8 characters.'), { status: 400 });
    }

    await ensureRbacIndexes();
    const col = await directoryCol();
    const existing = await findDirectoryByEmail(emailKey);
    const hash = await bcrypt.hash(pass, BCRYPT_ROUNDS);
    const now = new Date();

    if (existing?.user_id) {
        if (existing.password_hash) {
            throw Object.assign(
                new Error('An account with this email already has a password. Sign in instead.'),
                { status: 409 },
            );
        }
        // Social (or directory-only) user — attach password, keep same user_id.
        const methods = classifyAuthMethods([
            ...(existing.auth_methods || []),
            ...(existing.auth_providers || []),
            'password',
        ]);
        await col.updateOne(
            { user_id: existing.user_id },
            {
                $set: {
                    email: emailKey,
                    password_hash: hash,
                    auth_methods: methods.auth_methods,
                    auth_class: methods.auth_class,
                    full_name: fullName || existing.full_name || null,
                    updated_at: now,
                },
            },
        );
        const token = signAppSessionToken({ userId: existing.user_id, email: emailKey });
        return {
            access_token: token,
            user: {
                id: existing.user_id,
                email: emailKey,
                auth_class: methods.auth_class,
                auth_methods: methods.auth_methods,
            },
            created: false,
            linked: true,
        };
    }

    const userId = crypto.randomUUID();
    const methods = classifyAuthMethods(['password']);
    await col.updateOne(
        { user_id: userId },
        {
            $set: {
                user_id: userId,
                email: emailKey,
                full_name: fullName || null,
                password_hash: hash,
                auth_methods: methods.auth_methods,
                auth_class: methods.auth_class,
                role: 'resident_viewer',
                updated_at: now,
            },
            $setOnInsert: { created_at: now },
        },
        { upsert: true },
    );

    const token = signAppSessionToken({ userId, email: emailKey });
    return {
        access_token: token,
        user: {
            id: userId,
            email: emailKey,
            auth_class: methods.auth_class,
            auth_methods: methods.auth_methods,
        },
        created: true,
        linked: false,
    };
}

export async function loginPasswordUser({ email, password } = {}) {
    const emailKey = normalizeEmail(email);
    const pass = String(password || '');
    if (!emailKey || !pass) {
        throw Object.assign(new Error('Email and password required.'), { status: 400 });
    }

    await ensureRbacIndexes();
    const existing = await findDirectoryByEmail(emailKey);
    if (!existing?.user_id) {
        throw Object.assign(new Error('Invalid email or password.'), { status: 401 });
    }
    if (!existing.password_hash) {
        throw Object.assign(
            new Error(
                'This email uses social sign-in only. Continue with Google/GitHub, '
                + 'or create a password via “Create account” to enable email login.',
            ),
            { status: 401 },
        );
    }

    const ok = await bcrypt.compare(pass, existing.password_hash);
    if (!ok) {
        throw Object.assign(new Error('Invalid email or password.'), { status: 401 });
    }

    const methods = await mergeAuthMethods(existing.user_id, ['password']);
    const token = signAppSessionToken({ userId: existing.user_id, email: emailKey });
    const profile = await getDirectoryProfile(existing.user_id);
    return {
        access_token: token,
        user: {
            id: existing.user_id,
            email: emailKey,
            full_name: profile?.full_name || null,
            auth_class: methods.auth_class,
            auth_methods: methods.auth_methods,
        },
    };
}
