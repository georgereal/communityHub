# Design Patterns & Behavioral Decisions

> **Purpose:** Central reference for recurring behavioral patterns and design
> decisions in CommunityHub / ApartmentMaintenance. Read this *before* diving
> into source files — it captures *why* code is shaped the way it is, so agents
> can work consistently without re-discovering conventions from raw source.
>
> **Process:** Update this file whenever you introduce a non-obvious behavioral
> or data-flow pattern. The AGENTS.md "Commit Checklist" includes a step to
> verify this file covers new patterns.

See also: `docs/REPO_MAP.md` (structure & commands), `docs/ARCHITECTURE_NEW.md`
(REST/Mongo domain segregation).

---

## 1. Occupancy Status — Auto-Derive + Explicit Override

**Files:** `classic/src/unitDirectory.js` (`openUnitDetailModal`, `saveUnitEdit`),
`classic/src/residents.js` (`classifyUnitOccupancy`),
`apps/new/src/propertyApp/units/UnitDetailDialog.jsx` (`handleSaveMaster`),
`apps/new/src/propertyApp/units/UnitFormDialog.jsx` (`handleSave`),
`apps/new/src/propertyApp/units/api.js` (`listDirectoryUnits`, `saveUnitFields`),
`docs/scripts/sql/supabase_units_directory.sql`

### The two modes

| Mode | DB value (`units.occupancy_status`) | Behavior |
|---|---|---|
| **Auto** (derived) | `null` or empty string | Status computed live from resident records. |
| **Explicit** (override) | One of the `OCCUPANCY_STATUSES` keys | Honored as-is; no derivation. |

### Derivation logic — `classifyUnitOccupancy()`

Defined in `classic/src/residents.js`, re-exported via
`apps/new/src/unitDirectory.js`. Called by `deriveUnitOccupancy()`.

```
1. If unit.occupancy_status is a valid explicit key → return it (override wins).
2. No owners and no tenants → NON_ALLOTABLE
3. Any tenants → TENANT_OCCUPIED
4. Any residing owners → OWNER_OCCUPIED
5. Otherwise → VACANT
```

`is_residing` field on residents controls OWNER_OCCUPIED vs VACANT.
Tenants always report `is_residing: true`.

| Key | Label | Short | Can be stored? |
|---|---|---|---|
| `OWNER_OCCUPIED` | Owner residing | Owner | ✅ Yes |
| `TENANT_OCCUPIED` | Tenant occupied | Tenant | ✅ Yes |
| `VACANT` | Vacant | Vacant | ✅ Yes |
| `NON_ALLOTABLE` | Non-allotable | N/A | ❌ No (derived only) |
| `UNDER_RENOVATION` | Under renovation | Renovation | ✅ Yes |
| `LOCKED` | Locked / dispute | Locked | ✅ Yes |
| `DEVELOPER_HOLD` | Developer hold | Dev hold | ✅ Yes |

### The "auto-derive with manual override" pattern

This is the **template** for any field that can be auto-computed from other data
but also accepts an explicit user override. The same pattern (snapshot the
derived value at form-init, preserve null on save if unchanged) is used for
`occupancy_status` in all three UI implementations.

#### Pattern steps

1. **On dialog open:** compute `derivedOcc = deriveUnitOccupancy(unit, residents)`.
2. **If `unit.occupancy_status` is set** → dropdown shows it (explicit mode).
3. **If empty** → dropdown shows `derivedOcc` (auto mode, displaying the
   computed value).
4. **Snapshot** the derived value for later comparison:
   - Classic: module-level `editingUnitOccWasAuto` + `editingUnitOccDerived`
   - New (React): `autoOccRef.current` (`useRef`)
5. **On save:** if unit was auto AND form value === snapshot → save `null`.
   Otherwise → save the form value as explicit override.

#### Why this pattern exists

Without it, opening a form and clicking "Save" without touching the dropdown
would **accidentally lock in** the currently-derived status as an explicit
override. The pattern ensures `null` (auto) survives an innocent round-trip.

#### Save logic (verbatim from each implementation)

