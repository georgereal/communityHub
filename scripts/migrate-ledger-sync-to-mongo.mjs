#!/usr/bin/env node
/**
 * Copy ledger spreadsheet sync tables from Supabase Postgres → Mongo.
 *
 * Prefers renamed probe tables (`*_temp`), then falls back to live names:
 *   ledger_sync_settings[_temp]           → ledger_sync_settings
 *   ledger_sync_oauth_apps[_temp]         → ledger_sync_oauth_apps
 *   user_oauth_connections[_temp]         → user_oauth_connections
 *   ledger_sync_service_accounts[_temp]   → ledger_sync_service_accounts
 *   ledger_sync_runs[_temp]               → ledger_sync_runs
 *
 * Usage:
 *   npm run migrate:ledger-sync-mongo
 *   npm run migrate:ledger-sync-mongo -- --apartment <uuid>
 *   npm run migrate:ledger-sync-mongo -- --dry-run
 *   npm run migrate:ledger-sync-mongo -- --skip-tokens
 *   npm run migrate:ledger-sync-mongo -- --from-live   # skip *_temp, use live names only
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { MongoClient } from 'mongodb';
import ws from 'ws';
import {
    COL_OAUTH_APPS,
    COL_RUNS,
    COL_SERVICE_ACCOUNTS,
    COL_SETTINGS,
    COL_USER_OAUTH,
    mapOAuthAppDoc,
    mapRunDoc,
    mapServiceAccountDoc,
    mapSettingsDoc,
    mapUserOAuthDoc,
} from '../apps/new/api/integrationsMongo/spreadsheetStore.js';

const PAGE_SIZE = 500;

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

function parseArgs(argv) {
    const out = {
        apartment: null,
        dryRun: false,
        skipTokens: false,
        fromLive: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--dry-run') out.dryRun = true;
        else if (arg === '--skip-tokens') out.skipTokens = true;
        else if (arg === '--from-live') out.fromLive = true;
        else if (arg === '--apartment') {
            out.apartment = argv[i + 1] || null;
            i += 1;
        } else if (arg.startsWith('--apartment=')) {
            out.apartment = arg.slice('--apartment='.length) || null;
        }
    }
    return out;
}

function requireEnv(name) {
    const value = (process.env[name] || '').trim();
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
}

async function resolveTable(supabase, baseName, { fromLive }) {
    const candidates = fromLive ? [baseName] : [`${baseName}_temp`, baseName];
    for (const name of candidates) {
        const { error } = await supabase.from(name).select('*').limit(1);
        if (!error) return name;
        if (!/does not exist|Could not find|relation|schema cache/i.test(error.message || '')) {
            throw new Error(`${name}: ${error.message}`);
        }
    }
    return null;
}

async function fetchAll(supabase, table, apartmentId, { orderBy = 'apartment_id' } = {}) {
    const rows = [];
    let offset = 0;
    while (true) {
        let query = supabase
            .from(table)
            .select('*')
            .order(orderBy, { ascending: true })
            .range(offset, offset + PAGE_SIZE - 1);
        if (apartmentId) query = query.eq('apartment_id', apartmentId);
        const { data, error } = await query;
        if (error) throw new Error(`${table}: ${error.message}`);
        const page = data || [];
        rows.push(...page);
        if (page.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }
    return rows;
}

async function ensureIndexes(db) {
    await Promise.all([
        db.collection(COL_SETTINGS).createIndexes([
            { key: { apartment_id: 1 }, unique: true, name: 'uq_ledger_sync_settings_apartment' },
        ]),
        db.collection(COL_OAUTH_APPS).createIndexes([
            {
                key: { apartment_id: 1, provider: 1 },
                unique: true,
                name: 'uq_ledger_sync_oauth_apps_apartment_provider',
            },
        ]),
        db.collection(COL_USER_OAUTH).createIndexes([
            {
                key: { user_id: 1, apartment_id: 1, provider: 1 },
                unique: true,
                name: 'uq_user_oauth_connections_user_apt_provider',
            },
        ]),
        db.collection(COL_SERVICE_ACCOUNTS).createIndexes([
            {
                key: { apartment_id: 1, provider: 1 },
                unique: true,
                name: 'uq_ledger_sync_service_accounts_apartment_provider',
            },
        ]),
        db.collection(COL_RUNS).createIndexes([
            { key: { apartment_id: 1, started_at: -1 }, name: 'idx_ledger_sync_runs_apartment_started' },
            { key: { id: 1 }, unique: true, name: 'uq_ledger_sync_runs_id' },
        ]),
    ]);
}

async function upsertMany(collection, docs, filterFn, { dryRun }) {
    if (!docs.length) return { written: 0 };
    if (dryRun) return { written: docs.length };
    const ops = docs.map((doc) => ({
        updateOne: {
            filter: filterFn(doc),
            update: { $set: doc },
            upsert: true,
        },
    }));
    const result = await collection.bulkWrite(ops, { ordered: false });
    return {
        written: (result.upsertedCount || 0) + (result.modifiedCount || 0) + (result.matchedCount || 0),
    };
}

async function migrateTable({
    supabase, db, baseName, apartmentId, dryRun, fromLive, mapFn, filterFn, orderBy,
}) {
    const table = await resolveTable(supabase, baseName, { fromLive });
    if (!table) {
        console.log(`→ ${baseName} … (no table — skipped)`);
        return 0;
    }
    process.stdout.write(`→ ${table} … `);
    const rows = await fetchAll(supabase, table, apartmentId, { orderBy });
    const migratedAt = new Date().toISOString();
    const docs = rows.map((r) => mapFn(r, migratedAt)).filter(Boolean);
    const colName = baseName === 'ledger_sync_settings' ? COL_SETTINGS
        : baseName === 'ledger_sync_oauth_apps' ? COL_OAUTH_APPS
            : baseName === 'user_oauth_connections' ? COL_USER_OAUTH
                : baseName === 'ledger_sync_runs' ? COL_RUNS
                    : COL_SERVICE_ACCOUNTS;
    const col = db.collection(colName);
    const result = await upsertMany(col, docs, filterFn, { dryRun });
    console.log(`${rows.length} rows → ${dryRun ? 'would write' : 'upsert'} ${docs.length}`);
    return result.written;
}

async function main() {
    loadEnvFile(resolve(process.cwd(), '.env.local'));
    loadEnvFile(resolve(process.cwd(), '.env'));

    const args = parseArgs(process.argv.slice(2));
    const supabaseUrl = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!supabaseUrl || !serviceKey) {
        throw new Error('Set VITE_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.');
    }

    const mongoUri = requireEnv('MONGODB_URI');
    const mongoDbName = requireEnv('MONGODB_DB_NAME');

    const supabase = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        realtime: { transport: ws },
    });

    const mongo = new MongoClient(mongoUri);
    await mongo.connect();
    const db = mongo.db(mongoDbName);

    console.log(`Mongo DB: ${mongoDbName}`);
    console.log(`Mode: ${args.dryRun ? 'dry-run (no writes)' : 'upsert'}`);
    console.log(`Source preference: ${args.fromLive ? 'live names only' : '*_temp then live'}`);
    if (args.apartment) console.log(`Apartment filter: ${args.apartment}`);
    else console.log('Apartment filter: all');

    if (!args.dryRun) {
        process.stdout.write('→ indexes … ');
        await ensureIndexes(db);
        console.log('ok');
    }

    const written = {};

    written.settings = await migrateTable({
        supabase,
        db,
        baseName: 'ledger_sync_settings',
        apartmentId: args.apartment,
        dryRun: args.dryRun,
        fromLive: args.fromLive,
        mapFn: (r, t) => (r.apartment_id ? mapSettingsDoc(r, t) : null),
        filterFn: (doc) => ({ apartment_id: doc.apartment_id }),
        orderBy: 'apartment_id',
    });

    written.oauthApps = await migrateTable({
        supabase,
        db,
        baseName: 'ledger_sync_oauth_apps',
        apartmentId: args.apartment,
        dryRun: args.dryRun,
        fromLive: args.fromLive,
        mapFn: (r, t) => (r.apartment_id && r.provider ? mapOAuthAppDoc(r, t) : null),
        filterFn: (doc) => ({ apartment_id: doc.apartment_id, provider: doc.provider }),
        orderBy: 'apartment_id',
    });

    if (!args.skipTokens) {
        written.userOAuth = await migrateTable({
            supabase,
            db,
            baseName: 'user_oauth_connections',
            apartmentId: args.apartment,
            dryRun: args.dryRun,
            fromLive: args.fromLive,
            mapFn: (r, t) => (r.user_id && r.apartment_id && r.provider ? mapUserOAuthDoc(r, t) : null),
            filterFn: (doc) => ({
                user_id: doc.user_id,
                apartment_id: doc.apartment_id,
                provider: doc.provider,
            }),
            orderBy: 'apartment_id',
        });

        written.serviceAccounts = await migrateTable({
            supabase,
            db,
            baseName: 'ledger_sync_service_accounts',
            apartmentId: args.apartment,
            dryRun: args.dryRun,
            fromLive: args.fromLive,
            mapFn: (r, t) => (r.apartment_id && r.provider ? mapServiceAccountDoc(r, t) : null),
            filterFn: (doc) => ({ apartment_id: doc.apartment_id, provider: doc.provider }),
            orderBy: 'apartment_id',
        });
    } else {
        console.log('→ tokens skipped (--skip-tokens)');
    }

    written.runs = await migrateTable({
        supabase,
        db,
        baseName: 'ledger_sync_runs',
        apartmentId: args.apartment,
        dryRun: args.dryRun,
        fromLive: args.fromLive,
        mapFn: (r, t) => (r.apartment_id && r.id ? mapRunDoc(r, t) : null),
        filterFn: (doc) => ({ _id: doc._id }),
        orderBy: 'started_at',
    });

    if (!args.dryRun) {
        const filter = args.apartment ? { apartment_id: args.apartment } : {};
        const [s, a, u, svc, runs] = await Promise.all([
            db.collection(COL_SETTINGS).countDocuments(filter),
            db.collection(COL_OAUTH_APPS).countDocuments(filter),
            db.collection(COL_USER_OAUTH).countDocuments(filter),
            db.collection(COL_SERVICE_ACCOUNTS).countDocuments(filter),
            db.collection(COL_RUNS).countDocuments(filter),
        ]);
        console.log(`\nMongo totals${args.apartment ? ' (apartment)' : ''}:`);
        console.log(`  ${COL_SETTINGS}: ${s}`);
        console.log(`  ${COL_OAUTH_APPS}: ${a}`);
        console.log(`  ${COL_USER_OAUTH}: ${u}`);
        console.log(`  ${COL_SERVICE_ACCOUNTS}: ${svc}`);
        console.log(`  ${COL_RUNS}: ${runs}`);
    }

    console.log('\nDone.', written);
    await mongo.close();
}

main().catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
});
