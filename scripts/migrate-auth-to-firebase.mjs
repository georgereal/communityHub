#!/usr/bin/env node
/**
 * Migrate Supabase Auth users → Mongo rbac_directory (+ optional Firebase password import).
 *
 * - Upserts directory rows with user_id = Supabase UUID, email, legacy_supabase_uid.
 * - Password users: import bcrypt hashes into Firebase when available; else create
 *   email accounts without password (user must reset).
 * - Social-only users: directory only — they re-login via Google/GitHub; server links
 *   firebase_uid by verified email and keeps RBAC.
 *
 *   npm run migrate:auth-firebase
 *   npm run migrate:auth-firebase -- --dry-run
 *   npm run migrate:auth-firebase -- --skip-firebase
 *   npm run migrate:auth-firebase -- --mongo-only   (directory from profiles / listUsers)
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createClient } from '@supabase/supabase-js';
import { MongoClient } from 'mongodb';
import ws from 'ws';

const require = createRequire(import.meta.url);
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

const COL_DIRECTORY = 'rbac_directory';
const PAGE_SIZE = 200;

function loadEnvFile(filePath) {
    if (!existsSync(filePath)) return;
    const text = readFileSync(filePath, 'utf8');
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = value;
    }
}

function argFlag(name) {
    return process.argv.includes(name);
}

function argValue(name) {
    const idx = process.argv.indexOf(name);
    if (idx < 0) return null;
    return process.argv[idx + 1] || null;
}

function loadUsersFromJson(filePath) {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    const rows = Array.isArray(raw) ? raw : (raw.users || raw.auth_users || []);
    return rows.map((row) => ({
        id: row.id || row.uid,
        email: row.email,
        email_confirmed_at: row.email_confirmed_at || row.email_confirmed_at || (row.email_confirmed ? new Date().toISOString() : null),
        encrypted_password: row.encrypted_password || row.password_hash || null,
        user_metadata: row.user_metadata || row.raw_user_meta_data || {},
        app_metadata: row.app_metadata || row.raw_app_meta_data || {},
        identities: row.identities || [],
    }));
}

function parseServiceAccount() {
    const filePath = (process.env.FIREBASE_SERVICE_ACCOUNT_FILE || '').trim();
    if (filePath) {
        const abs = resolve(process.cwd(), filePath);
        if (!existsSync(abs)) throw new Error(`FIREBASE_SERVICE_ACCOUNT_FILE not found: ${abs}`);
        return JSON.parse(readFileSync(abs, 'utf8'));
    }
    const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
    if (!raw) return null;
    return JSON.parse(raw);
}

function initFirebaseAdmin() {
    if (getApps().length) return getApps()[0];
    const projectId = (
        process.env.FIREBASE_PROJECT_ID
        || process.env.VITE_FIREBASE_PROJECT_ID
        || ''
    ).trim();
    const serviceAccount = parseServiceAccount();
    if (!serviceAccount && !projectId) {
        throw new Error('Set FIREBASE_SERVICE_ACCOUNT_FILE or FIREBASE_SERVICE_ACCOUNT_JSON (and FIREBASE_PROJECT_ID).');
    }
    if (serviceAccount) {
        return initializeApp({
            credential: cert(serviceAccount),
            projectId: projectId || serviceAccount.project_id,
        });
    }
    return initializeApp({ projectId });
}

async function listSupabaseAuthUsers(supabase) {
    const users = [];
    let page = 1;
    while (true) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
        if (error) throw new Error(`listUsers: ${error.message}`);
        const batch = data?.users || [];
        users.push(...batch);
        if (batch.length < PAGE_SIZE) break;
        page += 1;
    }
    return users;
}

async function listProfilesFallback(supabase) {
    const rows = [];
    let offset = 0;
    while (true) {
        const { data, error } = await supabase
            .from('profiles')
            .select('id, email, full_name, role')
            .range(offset, offset + PAGE_SIZE - 1);
        if (error) throw new Error(`profiles: ${error.message}`);
        rows.push(...(data || []));
        if (!data || data.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }
    return rows.map((p) => ({
        id: p.id,
        email: p.email,
        user_metadata: { full_name: p.full_name },
        app_metadata: { providers: ['email'] },
        identities: [],
        email_confirmed_at: p.email ? new Date().toISOString() : null,
        encrypted_password: null,
        _fromProfiles: true,
        role: p.role,
    }));
}

function providersForUser(user) {
    const fromIdentities = (user.identities || []).map((i) => i.provider).filter(Boolean);
    const fromMeta = user.app_metadata?.providers || user.app_metadata?.provider
        ? [].concat(user.app_metadata.providers || user.app_metadata.provider)
        : [];
    return [...new Set([...fromIdentities, ...fromMeta].map(String))];
}

function hasPasswordIdentity(user) {
    const providers = providersForUser(user);
    if (providers.includes('email') || providers.includes('phone')) return true;
    // Supabase often stores password hash even when user also linked Google
    if (user.encrypted_password) return true;
    return providers.length === 0 && !!user.email;
}

function isSocialOnly(user) {
    const providers = providersForUser(user);
    const social = providers.filter((p) => p !== 'email' && p !== 'phone');
    return social.length > 0 && !hasPasswordIdentity(user);
}

async function upsertDirectory(directory, user, { dryRun }) {
    const userId = user.id;
    const email = String(user.email || '').trim().toLowerCase() || null;
    const fullName = user.user_metadata?.full_name || user.user_metadata?.name || null;
    const providers = providersForUser(user);
    const doc = {
        user_id: userId,
        email,
        full_name: fullName,
        legacy_supabase_uid: userId,
        auth_providers: providers,
        updated_at: new Date(),
    };
    if (user.role) doc.role = user.role;

    if (dryRun) {
        console.log('[dry-run] directory upsert', { user_id: userId, email, providers });
        return;
    }

    const existing = await directory.findOne({ user_id: userId });
    const $set = { ...doc };
    // Never overwrite an existing firebase_uid
    if (existing?.firebase_uid) {
        delete $set.firebase_uid;
    }

    await directory.updateOne(
        { user_id: userId },
        {
            $set,
            $setOnInsert: {
                created_at: new Date(),
                ...(existing?.firebase_uid ? {} : {}),
            },
        },
        { upsert: true },
    );
}

async function importPasswordUserToFirebase(auth, user, { dryRun }) {
    const email = String(user.email || '').trim().toLowerCase();
    if (!email) {
        console.warn('skip firebase import (no email)', user.id);
        return { status: 'skipped' };
    }

    const hash = user.encrypted_password || null;
    const importEntry = {
        uid: undefined, // let Firebase assign; we link by email later
        email,
        emailVerified: !!user.email_confirmed_at,
        displayName: user.user_metadata?.full_name || user.user_metadata?.name || undefined,
        // Preserve stable mapping via custom claims after import
        customClaims: { app_user_id: user.id },
    };

    if (hash) {
        // Supabase Auth stores bcrypt ($2a$). Firebase importUsers accepts bcrypt.
        importEntry.passwordHash = Buffer.from(hash);
        importEntry.hashAlgorithm = 'BCRYPT';
    }

    if (dryRun) {
        console.log('[dry-run] firebase import', {
            email,
            hasHash: !!hash,
            app_user_id: user.id,
        });
        return { status: 'dry-run' };
    }

    try {
        // Prefer importUsers when we have a hash; else createUser without password.
        if (hash) {
            const result = await auth.importUsers([importEntry], {
                hash: { algorithm: 'BCRYPT' },
            });
            if (result.failureCount) {
                const err = result.errors?.[0]?.error;
                // Already exists — set claims on existing user by email
                if (/already exists|email-already-exists/i.test(String(err?.message || err?.code || ''))) {
                    const existing = await auth.getUserByEmail(email);
                    await auth.setCustomUserClaims(existing.uid, {
                        ...(existing.customClaims || {}),
                        app_user_id: user.id,
                    });
                    return { status: 'claims-updated', uid: existing.uid };
                }
                throw err || new Error('importUsers failed');
            }
            const uid = result.successes?.[0]?.uid;
            return { status: 'imported', uid };
        }

        try {
            const created = await auth.createUser({
                email,
                emailVerified: !!user.email_confirmed_at,
                displayName: importEntry.displayName,
            });
            await auth.setCustomUserClaims(created.uid, { app_user_id: user.id });
            console.warn(`created Firebase user without password (reset required): ${email}`);
            return { status: 'created-no-password', uid: created.uid };
        } catch (err) {
            if (err?.code === 'auth/email-already-exists') {
                const existing = await auth.getUserByEmail(email);
                await auth.setCustomUserClaims(existing.uid, {
                    ...(existing.customClaims || {}),
                    app_user_id: user.id,
                });
                return { status: 'claims-updated', uid: existing.uid };
            }
            throw err;
        }
    } catch (err) {
        console.error(`firebase import failed for ${email}:`, err?.message || err);
        return { status: 'error', error: err?.message || String(err) };
    }
}

async function main() {
    loadEnvFile(resolve(process.cwd(), '.env.local'));
    loadEnvFile(resolve(process.cwd(), '.env'));

    const dryRun = argFlag('--dry-run');
    const skipFirebase = argFlag('--skip-firebase') || argFlag('--mongo-only');
    const jsonPath = argValue('--from-json');

    const mongoUri = (process.env.MONGODB_URI || '').trim();
    const mongoDbName = (process.env.MONGODB_DB_NAME || '').trim();
    if (!mongoUri || !mongoDbName) {
        throw new Error('Set MONGODB_URI and MONGODB_DB_NAME.');
    }

    let users;
    if (jsonPath) {
        users = loadUsersFromJson(resolve(process.cwd(), jsonPath));
        console.log(`Loaded ${users.length} users from ${jsonPath}.`);
    } else {
        const supabaseUrl = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '');
        const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
        if (!supabaseUrl || !serviceKey) {
            throw new Error(
                'Set VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, or pass --from-json path/to/auth_users.json',
            );
        }

        const supabase = createClient(supabaseUrl, serviceKey, {
            auth: { persistSession: false, autoRefreshToken: false },
            realtime: { transport: ws },
        });

        try {
            users = await listSupabaseAuthUsers(supabase);
            console.log(`Loaded ${users.length} users from Supabase Auth admin API.`);
            console.log(
                'Note: Admin API usually omits password hashes. For bcrypt import, export auth.users '
                + 'to JSON and re-run with --from-json.',
            );
        } catch (err) {
            console.warn('listUsers failed, falling back to profiles:', err.message);
            users = await listProfilesFallback(supabase);
            console.log(`Loaded ${users.length} users from profiles.`);
        }
    }

    const mongo = new MongoClient(mongoUri);
    await mongo.connect();
    const directory = mongo.db(mongoDbName).collection(COL_DIRECTORY);
    await directory.createIndex({ user_id: 1 }, { unique: true });
    await directory.createIndex({ email: 1 });
    await directory.createIndex(
        { firebase_uid: 1 },
        { unique: true, partialFilterExpression: { firebase_uid: { $type: 'string' } } },
    );

    let firebaseAuth = null;
    if (!skipFirebase) {
        initFirebaseAdmin();
        firebaseAuth = getAuth();
    } else {
        console.log('Skipping Firebase import (--skip-firebase / --mongo-only).');
    }

    const stats = {
        directory: 0,
        socialOnly: 0,
        passwordImport: 0,
        firebaseSkipped: 0,
        errors: 0,
    };

    for (const user of users) {
        await upsertDirectory(directory, user, { dryRun });
        stats.directory += 1;

        if (skipFirebase || !firebaseAuth) continue;

        if (isSocialOnly(user)) {
            stats.socialOnly += 1;
            console.log(`social-only (re-login later): ${user.email || user.id}`);
            continue;
        }

        if (!user.email) {
            stats.firebaseSkipped += 1;
            continue;
        }

        const result = await importPasswordUserToFirebase(firebaseAuth, user, { dryRun });
        if (result.status === 'error') stats.errors += 1;
        else if (result.status === 'skipped') stats.firebaseSkipped += 1;
        else stats.passwordImport += 1;

        // If we know the Firebase uid, optionally store it now (password path only).
        if (!dryRun && result.uid) {
            await directory.updateOne(
                { user_id: user.id, firebase_uid: { $exists: false } },
                { $set: { firebase_uid: result.uid, updated_at: new Date() } },
            );
            // Also allow setting when firebase_uid is null
            await directory.updateOne(
                { user_id: user.id, firebase_uid: null },
                { $set: { firebase_uid: result.uid, updated_at: new Date() } },
            );
        }
    }

    await mongo.close();
    console.log('Done.', { dryRun, skipFirebase, ...stats });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
