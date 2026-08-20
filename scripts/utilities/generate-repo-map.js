#!/usr/bin/env node
/**
 * generate-repo-map.js
 *
 * Generates docs/REPO_MAP.md by scanning the repository structure of the
 * CommunityHub / ApartmentMaintenance app (Vite + vanilla JS + Supabase SPA):
 *   - src/   : frontend feature modules, views, routing
 *   - api/   : Vercel serverless endpoints
 *   - scripts/, docs/, public/
 *   - supabase_*.sql migrations at the repo root
 *   - Routes & views derived from src/navigation.js
 *
 * Usage:
 *   node scripts/utilities/generate-repo-map.js
 *   npm run generate-repo-map
 *
 * Requirements: Node.js >= 18
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_PATH = path.join(ROOT, 'docs', 'REPO_MAP.md');

const EXCLUDED = [
  'node_modules',
  '.git',
  '.DS_Store',
  'dist',
  'build',
  '.next',
  'coverage',
  '.vercel',
  '.npm-cache',
  'test-results',
  'playwright-report',
  '__pycache__',
  '.cache',
  '.env.local',
];

// --- Filesystem helpers ---

/** Recursively list files/dirs (relative to baseDir), excluding noise dirs. */
function listFiles(dir, baseDir = dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED.includes(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const rel = path.relative(baseDir, fullPath);
    if (entry.isDirectory()) {
      results.push({ type: 'dir', path: rel, name: entry.name, children: listFiles(fullPath, baseDir) });
    } else if (entry.isFile()) {
      results.push({ type: 'file', path: rel, name: entry.name });
    }
  }
  return results.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function renderTree(files, prefix = '') {
  let out = '';
  files.forEach((f, i) => {
    const last = i === files.length - 1;
    const conn = last ? '└── ' : '├── ';
    out += prefix + conn + f.name + '\n';
    if (f.type === 'dir' && f.children && f.children.length) {
      out += renderTree(f.children, prefix + (last ? '    ' : '│   '));
    }
  });
  return out;
}

/** List immediate file names in a directory (relative), excluding noise. */
function listFileNames(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !EXCLUDED.includes(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Count files of a given extension (recursive). */
function countExt(dir, ext) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (EXCLUDED.includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(ext)) n += 1;
    }
  };
  walk(dir);
  return n;
}

// --- Curated descriptions ---