Classic (`saveUnitEdit()`):
```js
let saveOcc = occ;
if (editingUnitOccWasAuto && occ === editingUnitOccDerived) {
    saveOcc = null;
}
// → patch.occupancy_status = saveOcc
```

New (`UnitFormDialog.handleSave` + `UnitDetailDialog.handleSaveMaster`):
```js
occupancy_status:
    (autoOccRef.current && form.occupancy_status === autoOccRef.current)
        ? null
        : (form.occupancy_status || null)
```

### Where the pattern lives

| App | Open (pre-populate) | Save (preserve auto) |
|---|---|---|
| Classic | `openUnitDetailModal()` in `classic/src/unitDirectory.js` | `saveUnitEdit()` |
| New | `UnitDetailDialog.jsx` `useEffect` → `setForm()` | `handleSaveMaster()` |
| New (add/edit) | `UnitFormDialog.jsx` `useEffect` → `setForm()` | `handleSave()` |

### Data model contract

The SQL constraint in `docs/scripts/sql/supabase_units_directory.sql` enforces:
```sql
occupancy_status text CHECK (
    occupancy_status IS NULL
    OR occupancy_status IN (
        'OWNER_OCCUPIED', 'TENANT_OCCUPIED', 'VACANT',
        'UNDER_RENOVATION', 'LOCKED', 'DEVELOPER_HOLD'
    )
)
```
`NON_ALLOTABLE` is only returned by derivation — it can never be stored.

---

## 2. Unit number normalization — `normUnit()`

**Files:** `classic/src/residents.js` (source), re-exported via
`apps/new/src/unitDirectory.js`, `apps/new/src/residents.js`

Always compare / look-up units by `String(value).trim().toUpperCase()`.
Defined once in `classic/src/residents.js` and re-exported to New.

---

## 3. Block / tower — explicit field or derived

**Files:** `classic/src/unitDirectory.js` (`deriveBlockFromFlat`),
`apps/new/src/residents.js` (`getResidentBlock`)

`unit.block` is the explicit block/tower label. When empty, the UI falls back:
- Classic: `getResidentBlock(unitNumber)` — infers block from unit number prefix.
- New: `deriveBlockFromFlat(unitNumber)` — same logic in New utility layer.

---

## 4. New app — `live` vs `form` in `UnitDetailDialog`

**File:** `apps/new/src/propertyApp/units/UnitDetailDialog.jsx`

`UnitDetailDialog` resolves a `live` object from the directory store (which
includes derived `occupancy` via `listDirectoryUnits()`). The `form` state is
initialized from `live`, edited independently, and only committed via
`handleSaveMaster`. The `live` object also drives real-time display (e.g. the
occupancy chip in the title bar) separate from the edit form.

This separation means **display data** (live) and **edit data** (form) never
cross-contaminate.

---

## 5. New app — REST API shape for units

```
GET    /api/property/units             → list + annotate with derived occupancy
POST   /api/property/units             → create
PATCH  /api/property/units/:id         → update (partial; nulls allowed)
```

The property Mongo service (`apps/new/api/propertyMongo/service.js`) stores
`occupancy_status: String` (nullable). Null = auto. The API does **not**
auto-derive — that happens client-side via `classifyUnitOccupancy()`.

---
## 6. State Management Architecture

**Two state implementations** — Classic and New — selected by the
`ch_ui_mode` cookie.

### Classic — `classic/src/store.js`

- Uses **Supabase Postgres** as the backing store.
- `portalState` is a global mutable object populated via `pullState()` which
  calls `fetchApartmentState()` (a `/api/db` proxy query).
- Domains are loaded lazily: `stateLoader.js` maps each route/view to a set of
  domain data (`core`, `property`, `finance`, `operations`, `security`,
  `portal`, `admin`).
- `STATE_DOMAINS` is the canonical list. `domainsForRoute(route)` resolves
  which domains to load for a given route.
- Finance-New (`finance-new-accounts` view) does **not** load classic finance
  domains — it boots via `/api/finance-mongo` REST instead.

### New — `apps/new/src/runtime/state.js`

