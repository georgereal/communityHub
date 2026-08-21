#!/usr/bin/env node
/**
 * Copy Integrations tables from Supabase Postgres → Mongo.
 *
 *   apartment_external_connections  →  external_connections
 *   passbook_ocr_jobs               →  passbook_ocr_jobs
 *
 * Mongo is the New source of truth for Admin Integrations + Evolyx passbook OCR.
 * Re-running upserts by (apartment_id, provider, connection_key) and job id.
 *
 * Usage:
 *   npm run migrate:integrations-mongo
 *   npm run migrate:integrations-mongo -- --apartment <uuid>
 *   npm run migrate:integrations-mongo -- --dry-run
 *   npm run migrate:integrations-mongo -- --skip-jobs
 *   npm run migrate:integrations-mongo -- --skip-connections
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { MongoClient } from 'mongodb';
import ws from 'ws';

const PAGE_SIZE = 500;
const CONNECTIONS_COL = 'external_connections';
const JOBS_COL = 'passbook_ocr_jobs';
const SCHEMA = 'integrations_v1';

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
        skipJobs: false,
        skipConnections: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--dry-run') out.dryRun = true;
        else if (arg === '--skip-jobs') out.skipJobs = true;
        else if (arg === '--skip-connections') out.skipConnections = true;
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

async function fetchAll(supabase, table, apartmentId, { orderBy = 'id' } = {}) {
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
        if (error) {
            if (/does not exist|relation|Could not find/i.test(error.message)) {
                console.warn(`\n  (skip ${table}: ${error.message})`);
                return [];
            }
            throw new Error(`${table}: ${error.message}`);
        }
        const page = data || [];
        rows.push(...page);
        if (page.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }
    return rows;
}

function mapConnection(row, migratedAt) {
    return {
        id: row.id || crypto.randomUUID(),
        apartment_id: row.apartment_id,
        provider: row.provider,
        connection_key: row.connection_key,
        display_name: row.display_name || null,
        base_url: row.base_url,
        client_id: row.client_id || null,
        workflow_id: row.workflow_id || null,
        api_key: row.api_key || null,
        enabled: row.enabled !== false,
        config: row.config && typeof row.config === 'object' ? row.config : {},
        configured_by: row.configured_by || null,
        created_at: row.created_at || migratedAt,
        updated_at: row.updated_at || migratedAt,
        _schema: SCHEMA,
        _migratedFrom: 'supabase',
        _migratedAt: migratedAt,
    };
}

function mapJob(row, migratedAt) {
    const doc = {
        id: row.id,
        apartment_id: row.apartment_id,
        provider: row.provider || 'EVOLYX',
        status: row.status || 'INITIALIZED',
        workflow_id: row.workflow_id || null,
        request_id: row.request_id || null,
        created_by: row.created_by || null,
        callback_token: row.callback_token || null,
        file_count: row.file_count || 0,
        total_bytes: row.total_bytes || 0,
        file_names: Array.isArray(row.file_names) ? row.file_names : [],
        mapped_line_count: row.mapped_line_count || 0,
        import_count: row.import_count || 0,
        imported_statement_import_id: row.imported_statement_import_id || null,
        imported_at: row.imported_at || null,
        started_at: row.started_at || null,
        completed_at: row.completed_at || null,
        last_error: row.last_error || null,
        last_error_detail: row.last_error_detail || null,
        provider_response: row.provider_response || null,
        mapped_lines: Array.isArray(row.mapped_lines) ? row.mapped_lines : [],
        created_at: row.created_at || migratedAt,
        updated_at: row.updated_at || migratedAt,
        _schema: SCHEMA,
        _migratedFrom: 'supabase',
        _migratedAt: migratedAt,
    };
    if (row.execution_id) doc.execution_id = row.execution_id;
    return doc;
}

async function ensureIndexes(db) {
    const jobs = db.collection(JOBS_COL);
    try {
        const existing = await jobs.indexExists('uq_passbook_jobs_execution');
        if (existing) {
            const info = await jobs.indexInformation({ full: true });
            const spec = (info || []).find((i) => i.name === 'uq_passbook_jobs_execution');
            if (!spec?.partialFilterExpression) {
                await jobs.dropIndex('uq_passbook_jobs_execution');
            }
        }
    } catch {
        // ok
    }
    await Promise.all([
        db.collection(CONNECTIONS_COL).createIndexes([
            {
                key: { apartment_id: 1, provider: 1, connection_key: 1 },
                unique: true,
                name: 'uq_external_connections_apartment_provider_key',
            },
            { key: { apartment_id: 1, provider: 1 }, name: 'idx_external_connections_apartment_provider' },
        ]),
        jobs.createIndexes([
            { key: { apartment_id: 1, created_at: -1 }, name: 'idx_passbook_jobs_apartment_created' },
            {
                key: { execution_id: 1 },
                unique: true,
                name: 'uq_passbook_jobs_execution',
                partialFilterExpression: {
                    execution_id: { $type: 'string', $gt: '' },
                },
            },
            { key: { id: 1 }, unique: true, name: 'uq_passbook_jobs_id' },
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
        upserted: result.upsertedCount || 0,
        modified: result.modifiedCount || 0,
    };
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
    const migratedAt = new Date().toISOString();

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

    if (!args.dryRun) {
        process.stdout.write('→ indexes … ');
        await ensureIndexes(db);
        console.log('ok');
    }

    let connectionsWritten = 0;
    let jobsWritten = 0;

    if (!args.skipConnections) {
        process.stdout.write('→ apartment_external_connections … ');
        const rows = await fetchAll(supabase, 'apartment_external_connections', args.apartment);
        const docs = rows.map((r) => mapConnection(r, migratedAt));
        const withKey = docs.filter((d) => d.apartment_id && d.provider && d.connection_key && d.base_url);
        const skipped = docs.length - withKey.length;
        const result = await upsertMany(
            db.collection(CONNECTIONS_COL),
            withKey,
            (doc) => ({
                apartment_id: doc.apartment_id,
                provider: doc.provider,
                connection_key: doc.connection_key,
            }),
            args,
        );
        connectionsWritten = result.written;
        console.log(`${rows.length} rows → ${args.dryRun ? 'would write' : 'upsert'} ${withKey.length}${skipped ? ` (skipped ${skipped} incomplete)` : ''}`);
    } else {
        console.log('→ connections skipped (--skip-connections)');
    }

    if (!args.skipJobs) {
        process.stdout.write('→ passbook_ocr_jobs … ');
        const rows = await fetchAll(supabase, 'passbook_ocr_jobs', args.apartment, { orderBy: 'created_at' });
        const docs = rows.filter((r) => r.id).map((r) => mapJob(r, migratedAt));
        const result = await upsertMany(
            db.collection(JOBS_COL),
            docs,
            (doc) => ({ id: doc.id }),
            args,
        );
        jobsWritten = result.written;
        console.log(`${rows.length} rows → ${args.dryRun ? 'would write' : 'upsert'} ${docs.length}`);
    } else {
        console.log('→ jobs skipped (--skip-jobs)');
    }

    if (!args.dryRun) {
        const [connCount, jobCount] = await Promise.all([
            db.collection(CONNECTIONS_COL).countDocuments(args.apartment ? { apartment_id: args.apartment } : {}),
            db.collection(JOBS_COL).countDocuments(args.apartment ? { apartment_id: args.apartment } : {}),
        ]);
        console.log(`\nMongo totals${args.apartment ? ' (apartment)' : ''}:`);
        console.log(`  ${CONNECTIONS_COL}: ${connCount}`);
        console.log(`  ${JOBS_COL}: ${jobCount}`);
    }

    console.log(`\nDone. connections≈${connectionsWritten}, jobs≈${jobsWritten}`);
    await mongo.close();
}

main().catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
});