/** One-line descriptions for key src/ feature modules (fallback = filename). */
const SRC_DESCRIPTIONS = {
  'main.js': 'Entry point / primary boot sequence & view coordination',
  'mainBoot.js': 'Shared boot helpers (access mappings, resident rendering, apartment options)',
  'store.js': 'Central state (portalState) + Supabase client + pullState hydration',
  'stateLoader.js': 'Domain loaders & STATE_DOMAINS registry for partitioned state',
  'navigation.js': 'Modules, pages, routing & permission gating (NAV_MODULES)',
  'authClient.js': 'Auth client & session handling',
  'authShell.js': 'Auth UI shell',
  'socialAuth.js': 'Social provider sign-in (Google / Microsoft)',
  'dbClient.js': 'Supabase client + apartment state fetch',
  'apiJson.js': 'API JSON request helpers',
  'ms-callback.js': 'Microsoft (MSAL) auth redirect callback',
  'registry.js': 'Parking & vehicle registry (offline-first) + analytics',
  'allocation.js': 'Parking slot allocation',
  'vehicleAudit.js': 'Vehicle audit log & badge refresh',
  'parkingImport.js': 'Parking data import',
  'parkingOps.js': 'Parking operations UI refresh',
  'parkingReconcileUi.js': 'Parking reconciliation UI',
  'gateWizard.js': 'Gate wizard / visitor check-in flow',
  'visitors.js': 'Visitor log UI',
  'visitorApprovals.js': 'Visitor approvals workflow',
  'visitorGate.js': 'Gate-side visitor handling',
  'securityPortal.js': 'Security gate portal (gate desk / visitor log / passes)',
  'residents.js': 'Residents CRUD',
  'residentView.js': 'Resident detail view',
  'residentPortal.js': 'Resident self-service portal subviews',
  'residentImport.js': 'Resident import (Excel/CSV)',
  'residentLinks.js': 'Resident ↔ unit link admin',
  'unitDirectory.js': 'Unit directory (block/bhk/area)',
  'unitTransitions.js': 'Move-in / move-out transition wizard',
  'transitionFees.js': 'Transition fee computation',
  'finances.js': 'Cash & bank ledger engine + processFinances',
  'financeApi.js': 'Finance API client',
  'financeAnalytics.js': 'Finance reports & analytics',
  'financeDocuments.js': 'Bills & receipts document management',
  'financeReportsExport.js': 'Export finance reports (Excel)',
  'bankReconciliation.js': 'Bank reconciliation UI',
  'bankClassificationRules.js': 'Bank statement classification rules',
  'bankStatementLineUtils.js': 'Bank statement line utilities',
  'bankStatementOrdering.js': 'Bank statement line ordering',
  'generalLedger.js': 'General ledger entry management',
  'ledgerBalance.js': 'Ledger balance computation',
  'ledgerColumnMapping.js': 'Ledger column mapping for imports',
  'ledgerDisplayRows.js': 'Ledger table row rendering',
  'ledgerExport.js': 'Ledger export',
  'ledgerFilter.js': 'Ledger filtering',
  'ledgerOAuth.js': 'Bank OAuth connections for ledger sync',
  'ledgerSheetRegion.js': 'Spreadsheet region detection',
  'ledgerSpreadsheetSync.js': 'Spreadsheet sync panel (admin-sync)',
  'ledgerStatementContext.js': 'Bank statement context helpers',
  'ledgerSyncApply.js': 'Apply ledger sync rows',
  'ledgerSyncImport.js': 'Ledger sync import',
  'ledgerSyncJournal.js': 'Ledger sync journal',
  'ledgerSyncLog.js': 'Ledger sync run log',
  'ledgerSyncRunAudit.js': 'Ledger sync run audit UI',
  'ledgerTable.js': 'Ledger table rendering',
  'ledgerTransform.js': 'Ledger row transform helpers',
  'ledgerTxnLocal.js': 'Local (offline) ledger transactions',
  'cashFloat.js': 'Cash float management',
  'duesAging.js': 'Dues aging report',
  'payments.js': 'Payments / collections',
  'expenseCategories.js': 'Expense categories',
  'expensePlan.js': 'Expense plan & recurring items',
  'invoicePdf.js': 'Invoice PDF generation & share',
  'maintenanceBilling.js': 'Maintenance billing engine + invoices page',
  'billingHeads.js': 'Maintenance charge heads',
  'billingGroups.js': 'Billing groups & group units',
  'billingBatches.js': 'Billing batch history',
  'penaltyRules.js': 'Maintenance penalty rules',
  'invoicesRaisedPage.js': 'Invoices-raised list page',
  'nobrokerInvoicesRaised.js': 'NoBroker invoices-raised list',
  'passbookEvolyx.js': 'Evolyx passbook job handling',
  'passbookJobImportAnalysis.js': 'Passbook job import analysis',
  'microsoftExcelPush.js': 'Push finance data to Excel via Microsoft Graph',
  'externalConnections.js': 'External connections (admin)',
  'externalFetch.js': 'External fetch helpers',
  'admin.js': 'Setup subview switching & admin helpers',
  'uiMode.js': 'Classic vs New UI mode',
  'moduleAccess.js': 'Module-level access / isModuleEnabled',
  'moduleAccessAdmin.js': 'Module access admin panel',
  'pageAccess.js': 'Page-level access',
  'pageAccessAdmin.js': 'Page access admin panel',
  'pageAccessResolve.js': 'Page access route resolution',
  'accessLocks.js': 'Access lock guard (HMR-safe)',
  'accessRequests.js': 'Access request handling',
  'accessSync.js': 'Access user directory sync',
  'rbac.js': 'RBAC: roles, permissions, effective-role resolution',
  'rbacMatrix.js': 'RBAC permission matrix UI',
  'activityAudit.js': 'Activity audit log page',
  'staffNotifications.js': 'Staff notifications UI',
  'noticeDelivery.js': 'Notice delivery',
  'noticeEditor.js': 'Notice editor',
  'notices.js': 'Notices feature',
  'emailOutbox.js': 'Email outbox',
  'dashboard.js': 'Dashboard render',
  'blockFilter.js': 'Block filter helper',
  'buttonBusy.js': 'Busy-state button helper',
  'counter.js': 'Counter helper',
  'flatPicker.js': 'Flat (units) picker helper',
  'portfolio.js': 'Portfolio rollup view',
  'bulkCollectionImport.js': 'Bulk collection import',
  'bulkInvoiceImport.js': 'Bulk invoice import',
  'classifyCombobox.js': 'Classification combobox',
  'classifyOptions.js': 'Classification options',
  'syncCodeEditor.js': 'Sync code editor',
  'style.css': 'Global styles',
  'dashboard.css': 'Dashboard styles',
  'financeMobile.css': 'Mobile finance styles',
  'securityPortal.css': 'Security portal styles',
  'gateWizard.css': 'Gate wizard styles',
  'ledgerSync.css': 'Ledger sync styles',
  'moduleAccess.css': 'Module access styles',
  'notices.css': 'Notices styles',
  'pageAccess.css': 'Page access styles',
  'visitors.css': 'Visitors styles',
};

