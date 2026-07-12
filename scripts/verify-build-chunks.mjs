#!/usr/bin/env node
/** Fail the build if any dist/assets/*.js import references a missing chunk file. */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const assetsDir = resolve(process.cwd(), 'dist/assets');
const files = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
const importRe = /(?:from|import)\s*["']\.\/([^"']+\.js)["']/g;

let missing = 0;
for (const file of files) {
    const content = readFileSync(join(assetsDir, file), 'utf8');
    for (const match of content.matchAll(importRe)) {
        const target = match[1];
        if (!files.includes(target)) {
            console.error(`MISSING CHUNK: ${file} -> ./${target}`);
            missing += 1;
        }
    }
}

if (missing) {
    console.error(`\n${missing} broken chunk reference(s). Production lazy-load will fail.`);
    process.exit(1);
}

console.log(`OK: ${files.length} JS assets, all relative imports resolve.`);
