#!/usr/bin/env node
/**
 * Smoke-check that API handlers load under Node ESM (same runtime Vercel uses).
 */
import { readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const apiDir = resolve(process.cwd(), 'api');
const skip = new Set([
    'vercelRequest.js',
    'dbAccess.js',
    'stateDomains.js',
    'serverAuth.js',
    'serverSupabase.js',
    'supabaseRest.js',
    'accountsAuth.js',
    'passbookJobsStore.js',
    'evolyxConnection.js',
    'mongoClient.js',
    'mongoLog.js',
    'r2Storage.js',
]);

function listHandlers(dir, acc = []) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
            listHandlers(full, acc);
            continue;
        }
        if (!name.endsWith('.js')) continue;
        const rel = relative(apiDir, full);
        if (skip.has(name) || skip.has(rel)) continue;
        if (rel.startsWith('financeMongo/') || rel.startsWith('propertyMongo/')) continue;
        acc.push(rel);
    }
    return acc;
}

const files = listHandlers(apiDir).sort();
let failed = 0;

for (const file of files) {
    const id = join(apiDir, file);
    try {
        const mod = await import(`file://${id}`);
        if (typeof mod.default !== 'function') {
            console.error(`FAIL ${file}: missing default export handler`);
            failed += 1;
            continue;
        }
        console.log(`OK   ${file}`);
    } catch (err) {
        console.error(`FAIL ${file}: ${err.message}`);
        failed += 1;
    }
}

if (failed) {
    console.error(`\n${failed} handler(s) failed to load.`);
    process.exit(1);
}

console.log(`\nAll ${files.length} Vercel API handlers loaded.`);