- Uses **MongoDB** as the backing store via Vercel serverless API routes.
- `portalState` is a simpler in-memory object; `pullState()` is essentially a
  no-op (state is fetched per-API-call).
- `loadPropertyState()` in `apps/new/src/propertyApp/client.js` fetches
  `/api/property` and hydrates `portalState` (units, residents, etc.).

### Cross-app rule: derived data never persisted

Both apps compute `occupancy` (derived status) **client-side only**. It is
never sent to the API as a field — only `occupancy_status` (the explicit
override) is stored. The derived value is always recomputed from `residents` +
`unit.occupancy_status`.

---
## 7. Data Access — Classic (Supabase Query Builder) vs New (REST)

### Classic — `classic/src/dbClient.js`

- Uses a **custom Supabase query builder** (`QueryBuilder` class) that produces
  a query JSON consumed by the `/api/db` endpoint.
- `postDb(query)` auto-injects `apartment_id` filter for all tables in the
  `APARTMENT_SCOPED_TABLES` set — multi-tenant isolation happens server-side.
- `isPlaceholderApartmentId(id)` guards against `"apt-default"` (dev placeholder).

### New — `apps/new/src/propertyApp/client.js`, `apps/new/src/financeNew/api.js`

- Direct **REST** calls via the shared `propertyFetch()` / `financeNewFetch()`
  wrappers. These wrap `fetch()` with Supabase auth session cookies.
- Each domain has its own API entry:
  - `/api/property/*` — Property (units, residents, parking)
  - `/api/finance/*` — Finance-New (ledger, billing, bank recon)
  - `/api/integrations/*` — Integrations (passbook OCR jobs, OAuth connections)
  - `/api/identity/*` — Identity (RBAC, workspace boot)

### Save pattern — reload state after mutation

Every mutation (`saveUnitFields`, `createUnit`, `saveResident`, etc.) in the
## 8. RBAC & Capabilities

**Files:** `apps/new/src/capabilities.js`, `apps/new/src/rbac.js`,
`apps/new/src/rbacMatrix.js`

### Named capabilities (`can()` / `assertCan()`)

Each UI action maps to a **capability ID** (e.g. `units.create`,
`accounts.edit`, `admin.roles.edit`). Defined in the `CAPABILITIES` array in
`capabilities.js`.

Each capability has:
- An `app` label (`property-new`, `finance-new`, `admin-new`)
- A CRUD requirement (e.g. `['apartment_mgmt', 'update']`) or `anyCrud`
  (satisfies if ANY of the listed CRUD pairs match)
- Optional `societyAdmin: true` flag (restricted to society-admin users)

### Resolution order

1. `can(capabilityId)` checks `crudAccess` in `portalState` (populated from
   `/api/identity` at boot).
2. For admin-new screens, also checks `isSocietyAdminUser()` /
   `isSystemAdminUser()` from `rbac.js`.

### Classic RBAC

Classic uses a separate but parallel system: `classic/src/rbac.js`,
`classic/src/rbacMatrix.js`. The `canCrud` helper (re-exported to New) checks
CRUD matrix entries.

---
New app calls `await loadPropertyState()` (or equivalent) **after** the API
call to refresh `portalState`. There is no optimistic UI update — the UI
re-renders from fresh server data.

---
## 9. View Dispatch / Lazy Loading

**Files:** `classic/src/views/controllers.js`, `classic/src/navigation.js`

### Classic (SPA)

- Routes declared in `classic/src/navigation.js` (`NAV_MODULES`).
- `views/controllers.js` dispatches on `view` field — each case does a dynamic
  `import()` of the feature module, keeping initial bundle small.
- Subviews are handled via `switchSubView()` or `window.switchSubView()`.
- `views/inits/*.js` files wire up view-specific event listeners / side-effects.

### New (MPA)

- Each page is a standalone HTML entry point.
- Navigation entries in `apps/new/src/navigation.js` (`NAV_MODULES`) gate on
  capabilities via the `permission` field.
- `altPermissions` array allows fallback access (e.g. finance users can see
  vehicle_registry views via altPermissions).