const API_DESCRIPTIONS = {
  'accountsAuth.js': 'Accounts/session auth endpoint',
  'auth-session.js': 'Auth session endpoint',
  'serverAuth.js': 'Server-side auth helpers',
  'dashboard-summary.js': 'Dashboard summary endpoint',
  'db.js': 'DB access (Supabase)',
  'dbAccess.js': 'DB access helpers',
  'rpc.js': 'Postgres RPC endpoint (with maxDuration)',
  'supabaseRest.js': 'Supabase REST helper',
  'evolyxConnection.js': 'Evolyx external connection',
  'external-connections.js': 'External connections read/write',
  'external-proxy.js': 'External API proxy',
  'finance-mutations.js': 'Finance write mutations',
  'oauth-microsoft.js': 'Microsoft OAuth flow',
  'oauth-service.js': 'OAuth service helper',
  'passbook-jobs.js': 'Evolyx passbook jobs',
  'passbook-parse.js': 'Passbook file parsing',
  'passbook-webhook.js': 'Passbook webhook',
  'passbookJobsStore.js': 'Passbook jobs store helper',
  'r2Storage.js': 'S3/R2 storage upload',
  'storage.js': 'File storage',
  'state.js': 'State hydration endpoint',
  'stateDomains.js': 'State domain data',
  'sync.js': 'Scheduled sync (Vercel cron)',
  'vercelRequest.js': 'Vercel request helper',
  'workspace-boot.js': 'Workspace boot helper',
};

