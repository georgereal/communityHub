#!/usr/bin/env node
/**
 * Regenerate thin api/*.js re-exports for Vercel. Classic Postgres handlers live under classic/api/
 * and are not deployed; only shared endpoints remain at repo root api/.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

const SHIMS = {
    'api/storage.js': '../classic/api/storage.js',
};

for (const [out, impl] of Object.entries(SHIMS)) {
    const body = `/** Auto-generated — run: node scripts/write-api-shims.mjs */\nexport { default } from '${impl}';\n`;
    writeFileSync(join(ROOT, out), body);
    console.log(`Wrote ${out} → ${impl}`);
}
