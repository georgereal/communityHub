#!/usr/bin/env node
/**
 * New app must not import Classic except via allowlisted shim files in apps/new/src/*.js
 * (re-exports of pure helpers). Also ban supabase.from( and /api/db in apps/new.
 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const NEW = join(ROOT, 'apps/new');

const SHIM_ALLOW = new Set([
    'store.js', 'dbClient.js', 'allocation.js', 'registry.js', 'parkingImport.js',
    'residents.js', 'unitDirectory.js',
    'ledgerSpreadsheetSync.js', 'financeApi.js', 'classifyCombobox.js',
    'bulkInvoiceImport.js', 'penaltyRules.js', 'invoicePdf.js', 'blockFilter.js',
    'bulkCollectionImport.js', 'passbookEvolyx.js', 'bankStatementOrdering.js',
    'bankStatementLineUtils.js', 'passbookJobImportAnalysis.js',
    'bankClassificationRules.js', 'ledgerTransform.js', 'ledgerColumnMapping.js',
    'residentImport.js', 'residentLinks.js', 'externalConnections.js', 'finances.js',
    'authClient.js',
]);

function walk(dir, acc = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, acc);
        else if (/\.(js|jsx|mjs)$/.test(name)) acc.push(p);
    }
    return acc;
}

const files = walk(join(NEW, 'src'));
const leaks = [];

for (const file of files) {
    const rel = file.slice(ROOT.length + 1);
    const text = readFileSync(file, 'utf8');
    const isTopShim = rel.startsWith('apps/new/src/') && !rel.slice('apps/new/src/'.length).includes('/')
        && SHIM_ALLOW.has(rel.split('/').pop());

    if ((text.includes("from '@classic/") || text.includes("import('@classic/") || text.includes('import("@classic/')) && !isTopShim) {
        leaks.push(`${rel}: imports @classic (not an allowlisted shim)`);
    }
    if (text.includes('apps/classic')) {
        leaks.push(`${rel}: path to apps/classic`);
    }
    if (text.includes('supabase.from(')) {
        leaks.push(`${rel}: supabase.from(`);
    }
    if (text.includes("'/api/db'") || text.includes('"/api/db"') || text.includes('`/api/db')) {
        leaks.push(`${rel}: /api/db`);
    }
}

if (leaks.length) {
    console.error('Import boundary failed:\n' + leaks.map((l) => `  - ${l}`).join('\n'));
    process.exit(1);
}

console.log(`Import boundary OK (${files.length} New files).`);
