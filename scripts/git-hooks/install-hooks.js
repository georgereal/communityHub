#!/usr/bin/env node
/**
 * install-hooks.js
 *
 * Installs git hooks for the ApartmentMaintenance repository.
 * Creates a pre-push hook that checks if the repository map needs regeneration
 * before allowing a push.
 *
 * Usage:
 *   node scripts/git-hooks/install-hooks.js
 *   npm run setup:hooks
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');
const HOOKS_DIR = path.join(ROOT, '.git', 'hooks');
const HOOK_DEST = path.join(HOOKS_DIR, 'pre-push');

function main() {
    console.log('🔧 Installing git hooks...');

    const gitDir = path.join(ROOT, '.git');
    if (!fs.existsSync(gitDir)) {
        console.error('❌ No .git directory found. Run this from the repository root.');
        process.exit(1);
    }

    if (!fs.existsSync(HOOKS_DIR)) {
        fs.mkdirSync(HOOKS_DIR, { recursive: true });
    }

    // The git hook calls our Node.js pre-push script
    const hookContent = `#!/bin/sh
# Auto-installed by npm run setup:hooks
# Calls the Node.js pre-push hook script
node "${path.join(ROOT, 'scripts', 'git-hooks', 'pre-push.js')}" "$@"
`;

    fs.writeFileSync(HOOK_DEST, hookContent, 'utf8');
    fs.chmodSync(HOOK_DEST, '755');

    console.log(`✅ Installed pre-push hook to: ${path.relative(ROOT, HOOK_DEST)}`);
    console.log('');
    console.log('The hook will:');
    console.log('  • Check if the repository map needs regeneration (on structural changes)');
    console.log('  • Auto-regenerate and warn (does NOT block — just warns)');
    console.log('');
    console.log('To bypass: git push --no-verify');
    console.log('To uninstall: rm .git/hooks/pre-push');
}

main();
