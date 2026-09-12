# New App Architecture — REST Domains & Segregation

Guide for building **apps/new** features. Classic (`classic/`) is archived on Postgres/Supabase; New is Mongo-backed with **domain-segregated REST**.

See also: `docs/REPO_MAP.md` (structure), `AGENTS.md` (agent workflow).

---

## 1. Domain segregation (do not dump everything under finance)

Each product domain owns:

| Domain | Public REST prefix | Implementation | Mongo collections (examples) |
| --- | --- | --- | --- |
| **Finance** | `/api/finance/*` | `apps/new/api/finance-rest.js` → `finance/[...path].js`, `financeMongo/` | `finance_config`, `ledger_entries`, `vouchers`, `bank_imports`, … |
| **Property** | `/api/property/*` | `apps/new/api/property-rest.js` → `propertyMongo/` | units, vehicles, residents, slots |
| **Integrations** | `/api/integrations/*` | `apps/new/api/integrations-rest.js` → `integrationsMongo/` | `external_connections`, `passbook_ocr_jobs`, `ledger_sync_*`, `user_oauth_connections` |
| **Identity / RBAC** | `/api/rbac-mongo` (and related) | `apps/new/api/rbacMongo/` | `rbac_*` |
| **Activity** | `/api/activity/*` | `apps/new/api/activity-rest.js` → `activityMongo/` | `activity_audit_log` |

**Rules**

1. **Resources live with their domain**, not with the screen that happens to call them.  
   Passbook OCR credentials are **Integrations**, even though Bank Reconciliation (Finance UI) starts a scan.
2. **Do not add** Evolyx / OAuth-provider / webhook config under `/api/finance/...`.
3. **Cross-domain use is allowed** (Finance UI → Integrations API). Crossing stores is not: Finance ledger stays in finance collections; integration secrets stay in `external_connections`.
4. **Auth uses Firebase ID tokens**; New domain data is Mongo. Prefer `requireApartmentPermission` / `requireAnyApartmentPermission` from `packages/server/serverAuth.js`. See [FIREBASE_AUTH.md](./FIREBASE_AUTH.md).

---

## 2. REST shape (Property / Integrations pattern)

Prefer **resource-oriented** routes over RPC action bags:

```
GET    /api/{domain}/{collection}?apartment_id=
POST   /api/{domain}/{collection}
GET    /api/{domain}/{collection}/:id?apartment_id=
POST   /api/{domain}/{collection}/:id/{action}   # only when not a pure CRUD verb
```

### Integrations (current)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/integrations/connections?apartment_id=` | List provider connections (no secrets) |
| POST | `/api/integrations/connections` | Upsert connection (API key optional on update) |
| GET | `/api/integrations/passbook/jobs?apartment_id=` | List OCR jobs |
| GET | `/api/integrations/passbook/jobs/:id?apartment_id=` | Job detail (may include mapped lines) |
| POST | `/api/integrations/passbook/jobs` | Start async Evolyx scan (`files[]`) → **202** |
| POST | `/api/integrations/passbook/jobs/:id/imported` | Mark job imported into bank statement |
| GET | `/api/integrations/spreadsheet/boot?apartment_id=` | Hydrate settings + OAuth apps + connection meta |
| GET/POST | `/api/integrations/spreadsheet/settings` | Read / upsert workbook sync settings |
| GET/POST | `/api/integrations/spreadsheet/oauth-apps` | Society Google/Microsoft OAuth app config |
| GET/POST/DELETE | `/api/integrations/spreadsheet/oauth-connections` | Per-user tokens (caller only) |
| GET | `/api/integrations/spreadsheet/runs?apartment_id=` | Spreadsheet sync run history |

### Activity (society-wide audit)

Consolidated feed for Admin **Activity** (`/admin/activity`):