## 10. Multi-tenant / Apartment Context

### Classic

- `globalThis.__portalActiveApartmentId` is the active apartment ID.
- `dbClient.js` auto-injects it as a Supabase `eq` filter for all
  `APARTMENT_SCOPED_TABLES` queries.
- `setActiveApartmentIdForApi(id)` sets the global.

### New

- Apartment is passed via the session/JWT. API routes derive `apartmentId`
  from the auth session, not a client-side global.
- `isPlaceholderApartmentId()` guards against `"apt-default"`.

---
---
## 11. Excel Import / Export

**Files:** `classic/src/unitDirectory.js`,
`apps/new/src/propertyApp/units/api.js`,
`apps/new/src/financeNew/ledgerTransform.js`

### Unit directory Excel

- Template download: `downloadUnitsTemplate()` builds a workbook with two
  sheets — "Units" and "Residents" — using ExcelJS. Headers defined in
  `UNIT_DIRECTORY_HEADERS` and `RESIDENTS_SHEET_HEADERS`.
- Import: `importUnitsExcel(file)` then `parseUnitDirectoryExcel(file)` parses
  the workbook, then POSTs to `/api/property/units/import` (New) or the
  classic `/api/db` equivalent.

### Finance ledger

- Ledger column mapping: `ledgerColumnMapping.js` allows users to map
  spreadsheet columns to ledger fields.
- `ledgerTransform.js` transforms raw rows into `journal_entry` records.
- Bank statement imports go through `bankStatementOrdering.js` for line
  ordering, then `bankClassificationRules.js` for auto-categorization.

---
## 12. Finance — Classic vs New segregation

| Concern | Classic (Postgres) | New (Mongo) |
|---|---|---|
| Ledger | `chart_of_accounts`, `journal_entries`, `journal_lines` | `accounts` collection, `entries` sub-collection |
| Billing | `maintenance_invoices`, `maintenance_invoice_lines` | `billing` REST (`/api/finance/billing`) |
| Bank | `bank_statement_imports`, `bank_statement_lines` | `bank` REST (`/api/finance/bank`) |
| Sync | Supabase client queries | `/api/integrations` REST |
| Docs | `financeDocuments.js` (Classic) | `financeDocuments.js` (New, separate module) |

The two finance systems are **completely isolated** — there is no shared
state or model. The `ch_ui_mode` cookie determines which UI boots.
Migration scripts exist in `scripts/migrate-*.mjs` to move data from
Postgres to Mongo.

---

## 13. Expense plan ↔ bill ↔ ledger — reference links + one-way back-propagation

Expense plans, finance documents (bills/receipts) and ledger entries are
**separate entities** connected by foreign-key-style refs — never merged models.

### Reference fields

| Entity | Field | Points at |
|---|---|---|
| one-off plan item | `finance_document_id` | voucher `id` |
| one-off plan item | `transaction_id` | ledger `id` (only when done) |
| recurring template | `occurrence_finance_docs[plan_date]` | voucher `id` |
| recurring template | `occurrence_links[plan_date]` | ledger `id` |
| recurring template | `occurrence_amounts[plan_date]` | actual amount override (template `amount` stays untouched) |
| voucher | `expense_plan_item_id` | one-off plan item `id` |
| voucher | `expense_plan_recurring_id` + `expense_plan_date` | recurring occurrence origin |
| voucher | `transaction_id` / `ledgerEntryId` | ledger `id` |
| ledger entry | `expense_plan_ref`, `expense_plan_item_id`, `expense_plan_kind`, `expense_plan_date` | plan back-ref (metadata only) |
| ledger entry | `voucherIds[]` | linked voucher ids |

Related data is loaded **on demand**: the expense-plan detail modal fetches the
bill/txn by id (`fetchBillById`, `fetchLedgerTxnById`) instead of relying on the
cached page slice. All search inputs in link modals are API-backed and debounced.

### Post-mutation refresh convention — config in the response, not boot refetch

