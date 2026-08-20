#!/usr/bin/env node
/**
 * Copy property tables from Supabase Postgres → remodeled Mongo collections.
 *
 *   property_units  — one document per flat, with embedded residents[] and vehicles[]
 *   property_slots  — community pool parking slots
 *
 * Postgres remains until Property-New is cut over. Re-running upserts by unit/slot id.
 *
 * Usage:
 *   npm run migrate:property-mongo
 *   npm run migrate:property-mongo -- --apartment <uuid>
 *   npm run migrate:property-mongo -- --dry-run
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { MongoClient } from 'mongodb';
import ws from 'ws';

const PAGE_SIZE = 1000;
const UNITS_COL = 'property_units';
const SLOTS_COL = 'property_slots';
const SCHEMA = 1;

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
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
}

function normUnit(n) {
    return String(n || '').trim().toUpperCase();
}

async function fetchAll(supabase, table, apartmentId) {
    const rows = [];
    let offset = 0;
    while (true) {
        let query = supabase.from(table).select('*').order('id', { ascending: true }).range(offset, offset + PAGE_SIZE - 1);
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

function embedVehicle(v) {
    return {
        id: v.id,
        plate: String(v.plate || '').trim().toUpperCase(),
        type: String(v.type || 'CAR').toUpperCase() === 'BIKE' ? 'BIKE' : 'CAR',
        is_parking_active: v.is_parking_active !== false,
        allocation_type: v.allocation_type || 'BASE',
        allocated_unit_id: v.allocated_unit_id || null,
        slot_id: v.slot_id || null,
        notes: v.notes || null,
        unit_id: v.unit_id,
    };
}

function embedResident(r) {
    return {
        id: r.id,
        apartment_id: r.apartment_id,
        unit_number: r.unit_number,
        kind: (r.kind || 'OWNER').toUpperCase(),
        full_name: r.full_name,
        phone: r.phone || null,
        email: r.email || null,
        notes: r.notes || null,
        is_primary: !!r.is_primary,
        is_residing: r.is_residing !== false,
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

    process.stdout.write('→ units / vehicles / residents / parking_slots … ');
    const [units, vehicles, residents, slots] = await Promise.all([
        fetchAll(supabase, 'units', args.apartment),
        fetchAll(supabase, 'vehicles', args.apartment),
        fetchAll(supabase, 'residents', args.apartment),
        fetchAll(supabase, 'parking_slots', args.apartment),
    ]);

    const vehiclesByUnit = new Map();
    for (const v of vehicles) {
        const key = v.unit_id;
        if (!vehiclesByUnit.has(key)) vehiclesByUnit.set(key, []);
        vehiclesByUnit.get(key).push(embedVehicle(v));
    }

    const residentsByNumber = new Map();
    for (const r of residents) {
        const key = `${r.apartment_id}:${normUnit(r.unit_number)}`;
        if (!residentsByNumber.has(key)) residentsByNumber.set(key, []);
        residentsByNumber.get(key).push(embedResident(r));
    }

    const migratedAt = new Date().toISOString();
    const unitDocs = units.map((u) => ({
        _id: u.id,
        apartment_id: u.apartment_id,
        number: normUnit(u.number),
        block: u.block || null,
        bhk: u.bhk || null,
        area_sqft: u.area_sqft ?? null,
        car_limit: u.car_limit ?? 0,
        bike_limit: u.bike_limit ?? 0,
        occupancy_status: u.occupancy_status || null,
        notes: u.notes || null,
        is_community: !!u.is_community,
        vehicles: vehiclesByUnit.get(u.id) || [],
        residents: residentsByNumber.get(`${u.apartment_id}:${normUnit(u.number)}`) || [],
        _schema: SCHEMA,
        _migratedAt: migratedAt,
        created_at: u.created_at || migratedAt,
        updated_at: u.updated_at || migratedAt,
    }));

    const slotDocs = slots.map((s) => {
        const { id, ...rest } = s;
        return {
            ...rest,
            _id: id,
            id,
            _schema: SCHEMA,
            _migratedAt: migratedAt,
        };
    });

    const unmatchedResidents = residents.filter((r) => {
        const key = `${r.apartment_id}:${normUnit(r.unit_number)}`;
        return !units.some((u) => u.apartment_id === r.apartment_id && normUnit(u.number) === normUnit(r.unit_number));
    });
    if (unmatchedResidents.length) {
        console.warn(`  skipped ${unmatchedResidents.length} residents with no matching unit`);
    }

    if (!args.dryRun) {
        if (unitDocs.length) {
            await db.collection(UNITS_COL).bulkWrite(
                unitDocs.map((doc) => ({
                    replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
                })),
                { ordered: false },
            );
        }
        if (slotDocs.length) {
            await db.collection(SLOTS_COL).bulkWrite(
                slotDocs.map((doc) => ({
                    replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
                })),
                { ordered: false },
            );
        }
        await db.collection(UNITS_COL).createIndexes([
            { key: { apartment_id: 1, number: 1 }, unique: true, name: 'apt_number' },
            { key: { apartment_id: 1 }, name: 'apt' },
        ]).catch(() => {});
        await db.collection(SLOTS_COL).createIndex({ apartment_id: 1 }, { name: 'apt' }).catch(() => {});
    }

    console.log(`\nDone. upserted units=${unitDocs.length} slots=${slotDocs.length}${args.dryRun ? ' (dry-run)' : ''}`);
    await mongo.close();
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