| Mongo collection | Origin | Shown as |
| --- | --- | --- |
| `activity_audit_log` | Billing, residents, roles, bank recon, visitors, units, … | entity_type as logged |
| `vehicle_audit_log` | Parking / vehicle registry | functionality **Parking** |

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/activity/events?apartment_id=&entity_type=&action=&limit=` | Merged list + `facets` (live entity_types / actions) + counts |
| POST | `/api/activity/events` | Append society audit event (`logActivity`) |

Backfill: `npm run migrate:logs-mongo` (prefers `*_temp`). Soft-migrate-on-read fills empty apartment collections from Supabase.

**Writers (New):** Property API mutations write audits **on the server** in the same request as the mutation (survives client network drops after the API responded). Admin + Finance clients call `logActivity` → `POST /api/activity/events`; failures are queued in a **browser outbox** (`localStorage`) and flushed on `online` / focus / interval / Activity refresh (idempotent client ids).

**Public callback (external provider):** `POST /api/passbook-webhook?job_id=&token=`  
Kept outside `/api/integrations/*` so tunnel URLs and Evolyx config stay stable. Implementation is still Mongo in `integrationsMongo`.

### Legacy shims (compat)

`/api/external-connections`, `/api/passbook-parse`, `/api/passbook-jobs` remain as thin wrappers over the same Mongo stores. **New UI must call `/api/integrations/...`.** Classic may keep legacy paths until migrated.

---

## 3. Layout on disk

```
apps/new/api/
  {domain}-rest.js          # Vercel entry + path router (one warm isolate)
  {domain}Mongo/
    http.js                 # auth + logging wrapper
    errors.js
    permissions.js
    indexes.js / service.js
    routes/                 # one file per resource or sub-resource
```

Root `api/{domain}-rest.js` is a **shim** (`scripts/write-api-shims.mjs`) re-exporting `apps/new/api/...`.

Wire new domains in:

1. `scripts/write-api-shims.mjs`
2. `vercel.json` rewrite: `/api/{domain}/:path*` → `/api/{domain}-rest?__{domain}Path=:path*`
3. `viteApiDev.js` (`resolveApiModule` + `__{domain}Path`)
4. `vercel.json` `functions` maxDuration if needed

---

## 4. Client conventions (apps/new)

- Call **domain REST**, not classic Supabase tables, for New screens.
- Keep clients under `apps/new/src/` (do not only re-export classic when the API URL differs).
- Admin Integrations → `/api/integrations/connections`
- Finance bank recon passbook → `/api/integrations/passbook/jobs`
- Admin Activity → `/api/activity/events` (+ integrations passbook/runs tabs)

---

## 5. When adding a new domain

1. Name the domain by **business capability** (not by UI page).
2. Add `{domain}Mongo/` + `{domain}-rest.js` following Property/Integrations.
3. Document routes in this file and regenerate `docs/REPO_MAP.md`.
4. Do not grow `finance-mongo-mutations.js` with unrelated providers/webhooks.
5. Ship a **`scripts/migrate-{domain}-to-mongo.mjs`** (upsert, `--dry-run`, optional `--apartment`) and an npm script. Soft-migrate-on-read is a fallback only.

### Activity migrate

```bash
npm run migrate:logs-mongo
npm run migrate:logs-mongo -- --apartment <uuid>
npm run migrate:logs-mongo -- --dry-run
npm run migrate:logs-mongo -- --from-live   # skip *_temp
```

Copies (prefer `*_temp`): `activity_audit_log`, `vehicle_audit_log`, notifications, email/sms outbox. Soft-migrate-on-read on GET `/api/activity/events` does the same per apartment when a collection is empty.

### Integrations migrate

```bash
npm run migrate:integrations-mongo
npm run migrate:integrations-mongo -- --apartment <uuid>
npm run migrate:integrations-mongo -- --dry-run
npm run migrate:integrations-mongo -- --skip-jobs          # connections only
npm run migrate:integrations-mongo -- --skip-connections  # jobs only
```

Copies `apartment_external_connections` → `external_connections` and `passbook_ocr_jobs` → `passbook_ocr_jobs` (includes API keys). Requires `MONGODB_URI`, `MONGODB_DB_NAME`, `SUPABASE_SERVICE_ROLE_KEY`, and `VITE_SUPABASE_URL` / `SUPABASE_URL`.

### Spreadsheet sync migrate (prefers `*_temp`)

```bash
npm run migrate:ledger-sync-mongo
npm run migrate:ledger-sync-mongo -- --apartment <uuid>
npm run migrate:ledger-sync-mongo -- --dry-run
npm run migrate:ledger-sync-mongo -- --skip-tokens   # settings + oauth apps only
npm run migrate:ledger-sync-mongo -- --from-live     # skip *_temp; use live table names
```

Copies (secrets included):

| Supabase (try `name_temp` first) | Mongo |
| --- | --- |
| `ledger_sync_settings` | `ledger_sync_settings` |
| `ledger_sync_oauth_apps` | `ledger_sync_oauth_apps` |
| `user_oauth_connections` | `user_oauth_connections` |
| `ledger_sync_service_accounts` | `ledger_sync_service_accounts` |
| `ledger_sync_runs` | `ledger_sync_runs` |

Admin Integrations loads `/api/integrations/spreadsheet/boot` and saves via Mongo when running as New MPA.
Admin **Activity** (`/admin/activity`) lists society audit events (`/api/activity/events`, collection `activity_audit_log` — also filled by `npm run migrate:logs-mongo`) plus Passbook jobs and spreadsheet runs. Filter All activity by **functionality** (`entity_type`) and action.

---

## 6. Anti-patterns

| Avoid | Prefer |
| --- | --- |
| `/api/finance/evolyx` or `/api/finance/integrations` | `/api/integrations/...` |
| Action RPC `POST { action: 'saveConnection' }` for New | REST verbs + paths |
| Storing API keys in `finance_config` | `external_connections` |
| Nested Vercel functions under `api/integrations/**` each as separate isolates | Single `integrations-rest.js` rewrite (connection pooling) |
| Classic `apartment_external_connections` as New source of truth | Mongo `external_connections` |

---

## 7. Probe: hide Supabase tables from New

To discover leftover Postgres reads after Mongo cutover, run (staging preferred):

`docs/scripts/sql/supabase_rename_public_tables_to_temp.sql`

1. Section **A** — preview rename list  
2. Section **B** — apply `public.foo` → `public.foo_temp` (identity keep-list editable)  
3. Section **C** — rollback  

`auth.*` is untouched. Failures in New then point at code still using `supabase.from('…')` or RPCs on old names.