Any mutation that writes `finance_config` MUST return the fresh `config` in its
response (`{ ok, ..., config }`). `postFnMutation` applies it via
`applyMongoPacksToClassic` automatically — no extra fetch. `MUTATION_PACKS` lists
only packs whose collections the response can't carry (ledger page, vouchers
page, bank imports); do **not** add `'boot'` for config changes. `boot` is only
for the initial page load (config + collection `counts`).

### One-way back-propagation (ledger → bill → plan)

The ledger is the source of truth for actuals; data flows **back** to the plan,
never forward. `applyExpensePlanActual()` / `reopenExpensePlanActual()` in
`apps/new/api/finance-mongo-mutations.js` are the shared helpers.

- **Bill linked to ledger** (`linkFinanceDocuments`): bill amount ← txn amount;
  if the bill has a plan origin ref → plan marked done (one-off `status:'done'` +
  `transaction_id`, or recurring `completed_dates + occurrence_links[date]`),
  amount synced (`item.amount` / `occurrence_amounts[date]`).
- **Bill unlinked** (`unlinkFinanceDocuments`): if the plan's stored txn ref
  matches → plan reopens (`status:'planned'`, occurrence date removed).
- **Bill edited** (`saveFinanceDocument`): plan amount updates; the ledger row
  is *never* touched — the plan must not drive ledger data.
- **Ledger edited** (`saveTransaction` amount change): propagates to every
  linked voucher (`voucherIds`), then through each voucher's plan ref.
- **Direct plan↔ledger links** (`completeExpensePlanItem`, `linkExpensePlanItem`,
  `setExpensePlanOccurrenceStatus` done+txn): if a plan-linked bill exists
  (`finance_document_id` / `occurrence_finance_docs[date]`), `syncDocToLedgerActual`
  sets its `transaction_id`/`status:'linked'` and mirrors the txn amount.
- **Bill deleted** (`deleteFinanceDocument`): the plan's doc ref is cleared;
  completion status is left alone.

### Recurring occurrence link mutation

`linkExpensePlanOccurrenceDoc` (`POST /api/finance/expense-plan/recurring/:id/occurrence-doc`)
writes **only** `occurrence_finance_docs[plan_date]`. Do NOT reuse
`setExpensePlanOccurrenceStatus` for bill links — its `planned` branch clears
ledger links and completion state.

---

## 14. Finance MPA mobile CSS — `fn-*` id bridging

**What.** `classic/src/financeMobile.css` holds all mobile/tablet layout rules
(≤767px card-table transforms, toolbar grids, header chrome). It is shared by
the classic SPA *and* the Finance MPA (`apps/new/src/financeApp/finance-app.css`
`@import`s it).

**The problem it solves.** MPA fragments rename classic element ids `#x` →
`#fn-x` (`#fn-cash-ledger-items`, `#fn-subview-ledger`, …). Classic selectors
that are *id-scoped* therefore silently do not match in the MPA, even though
class-based rules apply fine.

**The convention.** Wherever an MPA counterpart id exists, selectors are
written as `:is(#classic-id, #fn-classic-id)` — e.g.
`:is(#cash-ledger-items, #fn-cash-ledger-items) .bank-recon-table`. This keeps
one source of truth; the added alternative matches nothing in the classic SPA.

**Rules when adding mobile CSS for finance pages:**

- Prefer class selectors — they work in both apps unchanged.
- For id-scoped rules, check the MPA fragment (`apps/new/src/financeApp/html/`)
  for the `fn-` twin and use `:is(#x, #fn-x)`. Some ids are shared unchanged
  (e.g. `#ledger-table-shell`, `#ledger-table-wrap`) — those need no twin.
- MPA-only structures (no classic analogue) live in `finance-app.css`, scoped
  to `html[data-finance-app="1"]`.
- `raised-page-*` rules apply to both `#fn-subview-finance-docs` and
  `#fn-subview-invoices-raised` — the MPA split the raised list into its own
  page.
- **Informational text goes behind ⓘ buttons**, not static hint paragraphs:
  `<span class="fa-info-anchor">` + `[data-fa-info]` button +
  `span.fa-info-tip` (toggled by a delegated listener in
  `financeApp/mount.js#wireInfoTips`). Applies on all viewports — do not add
  `fa-panel__hint` paragraphs for section descriptions in MPA fragments.

