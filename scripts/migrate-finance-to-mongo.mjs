#!/usr/bin/env node
/**
 * Stage 1: copy finance tables from Supabase Postgres → MongoDB (communityHub).
 * Postgres remains source of truth; this script only upserts documents.
 *
 * Usage:
 *   npm run migrate:finance-mongo
 *   npm run migrate:finance-mongo -- --apartment <uuid>
 *   npm run migrate:finance-mongo -- --dry-run
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { MongoClient } from 'mongodb';
import ws from 'ws';

const PAGE_SIZE = 1000;

/** Full finance hydrate set + related finance tables (OAuth/sync excluded). */
const FINANCE_TABLES = [
    { name: 'transactions' },
    { name: 'expense_vendors' },
    { name: 'expense_sub_categories' },
    { name: 'apartment_bank_accounts' },
    { name: 'finance_documents' },
    { name: 'maintenance_invoices' },
    { name: 'maintenance_payment_allocations' },
    { name: 'maintenance_charge_heads' },
    { name: 'maintenance_invoice_lines' },
    { name: 'maintenance_penalty_rules' },
    { name: 'maintenance_billing_groups' },
    // Composite PK (group_id, unit_id) — no single id column
    { name: 'maintenance_billing_group_units', idFields: ['group_id', 'unit_id'], orderFields: ['group_id', 'unit_id'] },
    { name: 'maintenance_billing_batches' },
    { name: 'maintenance_billing_batch_skips' },
    { name: 'maintenance_reminder_log' },
    { name: 'bank_statement_imports' },
    { name: 'bank_statement_lines' },
    { name: 'bank_classification_rules' },
    { name: 'chart_of_accounts' },
    { name: 'journal_entries' },
    { name: 'journal_lines' },
    { name: 'expense_plan_items' },
    { name: 'expense_plan_recurring' },
    { name: 'nobroker_invoices_raised' },
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
        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
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
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function tableMeta(spec) {
    const idFields = spec.idFields || ['id'];
    const orderFields = spec.orderFields || idFields;
    return { name: spec.name, idFields, orderFields };
}

function rowToDoc(row, migratedAt, idFields) {
    if (!row) return null;
    const parts = [];
    for (const field of idFields) {
        if (row[field] == null) return null;
        parts.push(String(row[field]));
    }
    const _id = parts.join(':');
    return {
        ...row,
        _id,
        _migratedAt: migratedAt,
    };
}

async function fetchPage(supabase, table, orderFields, apartmentId, from, to) {
    let query = supabase.from(table).select('*');
    for (const field of orderFields) {
        query = query.order(field, { ascending: true });
    }
    query = query.range(from, to);
    if (apartmentId) {
        query = query.eq('apartment_id', apartmentId);
    }
    const { data, error } = await query;
    if (error) {
        throw Object.assign(new Error(`${table}: ${error.message}`), { table, cause: error });
    }
    return data || [];
}

async function migrateTable({ supabase, db, spec, apartmentId, dryRun }) {
    const { name: table, idFields, orderFields } = tableMeta(spec);
    const migratedAt = new Date();
    let offset = 0;
    let read = 0;
    let upserted = 0;
    let skipped = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const from = offset;
        const to = offset + PAGE_SIZE - 1;
        const rows = await fetchPage(supabase, table, orderFields, apartmentId, from, to);
        if (!rows.length) break;

        read += rows.length;
        const docs = [];
        for (const row of rows) {
            const doc = rowToDoc(row, migratedAt, idFields);
            if (!doc) {
                skipped += 1;
                continue;
            }
            docs.push(doc);
        }

        if (!dryRun && docs.length) {
            const ops = docs.map((doc) => ({
                replaceOne: {
                    filter: { _id: doc._id },
                    replacement: doc,
                    upsert: true,
                },
            }));
            await db.collection(table).bulkWrite(ops, { ordered: false });
            upserted += docs.length;
        } else if (dryRun) {
            upserted += docs.length;
        }

        if (rows.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }

    if (!dryRun && read > 0) {
        await db.collection(table).createIndex({ apartment_id: 1 });
    }

    return { table, read, upserted, skipped };
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
    if (args.apartment) console.log(`Apartment filter: ${args.apartment}`);
    else console.log('Apartment filter: all');

    if (args.apartment) {
        const { data: apt, error } = await supabase
            .from('apartments')
            .select('id, name')
            .eq('id', args.apartment)
            .maybeSingle();
        if (error) throw new Error(`apartments lookup failed: ${error.message}`);
        if (!apt) throw new Error(`Apartment not found: ${args.apartment}`);
        console.log(`Apartment: ${apt.name} (${apt.id})`);
    }

    const results = [];
    let hardFail = false;

    for (const spec of FINANCE_TABLES) {
        process.stdout.write(`→ ${spec.name} … `);
        try {
            const result = await migrateTable({
                supabase,
                db,
                spec,
                apartmentId: args.apartment,
                dryRun: args.dryRun,
            });
            results.push(result);
            console.log(`read=${result.read} upserted=${result.upserted}`
                + (result.skipped ? ` skipped=${result.skipped}` : ''));
        } catch (err) {
            hardFail = true;
            console.log(`ERROR: ${err.message}`);
            results.push({ table: spec.name, read: 0, upserted: 0, skipped: 0, error: err.message });
        }
    }

    const totalRead = results.reduce((s, r) => s + (r.read || 0), 0);
    const totalUpserted = results.reduce((s, r) => s + (r.upserted || 0), 0);
    console.log(`\nDone. Tables=${results.length} read=${totalRead} upserted=${totalUpserted}`);

    await mongo.close();
    if (hardFail) process.exit(1);
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
