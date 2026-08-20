#!/usr/bin/env node
/**
 * Stage 1b: remodel flat Postgres-mirror collections → Mongo-native documents.
 *
 * Reads stage-1 collections (1 table = 1 collection) and writes remodeled ones:
 *
 *   ledger_entries     ← transactions + reverse refs (vouchers, bank matches, dues payments)
 *   vouchers           ← finance_documents (kind OUT=bill, IN=receipt)
 *   bank_imports       ← bank_statement_imports with embedded lines[]
 *   dues_invoices      ← maintenance_invoices with embedded lines[] + payments[]
 *   billing_groups     ← groups with embedded unitIds[]
 *   billing_batches    ← batches with embedded skips[]
 *   finance_config     ← one doc per apartment (vendors, heads, rules, bank, plans, CoA)
 *   journal_entries    ← journal_entries with embedded lines[]
 *   maintenance_reminders ← maintenance_reminder_log
 *   nobroker_invoices  ← nobroker_invoices_raised
 *
 * Usage:
 *   npm run migrate:finance-mongo-remodel
 *   npm run migrate:finance-mongo-remodel -- --apartment <uuid>
 *   npm run migrate:finance-mongo-remodel -- --dry-run
 *   npm run migrate:finance-mongo-remodel -- --drop-flat   # remove stage-1 collections after
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient } from 'mongodb';

const FLAT_COLLECTIONS = [
    'transactions',
    'expense_vendors',
    'expense_sub_categories',
    'apartment_bank_accounts',
    'finance_documents',
    'maintenance_invoices',
    'maintenance_payment_allocations',
    'maintenance_charge_heads',
    'maintenance_invoice_lines',
    'maintenance_penalty_rules',
    'maintenance_billing_groups',
    'maintenance_billing_group_units',
    'maintenance_billing_batches',
    'maintenance_billing_batch_skips',
    'maintenance_reminder_log',
    'bank_statement_imports',
    'bank_statement_lines',
    'bank_classification_rules',
    'chart_of_accounts',
    'journal_entries',
    'journal_lines',
    'expense_plan_items',
    'expense_plan_recurring',
    'nobroker_invoices_raised',
];

const REMODELED = [
    'ledger_entries',
    'vouchers',
    'bank_imports',
    'dues_invoices',
    'billing_groups',
    'billing_batches',
    'finance_config',
    'journal_entries',
    'maintenance_reminders',
    'nobroker_invoices',
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
    const out = { apartment: null, dryRun: false, dropFlat: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--dry-run') out.dryRun = true;
        else if (arg === '--drop-flat') out.dropFlat = true;
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

function stripMeta(doc) {
    if (!doc) return doc;
    const { _migratedAt, ...rest } = doc;
    return rest;
}

function groupBy(rows, keyFn) {
    const map = new Map();
    for (const row of rows) {
        const key = keyFn(row);
        if (key == null || key === '') continue;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(row);
    }
    return map;
}

async function loadAll(db, name, apartmentId) {
    const filter = apartmentId ? { apartment_id: apartmentId } : {};
    return db.collection(name).find(filter).toArray();
}

async function replaceCollection(db, name, docs, dryRun, apartmentId) {
    if (dryRun) {
        return { name, written: docs.length };
    }
    const col = db.collection(name);
    if (apartmentId) {
        await col.deleteMany({ apartment_id: apartmentId });
    } else {
        await col.deleteMany({});
    }
    if (docs.length) {
        await col.insertMany(docs, { ordered: false });
    }
    return { name, written: docs.length };
}

function buildRemodel(flat, remodeledAt) {
    const txns = flat.transactions.map(stripMeta);
    const docs = flat.finance_documents.map(stripMeta);
    const imports = flat.bank_statement_imports.map(stripMeta);
    const lines = flat.bank_statement_lines.map(stripMeta);
    const invoices = flat.maintenance_invoices.map(stripMeta);
    const invoiceLines = flat.maintenance_invoice_lines.map(stripMeta);
    const allocations = flat.maintenance_payment_allocations.map(stripMeta);
    const groups = flat.maintenance_billing_groups.map(stripMeta);
    const groupUnits = flat.maintenance_billing_group_units.map(stripMeta);
    const batches = flat.maintenance_billing_batches.map(stripMeta);
    const skips = flat.maintenance_billing_batch_skips.map(stripMeta);
    const journalEntries = flat.journal_entries.map(stripMeta);
    const journalLines = flat.journal_lines.map(stripMeta);

    const docsByTxn = groupBy(docs, (d) => d.transaction_id);
    const linesByImport = groupBy(lines, (l) => l.import_id);
    const linesByTxn = groupBy(lines, (l) => l.transaction_id);
    const allocByTxn = groupBy(allocations, (a) => a.transaction_id);
    const allocByInvoice = groupBy(allocations, (a) => a.invoice_id);
    const invLinesByInvoice = groupBy(invoiceLines, (l) => l.invoice_id);
    const unitsByGroup = groupBy(groupUnits, (u) => u.group_id);
    const skipsByBatch = groupBy(skips, (s) => s.batch_id);
    const jLinesByEntry = groupBy(journalLines, (l) => l.entry_id);

    const ledger_entries = txns.map((t) => {
        const voucherIds = (docsByTxn.get(t.id) || []).map((d) => d.id);
        const bankLineRefs = (linesByTxn.get(t.id) || []).map((l) => ({
            importId: l.import_id,
            lineId: l.id,
        }));
        const maintenancePayments = (allocByTxn.get(t.id) || []).map((a) => ({
            allocationId: a.id,
            invoiceId: a.invoice_id,
            amount: a.amount,
        }));
        return {
            ...t,
            _id: String(t.id),
            voucherIds,
            bankLineRefs,
            maintenancePayments,
            _schema: 'v2',
            _remodeledAt: remodeledAt,
        };
    });

    const vouchers = docs.map((d) => ({
        ...d,
        _id: String(d.id),
        // Explicit aliases for Mongo-native naming
        kind: d.kind, // OUT = bill, IN = receipt
        ledgerEntryId: d.transaction_id || null,
        _schema: 'v2',
        _remodeledAt: remodeledAt,
    }));

    const bank_imports = imports.map((imp) => {
        const embedded = (linesByImport.get(imp.id) || []).map((l) => {
            const { import_id, apartment_id, ...lineRest } = l;
            return {
                ...lineRest,
                id: l.id,
            };
        });
        return {
            ...imp,
            _id: String(imp.id),
            lines: embedded,
            lineCount: embedded.length,
            _schema: 'v2',
            _remodeledAt: remodeledAt,
        };
    });

    const dues_invoices = invoices.map((inv) => {
        const embeddedLines = (invLinesByInvoice.get(inv.id) || []).map((l) => {
            const { invoice_id, apartment_id, ...rest } = l;
            return { ...rest, id: l.id };
        });
        const payments = (allocByInvoice.get(inv.id) || []).map((a) => ({
            id: a.id,
            transaction_id: a.transaction_id,
            amount: a.amount,
            created_at: a.created_at,
        }));
        return {
            ...inv,
            _id: String(inv.id),
            lines: embeddedLines,
            payments,
            _schema: 'v2',
            _remodeledAt: remodeledAt,
        };
    });

    const billing_groups = groups.map((g) => {
        const unitIds = (unitsByGroup.get(g.id) || []).map((u) => u.unit_id);
        return {
            ...g,
            _id: String(g.id),
            unitIds,
            _schema: 'v2',
            _remodeledAt: remodeledAt,
        };
    });

    const billing_batches = batches.map((b) => {
        const embeddedSkips = (skipsByBatch.get(b.id) || []).map((s) => {
            const { batch_id, apartment_id, ...rest } = s;
            return { ...rest, id: s.id };
        });
        return {
            ...b,
            _id: String(b.id),
            skips: embeddedSkips,
            _schema: 'v2',
            _remodeledAt: remodeledAt,
        };
    });

    const remodeledJournal = journalEntries.map((e) => {
        const embedded = (jLinesByEntry.get(e.id) || []).map((l) => {
            const { entry_id, apartment_id, ...rest } = l;
            return { ...rest, id: l.id };
        });
        return {
            ...e,
            _id: String(e.id),
            lines: embedded,
            _schema: 'v2',
            _remodeledAt: remodeledAt,
        };
    });

    const maintenance_reminders = flat.maintenance_reminder_log.map((r) => {
        const row = stripMeta(r);
        return {
            ...row,
            _id: String(row.id),
            _schema: 'v2',
            _remodeledAt: remodeledAt,
        };
    });

    const nobroker_invoices = flat.nobroker_invoices_raised.map((r) => {
        const row = stripMeta(r);
        return {
            ...row,
            _id: String(row.id),
            _schema: 'v2',
            _remodeledAt: remodeledAt,
        };
    });

    // One finance_config doc per apartment that has any lookup/config data
    const apartmentIds = new Set();
    for (const row of [
        ...flat.expense_vendors,
        ...flat.expense_sub_categories,
        ...flat.apartment_bank_accounts,
        ...flat.maintenance_charge_heads,
        ...flat.maintenance_penalty_rules,
        ...flat.bank_classification_rules,
        ...flat.chart_of_accounts,
        ...flat.expense_plan_items,
        ...flat.expense_plan_recurring,
        ...txns,
        ...docs,
        ...imports,
        ...invoices,
        ...groups,
        ...batches,
    ]) {
        if (row.apartment_id) apartmentIds.add(String(row.apartment_id));
    }

    const vendorsByApt = groupBy(flat.expense_vendors.map(stripMeta), (v) => v.apartment_id);
    const subByApt = groupBy(flat.expense_sub_categories.map(stripMeta), (v) => v.apartment_id);
    const bankByApt = groupBy(flat.apartment_bank_accounts.map(stripMeta), (v) => v.apartment_id);
    const headsByApt = groupBy(flat.maintenance_charge_heads.map(stripMeta), (v) => v.apartment_id);
    const penaltiesByApt = groupBy(flat.maintenance_penalty_rules.map(stripMeta), (v) => v.apartment_id);
    const rulesByApt = groupBy(flat.bank_classification_rules.map(stripMeta), (v) => v.apartment_id);
    const coaByApt = groupBy(flat.chart_of_accounts.map(stripMeta), (v) => v.apartment_id);
    const planItemsByApt = groupBy(flat.expense_plan_items.map(stripMeta), (v) => v.apartment_id);
    const planRecByApt = groupBy(flat.expense_plan_recurring.map(stripMeta), (v) => v.apartment_id);

    const finance_config = [...apartmentIds].map((apartmentId) => {
        const banks = bankByApt.get(apartmentId) || [];
        return {
            _id: apartmentId,
            apartment_id: apartmentId,
            bankAccount: banks[0] || null,
            vendors: vendorsByApt.get(apartmentId) || [],
            subCategories: subByApt.get(apartmentId) || [],
            chargeHeads: headsByApt.get(apartmentId) || [],
            penaltyRules: penaltiesByApt.get(apartmentId) || [],
            classificationRules: rulesByApt.get(apartmentId) || [],
            chartOfAccounts: coaByApt.get(apartmentId) || [],
            expensePlanItems: planItemsByApt.get(apartmentId) || [],
            expensePlanRecurring: planRecByApt.get(apartmentId) || [],
            _schema: 'v2',
            _remodeledAt: remodeledAt,
        };
    });

    return {
        ledger_entries,
        vouchers,
        bank_imports,
        dues_invoices,
        billing_groups,
        billing_batches,
        finance_config,
        journal_entries: remodeledJournal,
        maintenance_reminders,
        nobroker_invoices,
    };
}

async function ensureIndexes(db, dryRun) {
    if (dryRun) return;
    await db.collection('ledger_entries').createIndexes([
        { key: { apartment_id: 1, date: -1 } },
        { key: { apartment_id: 1, type: 1 } },
        { key: { 'maintenancePayments.invoiceId': 1 } },
    ]);
    await db.collection('vouchers').createIndexes([
        { key: { apartment_id: 1, doc_date: -1 } },
        { key: { apartment_id: 1, kind: 1, status: 1 } },
        { key: { ledgerEntryId: 1 } },
        { key: { transaction_id: 1 } },
    ]);
    await db.collection('bank_imports').createIndexes([
        { key: { apartment_id: 1, created_at: -1 } },
        { key: { 'lines.id': 1 } },
        { key: { 'lines.transaction_id': 1 } },
    ]);
    await db.collection('dues_invoices').createIndexes([
        { key: { apartment_id: 1, due_date: 1 } },
        { key: { apartment_id: 1, unit_id: 1 } },
        { key: { 'payments.transaction_id': 1 } },
    ]);
    await db.collection('billing_groups').createIndex({ apartment_id: 1, sort_order: 1 });
    await db.collection('billing_batches').createIndex({ apartment_id: 1, created_at: -1 });
    await db.collection('finance_config').createIndex({ apartment_id: 1 }, { unique: true });
    await db.collection('journal_entries').createIndex({ apartment_id: 1, entry_date: -1 });
    await db.collection('maintenance_reminders').createIndex({ apartment_id: 1, created_at: -1 });
    await db.collection('nobroker_invoices').createIndex({ apartment_id: 1, billing_month: -1 });
}

async function main() {
    loadEnvFile(resolve(process.cwd(), '.env.local'));
    loadEnvFile(resolve(process.cwd(), '.env'));

    const args = parseArgs(process.argv.slice(2));
    const mongoUri = requireEnv('MONGODB_URI');
    const mongoDbName = requireEnv('MONGODB_DB_NAME');

    const mongo = new MongoClient(mongoUri);
    await mongo.connect();
    const db = mongo.db(mongoDbName);

    console.log(`Mongo DB: ${mongoDbName}`);
    console.log(`Mode: ${args.dryRun ? 'dry-run (no writes)' : 'replace remodeled collections'}`);
    if (args.apartment) console.log(`Apartment filter: ${args.apartment}`);
    if (args.dropFlat && !args.dryRun) console.log('Will drop stage-1 flat collections after remodel');

    console.log('\nLoading flat collections…');
    const flat = {};
    for (const name of FLAT_COLLECTIONS) {
        flat[name] = await loadAll(db, name, args.apartment);
        console.log(`  ${name}: ${flat[name].length}`);
    }

    const remodeledAt = new Date();
    const remodeled = buildRemodel(flat, remodeledAt);

    console.log('\nWriting remodeled collections…');
    const results = [];
    for (const name of REMODELED) {
        const docs = remodeled[name] || [];
        const result = await replaceCollection(db, name, docs, args.dryRun, args.apartment);
        results.push(result);
        console.log(`  → ${name}: ${result.written}`);
    }

    await ensureIndexes(db, args.dryRun);

    if (args.dropFlat && !args.dryRun) {
        console.log('\nRemoving stage-1 flat collections…');
        for (const name of FLAT_COLLECTIONS) {
            // Remodeled journal_entries reuses this collection name — already replaced above.
            if (name === 'journal_entries') continue;
            try {
                if (args.apartment) {
                    const res = await db.collection(name).deleteMany({ apartment_id: args.apartment });
                    console.log(`  ${name}: deleted ${res.deletedCount} (apartment filter)`);
                } else {
                    await db.collection(name).drop();
                    console.log(`  dropped ${name}`);
                }
            } catch (err) {
                console.log(`  ${name}: ${err.message}`);
            }
        }
    }

    const total = results.reduce((s, r) => s + r.written, 0);
    console.log(`\nDone. Remodeled collections=${results.length} docs=${total}`);
    await mongo.close();
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