---

## 15. Master category list (`finance_categories`) + ledger running-balance overlay

### Master category list

**What.** One server-side collection `finance_categories`
(`{ id, apartment_id, name, type: 'IN'|'OUT' }`) is the master list of income /
expense categories for every Finance-New page (ledger, bank recon, bills,
quick capture, admin).

**Why.** `buildCategoryOptions()` (`apps/new/src/classifyOptions.js`) merges
several sources; previously, categories that existed only on ledger rows or
vouchers were missing on pages (bank recon) that deliberately don't load those
packs, and `extraCategories` was session-only so custom categories vanished on
reload.

**Where.**
- `apps/new/api/finance-mongo.js` `boot()` → `loadMasterCategories()` returns
  the collection rows **plus** auto-seeds rows for `cat` values already in use
  on `ledger_entries` / `vouchers` (typed by `type`/`kind`), so no data
  migration is needed.
- `apps/new/api/finance-mongo-mutations.js` `tableWrite` — `expense_categories`
  table upserts/deletes into `finance_categories` (dedupe: type + name,
  case-insensitive).
- `apps/new/src/classifyOptions.js` `registerCustomCategory` pushes to session
  state **and** fires `mongoUpsert('expense_categories', …)` (best-effort);
  `registerCustomSubCategory` does the same via `expense_sub_categories`
  (config `subCategories` master list).
- `state.js` → `s.categories`; `load.js` `ensureBootMapped` and
  `packCache.js` pass `categories` into `applyMongoPacksToClassic`, which maps
  them to `f.extraCategories`.

**Rule.** Never add a page-specific category list — extend the master
collection (or `INCOME_CATS`/`EXPENSE_CATS` for system defaults).

### Ledger running-balance overlay on reads

**What.** `loadLedgerPage` (`financeMongo/services/ledgerList.js`) overlays a
live-computed `running_balance_after` on returned BANK rows whenever
`config.ledgerBalance.needsRecalc` is true **or** any returned active BANK row
lacks a stored value — provided an opening balance is set.

**Why.** The ledger list is paginated (50-row windows), so the client cannot
live-walk the full ledger and relies on stored `running_balance_after`, which
only exists after a `recalculateLedgerBalances` run. The overlay restores the
"calculated" paren in the Passbook/calc column without a manual recalc.

**Where.** Shared walk lives in
`apps/new/api/financeMongo/services/ledgerBalances.js`
(`loadBankLedgerChronological`, `computeLedgerRunningBalances`) — the same
ordering (`line_date` when matched, then statement line order) as
`recalculateLedgerBalances`, which imports it. Client display logic:
`ledgerTable.js` `ledgerRunningBalancesForDisplay` — stored map for partial
windows, live walk merged over stored for fully loaded ledgers.

---

## 16. Tax amount table (Taxable / Tax % / Tax ₹ / Total)

**What.** Expense entry points show a 4-cell amount table instead of a single
amount field. The user fills any consistent pair and the rest computes
(base + pct → tax + total; total + pct → base + tax; base + tax → total + pct;
total + tax → base + pct). Tax % defaults to 0, so existing flows are
unchanged when it's left alone.

**Where.**
- `apps/new/src/financeNew/taxAmountTable.js` — `wireTaxAmountTable`,
  `readTaxAmountTable`, `fillTaxAmountTable`, `resetTaxAmountTable`. The
  `total` cell keeps the legacy element id (`cash-amt`,
  `fn-eplan-item-amount`, `fn-eplan-rec-amount`) so existing reads are
  untouched.
- `apps/new/src/financeApp/html/_cash-modal.html` — expense section (shared by
  "Add bill" and "Add expense"; income side has no tax table).
- `apps/new/src/financeApp/html/expense-plan.html` — one-off and recurring
  forms.
- `finances.js` `saveCashData` and `expensePlan.js` `saveOneOff` /
  `saveRecurring` send `tax_percent`, `taxable_amount`, `tax_amount` with the
  save; `amount` stays the **total** (final figure). All server saves pass
  these fields through (`vouchers`, `ledger_entries`, config plan lists).

