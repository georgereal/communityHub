#!/usr/bin/env node
/**
 * Copy remaining high-volume / log tables from Supabase → Mongo (1:1).
 * Also folds unit_transitions onto existing property_units documents.
 *
 * Usage:
 *   npm run migrate:logs-mongo
 *   npm run migrate:logs-mongo -- --apartment <uuid>
 *   npm run migrate:logs-mongo -- --dry-run
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { MongoClient } from 'mongodb';
import ws from 'ws';

const PAGE_SIZE = 1000;
const UNITS_COL = 'property_units';

const LOG_TABLES = [
    { name: 'activity_audit_log' },
    { name: 'vehicle_audit_log' },
    { name: 'user_notifications' },
    { name: 'email_outbox' },
    { name: 'sms_outbox' },
];

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
    const out = { apartment: null, dryRun: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--dry-run') out.dryRun = true;
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

function embedTransition(row) {
    return {
        id: row.id,
        unit_id: row.unit_id,
        transition_type: row.transition_type,
        status: row.status,
        checklist: row.checklist || {},
        notes: row.notes || null,
        created_at: row.created_at,
        completed_at: row.completed_at || null,
    };
}

async function fetchAll(supabase, table, apartmentId, orderField = 'id') {
    const rows = [];
    let offset = 0;
    while (true) {
        let query = supabase.from(table).select('*').order(orderField, { ascending: true })
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

async function migrateTable({ supabase, db, table, apartmentId, dryRun }) {
    const migratedAt = new Date().toISOString();
    const rows = await fetchAll(supabase, table, apartmentId);
    const docs = rows.map((row) => ({
        ...row,
        _id: row.id,
        _migratedAt: migratedAt,
    })).filter((d) => d._id);
    if (!dryRun && docs.length) {
        await db.collection(table).bulkWrite(
            docs.map((doc) => ({
                replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
            })),
            { ordered: false },
        );
        await db.collection(table).createIndex({ apartment_id: 1 }).catch(() => {});
    }
    return { table, read: rows.length, upserted: docs.length };
}

async function foldTransitions({ supabase, db, apartmentId, dryRun }) {
    const rows = await fetchAll(supabase, 'unit_transitions', apartmentId);
    const byUnit = new Map();
    for (const row of rows) {
        if (!row.unit_id) continue;
        if (!byUnit.has(row.unit_id)) byUnit.set(row.unit_id, []);
        byUnit.get(row.unit_id).push(embedTransition(row));
    }
    let unitsUpdated = 0;
    if (!dryRun) {
        for (const [unitId, transitions] of byUnit) {
            const result = await db.collection(UNITS_COL).updateOne(
                { _id: unitId },
                { $set: { transitions, updated_at: new Date().toISOString() } },
            );
            if (result.matchedCount) unitsUpdated += 1;
        }
    } else {
        unitsUpdated = byUnit.size;
    }
    return { read: rows.length, unitsUpdated, skippedUnits: byUnit.size - unitsUpdated };
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

    const mongo = new MongoClient(requireEnv('MONGODB_URI'));
    await mongo.connect();
    const db = mongo.db(requireEnv('MONGODB_DB_NAME'));
    const supabase = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        realtime: { transport: ws },
    });

    console.log(`Mongo DB: ${db.databaseName}`);
    console.log(`Mode: ${args.dryRun ? 'dry-run (no writes)' : 'upsert'}`);
    if (args.apartment) console.log(`Apartment filter: ${args.apartment}`);

    process.stdout.write('→ unit_transitions → property_units.transitions … ');
    try {
        const t = await foldTransitions({
            supabase, db, apartmentId: args.apartment, dryRun: args.dryRun,
        });
        console.log(`read=${t.read} unitsUpdated=${t.unitsUpdated}`
            + (t.skippedUnits ? ` unmatchedUnits=${t.skippedUnits}` : ''));
    } catch (err) {
        console.log(`ERROR: ${err.message}`);
    }

    let hardFail = false;
    for (const spec of LOG_TABLES) {
        process.stdout.write(`→ ${spec.name} … `);
        try {
            const result = await migrateTable({
                supabase, db, table: spec.name, apartmentId: args.apartment, dryRun: args.dryRun,
            });
            console.log(`read=${result.read} upserted=${result.upserted}`);
        } catch (err) {
            hardFail = true;
            console.log(`ERROR: ${err.message}`);
        }
    }

    await mongo.close();
    if (hardFail) process.exit(1);
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
