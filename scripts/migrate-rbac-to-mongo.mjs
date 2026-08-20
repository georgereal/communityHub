#!/usr/bin/env node
/**
 * Copy RBAC + society identity from Supabase → Mongo.
 * New UI boot then uses Mongo for membership, directory, and policy.
 *
 *   npm run migrate:rbac-mongo
 *   npm run migrate:rbac-mongo -- --dry-run
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { MongoClient } from 'mongodb';
import ws from 'ws';
import { DEFAULT_ROLE_PERMISSIONS } from '../api/rbacMongo/defaults.js';

const PAGE_SIZE = 1000;
const COL_ASSIGNMENTS = 'rbac_assignments';
const COL_ROLE_PERMS = 'rbac_role_permissions';
const COL_POLICIES = 'rbac_society_policies';
const COL_OVERRIDES = 'rbac_user_overrides';
const COL_META = 'rbac_meta';
const COL_SOCIETIES = 'rbac_societies';
const COL_DIRECTORY = 'rbac_directory';

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

function requireEnv(name) {
    const value = (process.env[name] || '').trim();
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
}

async function fetchAll(supabase, table) {
    const rows = [];
    let offset = 0;
    while (true) {
        const { data, error } = await supabase
            .from(table)
            .select('*')
            .range(offset, offset + PAGE_SIZE - 1);
        if (error) {
            if (new RegExp(table, 'i').test(error.message)) return [];
            throw new Error(`${table}: ${error.message}`);
        }
        rows.push(...(data || []));
        if (!data || data.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }
    return rows;
}

function groupBy(rows, keyFn) {
    const map = new Map();
    for (const row of rows) {
        const key = keyFn(row);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(row);
    }
    return map;
}

async function main() {
    loadEnvFile(resolve(process.cwd(), '.env.local'));
    loadEnvFile(resolve(process.cwd(), '.env'));
    const dryRun = process.argv.includes('--dry-run');

    const supabaseUrl = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!supabaseUrl || !serviceKey) {
        throw new Error('Set VITE_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY in .env.local.');
    }

    const supabase = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        realtime: { transport: ws },
    });

    const [assignments, rolePerms, crud, pages, modules, userPages, userModules, apartments, profiles, memberships] = await Promise.all([
        fetchAll(supabase, 'user_role_assignments'),
        fetchAll(supabase, 'role_permissions'),
        fetchAll(supabase, 'society_role_crud_access'),
        fetchAll(supabase, 'society_role_page_access'),
        fetchAll(supabase, 'society_role_module_access'),
        fetchAll(supabase, 'user_page_overrides'),
        fetchAll(supabase, 'user_module_access'),
        fetchAll(supabase, 'apartments'),
        fetchAll(supabase, 'profiles'),
        fetchAll(supabase, 'user_apartments'),
    ]);

    const rolePermDocs = [];
    const byRole = groupBy(rolePerms, (r) => r.role_key);
    for (const [role_key, rows] of byRole.entries()) {
        rolePermDocs.push({
            role_key,
            permission_keys: [...new Set(rows.map((r) => r.permission_key).filter(Boolean))],
            updated_at: new Date(),
        });
    }
    for (const [role_key, keys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
        if (!byRole.has(role_key)) {
            rolePermDocs.push({ role_key, permission_keys: keys, updated_at: new Date() });
        }
    }

    const assignmentDocs = assignments.map((r) => ({
        user_id: r.user_id,
        apartment_id: r.apartment_id || null,
        role_key: r.role_key,
        scope: r.scope || 'apartment',
        updated_at: new Date(),
    }));
    const assignmentKey = (r) => `${r.user_id}:${r.apartment_id}:${r.scope}`;
    const seenAssign = new Set(assignmentDocs.map(assignmentKey));
    for (const m of memberships) {
        const doc = {
            user_id: m.user_id,
            apartment_id: m.apartment_id,
            role_key: 'resident_viewer',
            scope: 'apartment',
            updated_at: new Date(),
        };
        if (!seenAssign.has(assignmentKey(doc))) {
            assignmentDocs.push(doc);
            seenAssign.add(assignmentKey(doc));
        }
    }

    const societyDocs = apartments
        .filter((a) => a.id && a.name !== '__SYSTEM__')
        .map((a) => ({
            apartment_id: a.id,
            name: a.name || a.id,
            updated_at: new Date(),
        }));

    const directoryDocs = profiles.map((p) => ({
        user_id: p.id,
        email: String(p.email || '').trim().toLowerCase(),
        full_name: p.full_name || null,
        role: p.role || 'resident_viewer',
        last_apartment_id: p.last_apartment_id || null,
        updated_at: new Date(),
    }));

    const aptIds = new Set([
        ...crud.map((r) => r.apartment_id),
        ...pages.map((r) => r.apartment_id),
        ...modules.map((r) => r.apartment_id),
    ].filter(Boolean));

    const policyDocs = [...aptIds].map((apartment_id) => {
        const crudByRole = {};
        crud.filter((r) => r.apartment_id === apartment_id).forEach((r) => {
            crudByRole[r.role_key] = crudByRole[r.role_key] || {};
            crudByRole[r.role_key][r.resource_key] = {
                create: !!r.can_create,
                read: !!r.can_read,
                update: !!r.can_update,
                delete: !!r.can_delete,
            };
        });
        const pagesByRole = {};
        pages.filter((r) => r.apartment_id === apartment_id).forEach((r) => {
            pagesByRole[r.role_key] = pagesByRole[r.role_key] || {};
            pagesByRole[r.role_key][r.route] = r.allowed !== false;
        });
        const modulesByRole = {};
        modules.filter((r) => r.apartment_id === apartment_id).forEach((r) => {
            modulesByRole[r.role_key] = modulesByRole[r.role_key] || {};
            modulesByRole[r.role_key][r.module_key] = r.enabled !== false;
        });
        return {
            apartment_id,
            crud: crudByRole,
            pages: pagesByRole,
            modules: modulesByRole,
            updated_at: new Date(),
        };
    });

    const overrideDocs = [];
    const overrideKey = (userId, apt) => `${userId}:${apt}`;
    const overrideMap = new Map();
    userPages.forEach((r) => {
        const k = overrideKey(r.user_id, r.apartment_id);
        const cur = overrideMap.get(k) || { user_id: r.user_id, apartment_id: r.apartment_id, pages: {}, modules: {} };
        cur.pages[r.route] = r.access;
        overrideMap.set(k, cur);
    });
    userModules.forEach((r) => {
        const k = overrideKey(r.user_id, r.apartment_id);
        const cur = overrideMap.get(k) || { user_id: r.user_id, apartment_id: r.apartment_id, pages: {}, modules: {} };
        cur.modules[r.module_key] = r.enabled !== false;
        overrideMap.set(k, cur);
    });
    overrideMap.forEach((v) => overrideDocs.push({ ...v, updated_at: new Date() }));

    console.log(JSON.stringify({
        dryRun,
        assignments: assignmentDocs.length,
        rolePermissions: rolePermDocs.length,
        policies: policyDocs.length,
        userOverrides: overrideDocs.length,
        societies: societyDocs.length,
        directory: directoryDocs.length,
    }, null, 2));

    if (dryRun) return;

    const client = new MongoClient(requireEnv('MONGODB_URI'), { maxPoolSize: 2 });
    await client.connect();
    const db = client.db(requireEnv('MONGODB_DB_NAME'));
    try {
        if (rolePermDocs.length) {
            const col = db.collection(COL_ROLE_PERMS);
            for (const doc of rolePermDocs) {
                await col.updateOne({ role_key: doc.role_key }, { $set: doc }, { upsert: true });
            }
        }
        if (assignmentDocs.length) {
            const col = db.collection(COL_ASSIGNMENTS);
            await col.deleteMany({});
            await col.insertMany(assignmentDocs);
        }
        if (policyDocs.length) {
            const col = db.collection(COL_POLICIES);
            for (const doc of policyDocs) {
                await col.updateOne({ apartment_id: doc.apartment_id }, { $set: doc }, { upsert: true });
            }
        }
        if (overrideDocs.length) {
            const col = db.collection(COL_OVERRIDES);
            for (const doc of overrideDocs) {
                await col.updateOne(
                    { user_id: doc.user_id, apartment_id: doc.apartment_id },
                    { $set: doc },
                    { upsert: true },
                );
            }
        }
        if (societyDocs.length) {
            const col = db.collection(COL_SOCIETIES);
            for (const doc of societyDocs) {
                await col.updateOne({ apartment_id: doc.apartment_id }, { $set: doc }, { upsert: true });
            }
        }
        if (directoryDocs.length) {
            const col = db.collection(COL_DIRECTORY);
            for (const doc of directoryDocs) {
                await col.updateOne({ user_id: doc.user_id }, { $set: doc }, { upsert: true });
            }
        }
        await db.collection(COL_META).updateOne(
            { _id: 'migration' },
            { $set: { _id: 'migration', source: 'mongo', migrated_at: new Date() } },
            { upsert: true },
        );
        await Promise.all([
            db.collection(COL_ASSIGNMENTS).createIndex({ user_id: 1, apartment_id: 1, scope: 1 }),
            db.collection(COL_ROLE_PERMS).createIndex({ role_key: 1 }, { unique: true }),
            db.collection(COL_POLICIES).createIndex({ apartment_id: 1 }, { unique: true }),
            db.collection(COL_OVERRIDES).createIndex({ user_id: 1, apartment_id: 1 }, { unique: true }),
            db.collection(COL_SOCIETIES).createIndex({ apartment_id: 1 }, { unique: true }),
            db.collection(COL_DIRECTORY).createIndex({ user_id: 1 }, { unique: true }),
            db.collection(COL_DIRECTORY).createIndex({ email: 1 }),
        ]);
        console.log('RBAC + identity migration complete. New UI boot uses Mongo.');
    } finally {
        await client.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