/** Extract route → label → view → subview from src/navigation.js pages. */
function extractRoutes() {
  const navPath = path.join(ROOT, 'src', 'navigation.js');
  if (!fs.existsSync(navPath)) return [];
  const src = fs.readFileSync(navPath, 'utf8');
  const routes = [];
  // Matches page definitions (have route + label); route-only navEntries are skipped.
  const re =
    /route:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'\s*,[^}]*?view:\s*'([^']+)'(?:\s*,\s*subview:\s*'([^']+)')?/gs;
  let m;
  while ((m = re.exec(src)) !== null) {
    routes.push({ route: m[1], label: m[2], view: m[3], subview: m[4] || '' });
  }
  const seen = new Set();
  return routes.filter((r) => (seen.has(r.route) ? false : (seen.add(r.route), true)));
}

function mdTable(headers, rows) {
  const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map(esc).join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}`;
}

function gather() {
  const srcTree = renderTree(listFiles(path.join(ROOT, 'src')));
  const apiTree = renderTree(listFiles(path.join(ROOT, 'api')));
  const scriptsTree = renderTree(listFiles(path.join(ROOT, 'scripts')));
  const docsTree = renderTree(listFiles(path.join(ROOT, 'docs')));
  const publicTree = renderTree(listFiles(path.join(ROOT, 'public')));

  const srcFiles = listFileNames(path.join(ROOT, 'src'));
  const srcRows = srcFiles.map((f) => [
    `src/${f}`,
    SRC_DESCRIPTIONS[f] || f.replace(/\.(js|css)$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'),
  ]);

  const apiFiles = listFileNames(path.join(ROOT, 'api'));
  const apiRows = apiFiles.map((f) => [f, API_DESCRIPTIONS[f] || 'Serverless endpoint']);

  const sqlMigrations = listFileNames(ROOT).filter((f) => f.startsWith('supabase_') && f.endsWith('.sql'));
  const sqlRows = sqlMigrations.map((f) => [`\`${f}\``, 'Supabase SQL migration (run manually in SQL Editor)']);

  const topConfig = listFileNames(ROOT).filter(
    (f) => !f.startsWith('supabase_') && !f.startsWith('.') && f !== 'package-lock.json',
  );

  const routes = extractRoutes();
  const routeRows = routes.map((r) => [r.route, r.label, r.view, r.subview || '—']);

  const jsCount = countExt(path.join(ROOT, 'src'), '.js') + countExt(path.join(ROOT, 'api'), '.js');
  const cssCount = countExt(path.join(ROOT, 'src'), '.css');
  const htmlCount = countExt(path.join(ROOT, 'src'), '.html') + 2;

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const devScripts = Object.entries(pkg.scripts || {})
    .map(([k, v]) => `- \`npm run ${k}\` → \`${v}\``)
    .join('\n');

  return {
    now: new Date().toISOString().slice(0, 10),
    srcTree, apiTree, scriptsTree, docsTree, publicTree,
    srcRows, apiRows, sqlRows, topConfig, routeRows,
    jsCount, cssCount, htmlCount, devScripts,
  };
}

