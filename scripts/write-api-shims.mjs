import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = process.cwd();

const shims = {
    'api/db.js': '../apps/classic/api/db.js',
    'api/rpc.js': '../apps/classic/api/rpc.js',
    'api/state.js': '../apps/classic/api/state.js',
    'api/sync.js': '../apps/classic/api/sync.js',
    'api/storage.js': '../apps/classic/api/storage.js',
    'api/finance-mutations.js': '../apps/classic/api/finance-mutations.js',
    'api/workspace-boot.js': '../apps/classic/api/workspace-boot.js',
    'api/dashboard-summary.js': '../apps/new/api/dashboard-summary.js',
    'api/finance-mongo.js': '../apps/new/api/finance-mongo.js',
    'api/finance-mongo-mutations.js': '../apps/new/api/finance-mongo-mutations.js',
    'api/finance-mongo-reports.js': '../apps/new/api/finance-mongo-reports.js',
    'api/finance-rest.js': '../apps/new/api/finance-rest.js',
    'api/finance/[...path].js': '../../apps/new/api/finance/[...path].js',
    'api/property-rest.js': '../apps/new/api/property-rest.js',
    'api/rbac-mongo.js': '../apps/new/api/rbac-mongo.js',
    'api/new/workspace-boot.js': '../../apps/new/api/workspace-boot.js',
    'api/passbook-jobs.js': '../apps/new/api/passbook-jobs.js',
    'api/passbook-parse.js': '../apps/new/api/passbook-parse.js',
    'api/passbook-webhook.js': '../apps/new/api/passbook-webhook.js',
    'api/external-connections.js': '../apps/new/api/external-connections.js',
    'api/external-proxy.js': '../apps/new/api/external-proxy.js',
    'api/auth-session.js': '../packages/server/auth-session.js',
    'api/oauth-microsoft.js': '../packages/server/oauth-microsoft.js',
    'api/oauth-service.js': '../packages/server/oauth-service.js',
};

for (const [file, target] of Object.entries(shims)) {
    const abs = join(ROOT, file);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `/** Vercel/Vite public entry — implementation lives at ${target} */\nexport { default } from '${target}';\n`);
}

console.log(`Wrote ${Object.keys(shims).length} api shims.`);
