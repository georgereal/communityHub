#!/usr/bin/env node
/**
 * Office Manager (property_manager) — finance read-only + Quick capture.
 *
 * Step 3: add accounts.view to role permission keys (Ledger nav).
 * Step 4: block extra finance pages; ensure Finance CRUD R+C, not U/D.
 *
 *   node scripts/apply-office-manager-finance-rbac.mjs
 *   node scripts/apply-office-manager-finance-rbac.mjs --dry-run
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient } from 'mongodb';
import { DEFAULT_ROLE_PERMISSIONS } from '../apps/new/api/rbacMongo/defaults.js';

const ROLE_KEY = 'property_manager';
const COL_ROLE_PERMS = 'rbac_role_permissions';
const COL_POLICIES = 'rbac_society_policies';
const COL_SOCIETIES = 'rbac_societies';

/** Finance routes hidden for Office Manager (Ledger + Bills stay visible). */
const OFFICE_MANAGER_FINANCE_PAGE_BLOCKS = {
    'fn-reports': false,
    'fn-expense-plan': false,
    'fn-invoices-raised': false,
    'fn-bank-recon': false,
};

/** Society CRUD: read + create (bills/quick capture), no update/delete on accounts. */
const OFFICE_MANAGER_ACCOUNTS_CRUD = {
    create: true,
    read: true,
    update: false,
    delete: false,
};

function loadEnvFile(filePath) {
    if (!existsSync(filePath)) return;
    for (const line of readFileSync(filePath, 'utf8').split('\n')) {
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

function mergePermissionKeys(existing = []) {
    const base = DEFAULT_ROLE_PERMISSIONS[ROLE_KEY] || [];
    const merged = new Set([...base, ...existing, 'accounts.view']);
    merged.delete('accounts.edit');
    return [...merged].sort();
}

async function main() {
    loadEnvFile(resolve(process.cwd(), '.env.local'));
    loadEnvFile(resolve(process.cwd(), '.env'));
    const dryRun = process.argv.includes('--dry-run');

    const permissionKeys = mergePermissionKeys();
    const client = new MongoClient(requireEnv('MONGODB_URI'), { maxPoolSize: 2 });
    await client.connect();
    const db = client.db(requireEnv('MONGODB_DB_NAME'));

    try {
        const societies = await db.collection(COL_SOCIETIES).find({}).project({ apartment_id: 1, name: 1 }).toArray();
        const apartmentIds = societies.map((s) => s.apartment_id).filter(Boolean);
        if (!apartmentIds.length) {
            const fromPolicies = await db.collection(COL_POLICIES).distinct('apartment_id');
            apartmentIds.push(...fromPolicies.filter(Boolean));
        }

        const existingRole = await db.collection(COL_ROLE_PERMS).findOne({ role_key: ROLE_KEY });
        const roleUpdate = {
            role_key: ROLE_KEY,
            permission_keys: permissionKeys,
            updated_at: new Date(),
        };

        const policyUpdates = [];
        for (const apartment_id of apartmentIds) {
            const existing = await db.collection(COL_POLICIES).findOne({ apartment_id }) || {};
            const crud = { ...(existing.crud || {}) };
            const pages = { ...(existing.pages || {}) };
            const roleCrud = { ...(crud[ROLE_KEY] || {}) };
            roleCrud.accounts = { ...OFFICE_MANAGER_ACCOUNTS_CRUD, ...(roleCrud.accounts || {}) };
            roleCrud.accounts.update = false;
            roleCrud.accounts.delete = false;
            roleCrud.accounts.read = true;
            roleCrud.accounts.create = true;
            crud[ROLE_KEY] = roleCrud;
            pages[ROLE_KEY] = {
                ...(pages[ROLE_KEY] || {}),
                ...OFFICE_MANAGER_FINANCE_PAGE_BLOCKS,
            };
            policyUpdates.push({ apartment_id, crud, pages, modules: existing.modules || {} });
        }

        console.log(JSON.stringify({
            dryRun,
            role: {
                before: existingRole?.permission_keys || null,
                after: permissionKeys,
            },
            societies: societies.map((s) => ({ id: s.apartment_id, name: s.name })),
            policyUpdates: policyUpdates.map((p) => ({
                apartment_id: p.apartment_id,
                accountsCrud: p.crud[ROLE_KEY]?.accounts,
                pageBlocks: p.pages[ROLE_KEY],
            })),
        }, null, 2));

        if (dryRun) return;

        await db.collection(COL_ROLE_PERMS).updateOne(
            { role_key: ROLE_KEY },
            { $set: roleUpdate },
            { upsert: true },
        );

        for (const doc of policyUpdates) {
            await db.collection(COL_POLICIES).updateOne(
                { apartment_id: doc.apartment_id },
                {
                    $set: {
                        apartment_id: doc.apartment_id,
                        crud: doc.crud,
                        pages: doc.pages,
                        modules: doc.modules,
                        updated_at: new Date(),
                    },
                },
                { upsert: true },
            );
        }

        console.log('Office Manager finance RBAC applied in Mongo.');
    } finally {
        await client.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
