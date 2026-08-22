#!/usr/bin/env node
/**
 * Vendors page (finance_config.vendors) maintenance.
 *
 * Default / --title-case: Title Case names on the Vendors directory only.
 * Does NOT read or rewrite vouchers / ledger, and does NOT rebuild the list
 * from bill/ledger text.
 *
 * Usage:
 *   npm run consolidate:vendors-mongo -- --dry-run --title-case
 *   npm run consolidate:vendors-mongo -- --apply --title-case
 *   npm run consolidate:vendors-mongo -- --apply --reset-directory
 *
 * Dangerous (legacy): rewrite voucher/ledger vendor_name + rebuild directory
 *   … --apply --title-case --include-records
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient } from 'mongodb';

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
        dryRun: true,
        apply: false,
        resetDirectory: false,
        titleCase: true,
        includeRecords: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--dry-run') {
            out.dryRun = true;
            out.apply = false;
        } else if (arg === '--apply') {
            out.apply = true;
            out.dryRun = false;
        } else if (arg === '--reset-directory') {
            out.resetDirectory = true;
        } else if (arg === '--title-case') {
            out.titleCase = true;
        } else if (arg === '--include-records') {
            out.includeRecords = true;
        } else if (arg === '--apartment') {
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

function nowIso() {
    return new Date().toISOString();
}

function titleCaseVendorName(name) {
    const ACRONYMS = new Set([
        'llp', 'pvt', 'ltd', 'llc', 'opc', 'gst', 'dg', 'upi', 'neft', 'rtgs', 'imps',
        'bescom', 'bwssb', 'act',
    ]);
    const raw = String(name || '').trim().replace(/\s+/g, ' ');
    if (!raw) return '';
    return raw.split(/(\s+|-)/).map((part) => {
        if (!part || /^\s+$/.test(part) || part === '-') return part;
        const lower = part.toLowerCase();
        const bare = lower.replace(/\./g, '');
        if (ACRONYMS.has(bare)) return bare.toUpperCase();
        if (/^\d+[a-z]+$/i.test(part)) {
            return part.replace(/^(\d+)([a-z]+)$/i, (_, n, letters) => n + letters.toUpperCase());
        }
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    }).join('');
}

/**
 * Title-case Vendors page rows; merge case-only duplicates; keep notes/phone/email.
 * Never touches vouchers or ledger.
 */
async function titleCaseDirectory(db, apartmentId, { dryRun }) {
    const filter = { apartment_id: apartmentId };
    const cfg = await db.collection('finance_config').findOne(filter);
    const list = [...(cfg?.vendors || [])];
    const before = list.length;

    /** @type {Map<string, object>} */
    const byKey = new Map();
    const renames = [];

    for (const row of list) {
        const oldName = String(row.name || '').trim();
        if (!oldName) continue;
        const nextName = titleCaseVendorName(oldName);
        const key = nextName.toLowerCase();
        const existing = byKey.get(key);
        if (existing) {
            existing.use_count = (existing.use_count || 0) + (row.use_count || 0);
            existing.notes = existing.notes || row.notes || null;
            existing.contact_phone = existing.contact_phone || row.contact_phone || row.phone || null;
            existing.contact_email = existing.contact_email || row.contact_email || row.email || null;
            if (oldName !== nextName) renames.push({ from: oldName, to: nextName, merged: true });
        } else {
            const next = {
                ...row,
                name: nextName,
                contact_phone: row.contact_phone || row.phone || null,
                contact_email: row.contact_email || row.email || null,
                notes: row.notes || null,
            };
            byKey.set(key, next);
            if (oldName !== nextName) renames.push({ from: oldName, to: nextName, merged: false });
        }
    }

    const vendors = [...byKey.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));

    if (!dryRun) {
        await db.collection('finance_config').updateOne(
            filter,
            {
                $set: {
                    vendors,
                    _remodeledAt: new Date(),
                    _schema: 'v2',
                },
                $setOnInsert: {
                    apartment_id: apartmentId,
                    _id: apartmentId,
                },
            },
            { upsert: true },
        );
    }

    return { before, after: vendors.length, renames, vendors };
}

async function main() {
    loadEnvFile(resolve(process.cwd(), '.env.local'));
    loadEnvFile(resolve(process.cwd(), '.env'));
    const args = parseArgs(process.argv.slice(2));

    if (args.includeRecords) {
        console.error(
            'Refusing --include-records. That mode rebuilt Vendors from ledger/bills and is disabled.\n'
            + 'Title-case only the Vendors page with: --apply --title-case',
        );
        process.exitCode = 1;
        return;
    }

    const client = new MongoClient(requireEnv('MONGODB_URI'), { maxPoolSize: 4 });
    await client.connect();
    const db = client.db(requireEnv('MONGODB_DB_NAME'));

    try {
        const filter = args.apartment ? { apartment_id: args.apartment } : {};
        const configs = await db.collection('finance_config').find(filter).toArray();

        if (args.resetDirectory) {
            console.log(`Mode: ${args.dryRun ? 'DRY-RUN' : 'APPLY'} --reset-directory`);
            console.log('Clears finance_config.vendors only. Bills/ledger unchanged.');
            for (const cfg of configs) {
                const n = (cfg.vendors || []).length;
                console.log(`Apartment ${cfg.apartment_id}: directory ${n} → 0`);
                if (!args.dryRun) {
                    await db.collection('finance_config').updateOne(
                        { _id: cfg._id },
                        { $set: { vendors: [], _remodeledAt: new Date() } },
                    );
                }
            }
            if (args.dryRun) console.log('\nDry-run only. Re-run with --apply --reset-directory to write.');
            else console.log('\nDirectory cleared.');
            return;
        }

        console.log(`Mode: ${args.dryRun ? 'DRY-RUN' : 'APPLY'} --title-case (Vendors page only)`);
        console.log('Source: finance_config.vendors — not vouchers, not ledger_entries.\n');

        for (const cfg of configs) {
            const apartmentId = cfg.apartment_id;
            const stats = await titleCaseDirectory(db, apartmentId, { dryRun: args.dryRun });
            console.log(`Apartment ${apartmentId}: ${stats.before} → ${stats.after} vendors`);
            for (const r of stats.renames.slice(0, 40)) {
                console.log(`  ${r.merged ? 'merge' : 'rename'}: "${r.from}" → "${r.to}"`);
            }
            if (stats.renames.length > 40) console.log(`  … ${stats.renames.length - 40} more`);
            if (!stats.renames.length) console.log('  (already Title Case)');
        }

        if (args.dryRun) {
            console.log('\nDry-run only. Re-run with --apply --title-case to write.');
        } else {
            console.log('\nApplied (Vendors page only).');
        }
    } finally {
        await client.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