**Rule.** When adding an amount entry form, use the tax table and store the
computed total in `amount`; keep `taxable_amount`/`tax_amount`/`tax_percent`
as the audit trail — never reinterpret `amount` as pre-tax.

**Recurring templates.** On the expense-plan recurring form the tax table's
Total is the **lump sum for the whole schedule**; period rows only distribute
it (no per-period tax/amount). `total_amount` stores the lump, `period_amounts`
the per-index shares (row-sum must equal `total_amount` — last row absorbs
rounding drift), `period_dates` (index-aligned array, nulls = use computed
cadence date) stores per-row date overrides. `projectRecurringOccurrences`
resolves `period_dates` so `occurrence_links`/`occurrence_amounts`/
`completed_dates` stay keyed to the effective date. Templates with no Term are
ongoing — there the Total field is the per-period amount (`total_amount` null).

---

## 17. Petty Cash funding entries — never read from the paginated ledger page

**What.** Any feature that needs *all* Petty Cash funding ledger entries
(bucket tables, cash-float KPIs, link dialogs) must merge
`voucherAggregates.fundingEntries` into `fnFinances().txns`, deduped by `id`.
The API (`voucherAggregates` in `apps/new/api/finance-mongo.js`) returns every
funding entry unpaginated — `cat`/`wallet`/`amount`/`date`/`is_cash_float`/
`exclude_from_cash_float`/`description`/`vendor_name`/`bank_reference`.

**Why.** `fnFinances().txns` holds only the loaded ledger window (~50 newest
rows). A funding entry outside that window silently drops out of
`planCashFloatBucketAllocation`, so its amount never enters the carry chain —
later buckets then render as `Used ₹0 · Full` and the bucket itself disappears.
This bit twice: the BANK BUCKETS panel (fixed via `computeCashFloatStore`)
and the "Link cash bills" dialog (fixed via `allFundingLedgerTxns`).

**Where.**
- `cashFloat.js` `computeCashFloatStore` — merges `voucherAggregates.fundingEntries`.
- `financeDocuments.js` `allFundingLedgerTxns()` — same merge off
  `aggregatesCache.fundingEntries`; used by `fundingBucketOf` and
  `ledgerCandidatesForCashLink`. `openLinkModal` triggers
  `ensureFinanceDocumentsAggregates()` so the supplement is fresh.

**Rule.** New code needing funding entries must use the merged list, never a
bare `fnFinances().txns.filter(isFundingLedgerTxn)`.

**Excel-style col_* filters are server-side.** Ledger (`/api/finance/ledger`)
and Bills & receipts (`listVouchers`) accept `col_*` params
(date/description/particulars/cat/kind/status/wallet/pay/amount) plus
`sort`/`sort_dir`; `excelColMenu.js` is the shared header-menu factory —
`ledgerColFilter.js` and `docsColFilter.js` inject their own state. `eq`
matches |amount| (magnitude); gt/lt/between stay signed. `passbook`/`bills`
ledger columns remain client-only.

**Amount mirroring on link.** `linkFinanceDocuments` mirrors the ledger
amount onto a bill **only** for a 1:1 payment link (single doc ↔ non-funding
OUT txn). Bucket/deposit links must never overwrite `voucher.amount` — many
bills share one funding txn, so mirroring silently rewrites every bill to the
bucket amount (this corrupted an Aug-29 batch to ₹10,000 each).

---

## 18. When to add a new pattern here

Before merging a PR that introduces a non-obvious data-flow or behavioral
convention (e.g. a new "auto-derive on null" field, a new cross-app sync
strategy), add a section to this file. Include:

- **What** the pattern does
- **Why** it exists (the problem it solves)
- **Where** it lives (files, functions)
- **Data model impact** (schema, API shape)
- **Testing considerations** (edge cases, what to verify)
- **Related patterns** (cross-references to other sections)

This keeps the collective mental model current for future agents who
shouldn't need to read every source file to understand how the system behaves.