function generateRepoMap() {
  const d = gather();
  return `# CommunityHub / ApartmentMaintenance — Repository Map

> **Project:** ApartmentMaintenance (CommunityHub) — Vite + vanilla JS + Supabase single-page app.
> **Stack:** Vite (vite build) · vanilla JS modules · Supabase (Postgres + RLS) · Vercel serverless \`api/*.js\` endpoints · ExcelJS/PDF/Quill.
> **Conventions:** SQL migrations as \`supabase_*.sql\` at repo root; feature modules in \`src/\`; UI in \`index.html\` + \`src/style.css\`; serverless handlers in \`api/\`.

---

## 1. Repository Overview

\`\`\`
${renderTree(listFiles(ROOT))}
\`\`\`

**Scale:** ~${d.jsCount} JavaScript modules, ~${d.cssCount} CSS files, ~${d.htmlCount} HTML entry pages.

---

## 2. \`src/\` — Frontend Feature Modules

The SPA is modular: \`src/main.js\` boots → \`src/store.js\` hydrates state → \`src/navigation.js\` maps routes →
\`src/views/controllers.js\` lazily activates the active view's feature modules (dynamic \`import()\`, keeping the initial bundle small).

### Directory tree

\`\`\`
${d.srcTree}
\`\`\`

### Feature module index

${mdTable(['File', 'Purpose'], d.srcRows)}

---

## 3. Views & Routes

Routes are declared in \`src/navigation.js\` (\`NAV_MODULES\`). Each page maps to a \`view\` handled by \`src/views/controllers.js\`
and an optional \`subview\`.

${mdTable(['Route', 'Label', 'View', 'Subview'], d.routeRows)}

**View activation** — \`src/views/controllers.js\` dispatches on \`view\`:
\`dashboard\`, \`registry\`, \`accounts\` (finance), \`portfolio\`, \`email\`, \`setup\` (admin), \`access-control\`,
\`invoices\` (billing), \`portal\` (resident), \`security\` (gate), \`operations\`, \`apartment\` (residents), \`units\`.

---

## 4. \`api/\` — Vercel Serverless Endpoints

Serverless handlers (Node.js, Vercel Functions). \`vercel.json\` sets \`maxDuration\` for long-running endpoints and a
cron (\`/api/sync\` daily 06:00 UTC). During local dev, \`viteApiDev.js\` mounts these directly; \`VITE_LOCAL_API=0\`
proxies \`/api\` to the deployed origin (\`communityhub.evolyx.in\`).

\`\`\`
${d.apiTree}
\`\`\`

### Endpoint index

${mdTable(['Endpoint', 'Purpose'], d.apiRows)}

---

## 5. \`scripts/\` — Root Tooling

\`\`\`
${d.scriptsTree}
\`\`\`

- \`verify-build-chunks.mjs\` — validates \`vite build\` output chunking.
- \`verify-vercel-api.mjs\` — verifies Vercel API handler wiring.
- \`mockFinanceState.js\` — mock finance state for screenshots/tests.
- \`capture-finance-screenshots.mjs\` — Playwright screenshot capture (see \`docs/screenshots\`).

---

## 6. \`docs/\` & \`public/\`

### docs/
\`\`\`
${d.docsTree}
\`\`\`

\`PHASED_REQUIREMENTS.md\` is the product spec (phases/sprints) — hand it to an agent to implement features in order.

### public/
\`\`\`
${d.publicTree}
\`\`\`

---

## 7. Supabase SQL Migrations (root \`supabase_*.sql\`)

Schema + RLS migrations. **Run manually** in the Supabase SQL Editor (see \`docs/scripts/sql/\` for the canonical set).

${mdTable(['File', 'Purpose'], d.sqlRows)}

---

## 8. Root Configuration

${mdTable(['File', 'Purpose'], d.topConfig.map((f) => [f, 'Repo config / entry point']))}

---

## 9. Key Architectural Concepts

- **State:** \`src/store.js\` — \`portalState\` (units, slots, finances, access, community) hydrated by \`pullState()\`;
  partitioned read-only domains via \`stateLoader.js\` / \`stateDomains.js\`.
- **Data access:** browser → Supabase client (\`src/dbClient.js\`) and/or Vercel \`/api/*\` endpoints; admin/finance
  mutations go through \`api/finance-mutations.js\`. Spreadsheet sync via \`api/ledger*\`, Excel push via Microsoft Graph.
- **Auth:** \`authClient.js\` + \`socialAuth.js\` (Google/Microsoft), MSAL callback (\`microsoft-auth.html\`, \`ms-callback.js\`).
- **RBAC & access:** \`rbac.js\` / \`rbacMatrix.js\` (roles/permissions), \`moduleAccess*\`, \`pageAccess*\`, \`accessSync.js\`.
- **Views:** lazy-activated per route (\`views/controllers.js\`), each \`views/inits/*.js\` wires view-specific init.
- **Deployment:** Vercel (\`vercel.json\`) — SPA rewrite to \`index.html\`, \`api/*\` serverless, cron sync, immutable assets.

---

## 10. Development Commands

### Root

${d.devScripts}

---

*Auto-generated by \`scripts/utilities/generate-repo-map.js\`. Last updated: ${d.now}.*
`;
}

function main() {
  console.log('📋 Generating repository map...');
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const markdown = generateRepoMap();
  fs.writeFileSync(OUTPUT_PATH, markdown, 'utf8');
  console.log(`✅ Repository map written to: ${path.relative(ROOT, OUTPUT_PATH)}`);
  console.log(`   Size: ${(markdown.length / 1024).toFixed(1)} KB`);
}

main();
