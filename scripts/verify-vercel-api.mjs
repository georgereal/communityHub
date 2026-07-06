#!/usr/bin/env node
/**
 * Smoke-check that API handlers load under Node ESM (same runtime Vercel uses).
 */
import { readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const apiDir = resolve(process.cwd(), 'api');
const skip = new Set(['vercelRequest.js', 'dbAccess.js', 'serverAuth.js', 'serverSupabase.js', 'supabaseRest.js', 'accountsAuth.js', 'passbookJobsStore.js', 'evolyxConnection.js']);

const files = readdirSync(apiDir).filter((f) => f.endsWith('.js') && !skip.has(f));
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
