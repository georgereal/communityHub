# CommunityHub — Phased Product Requirements

> **Purpose:** Hand this document to a Cursor agent to implement features in order.  
> **Project:** ApartmentMaintenance / CommunityHub — Vite + vanilla JS + Supabase SPA  
> **Repo conventions:** SQL migrations as `supabase_*.sql` at repo root; feature modules in `src/`; UI in `index.html` + `src/style.css`

---

## How to use this document

1. **Complete one phase (or sprint) before starting the next** unless dependencies say otherwise.
2. **Always ship SQL + RLS first**, then `store.js` hydration, then UI module, then wire in `main.js` / `initMaintenanceBilling()` etc.
3. **Match existing patterns:**
   - Billing: `src/maintenanceBilling.js`, `src/billingHeads.js`, `src/penaltyRules.js`, `src/billingGroups.js`, `src/invoicePdf.js`
   - Parking: `src/registry.js`, `src/allocation.js`, `src/vehicleAudit.js`
   - Residents/units: `src/unitDirectory.js`, `src/main.js` (residents CRUD)
   - Ledger: `src/finances.js`
   - Admin: `src/admin.js`
   - State: `src/store.js` → `portalState` + `pullState()`
   - Nav: `src/navigation.js`
4. **Do not break offline vehicle registry** — new modules may require Supabase.
5. **User runs SQL manually** in Supabase SQL Editor; document new files in each phase section.

---

## Current baseline (already built)

| Area | Status | Key files / tables |
|------|--------|-------------------|
| Parking & vehicles | Done | `registry.js`, `vehicles`, `parking_slots` |
| Unit directory | Done | `unitDirectory.js`, `units` (+ block, bhk, area_sqft) |
| Residents | Partial (split UX) | `residents` table, `main.js`, unit import |
| Cash & bank ledger | Done | `finances.js`, `transactions` |
| Maintenance billing | Done | `maintenance_invoices`, charge heads, penalties, billing groups |
| Invoice PDF + send | Done (mailto/share) | `invoicePdf.js` |
| RBAC | Schema v2 exists; UI uses v1 | `supabase_rbac_v2.sql`, `main.js` |
| Vehicle audit log | Done | `vehicle_audit_log`, `vehicleAudit.js` |
| Admin | Done | bank, vendors, sub-categories, staff |

---

## Guiding principles

1. **Schema first** — migration + RLS before UI.
2. **Reuse engines** — penalties pattern for fines; `invoicePdf.js` for all PDFs; ExcelJS for exports.
3. **RBAC v2 before resident portal** — row-level security must enforce access, not nav alone.
4. **Single apartment scope** — multi-society rollup is out of scope until Phase 6.
5. **Minimal diff** — extend existing modals/routes; avoid rewrites.

---

## Phase 1 — Billing operations & data quality

**Goal:** Accountants and auditors can review billing runs, chase dues, trust resident data, and slice by block.  
**Estimated effort:** 4–6 weeks (4 sprints)

### Sprint 1.1 — Billing batch history

#### Problem
`maintenance_billing_batches` is written on bulk raise but has no UI.

#### User stories
- As an accounts manager, I want to see all billing runs (e.g. "Apr 2026") so I can audit what was raised.
- As an auditor, I want to open a batch and see every invoice, total amount, and which flats were skipped.

#### Schema (`supabase_billing_batch_history.sql`)

```sql
-- Extend existing table (safe to re-run)
alter table public.maintenance_billing_batches
  add column if not exists created_by uuid references auth.users(id) on delete set null;

alter table public.maintenance_billing_batches
  add column if not exists total_amount numeric(12, 2);

alter table public.maintenance_billing_batches
  add column if not exists skipped_count int not null default 0;

-- Optional detail for skips (flat already had invoice for period)
create table if not exists public.maintenance_billing_batch_skips (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.maintenance_billing_batches(id) on delete cascade,
  apartment_id uuid not null,
  unit_id uuid not null references public.units(id) on delete cascade,
  reason text not null,
  created_at timestamptz not null default now()
);
```

- RLS: same pattern as `maintenance_billing_batches` (apartment access via `user_apartments` or admin).
- On `createBulkMaintenanceInvoices`: set `created_by`, `total_amount`, `skipped_count`, insert skip rows.

#### UI requirements
- **Route:** subview on Maintenance Billing (`#finance-billing`) — tab "Billing Runs" alongside Invoice Register / Flat Summary / Collections.
- **List:** period, due date, created at, invoice count, total amount, skipped count, notes.
- **Detail modal or page:** table of invoices in batch (flat/group, amount, status); list of skipped flats + reason.
- **Actions:** View invoice, Download all PDFs (ZIP via `downloadInvoicePdfsZip`), link to Send Invoices filtered to batch.

#### Acceptance criteria
- [ ] After raising invoices, new batch appears in Billing Runs list.
- [ ] Batch total = sum of `maintenance_invoices.amount` where `batch_id` matches.
- [ ] Skipped flats (duplicate period) appear in batch detail with reason.

#### Files to touch
- `supabase_billing_batch_history.sql` (new)
- `src/maintenanceBilling.js` — persist batch metadata on raise
- `src/store.js` — load batch skips if needed
- `index.html` — billing runs subview + detail UI
- `src/style.css` — minimal

---

### Sprint 1.2 — Dues aging & reminders

#### Problem
Open invoices exist; no aging buckets or reminder workflow.

#### User stories
- As treasurer, I want a 30/60/90-day aging report to present in committee meetings.
- As accounts staff, I want to send payment reminders with PDF to flats that have overdue balances.

#### Schema (`supabase_maintenance_reminders.sql`)

```sql
create table if not exists public.maintenance_reminder_log (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  invoice_id uuid not null references public.maintenance_invoices(id) on delete cascade,
  channel text not null check (channel in ('EMAIL', 'PDF', 'MANUAL')),
  reminder_type text not null default 'OVERDUE' check (reminder_type in ('OVERDUE', 'DUE_SOON')),
  days_overdue int,
  sent_to_email text,
  sent_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
```

#### Business rules — aging buckets
Compute from **due_date** (not invoice date):

| Bucket | Rule |
|--------|------|
| Current | Due date ≥ today OR no due date |
| 1–30 days | 1 ≤ days overdue ≤ 30 |
| 31–60 days | 31–60 |
| 61–90 days | 61–90 |
| 90+ days | > 90 |

- Only invoices with `balance > 0` count.
- Combined invoices: attribute full balance to billing group label; aging by oldest due date in group or invoice due date.
- Support filter by **block** (from `units.block`).

#### Reminder PDF (`src/reminderPdf.js` or extend `invoicePdf.js`)
- Society name, flat(s), bill-to name
- Period, due date, days overdue
- Amount billed, paid, **balance due**
- Payment instructions (from `apartment_bank_accounts`)
- Tone: reminder (not duplicate full invoice line breakdown unless optional toggle)

#### UI requirements
- **Route:** Maintenance Billing → tab "Aging & Reminders"
- **Summary cards:** total outstanding per bucket
- **Table:** flat/group, period, due date, balance, bucket, last reminder sent, resident email
- **Actions:** Send reminder (reuse email flow from `emailInvoicePdf`), Download reminder PDF, Export Excel
- **Bulk:** Select rows → send reminders (confirm; log each)
- Warn if no email on file (link to Residents)

#### Acceptance criteria
- [ ] Aging totals reconcile with billing KPI "Total Outstanding".
- [ ] Reminder send creates `maintenance_reminder_log` row.
- [ ] Duplicate reminder same day requires confirmation.

#### Files to touch
- `supabase_maintenance_reminders.sql` (new)
- `src/duesAging.js` (new) — report + UI
- `src/invoicePdf.js` or `src/reminderPdf.js` — reminder PDF
- `src/maintenanceBilling.js` — wire tabs
- `index.html`, `src/style.css`

---

### Sprint 1.3 — Unified residents

#### Problem
Residents managed on Owners & Tenants page AND bulk-replaced via Unit Directory Excel — data diverges.

#### User stories
- As property manager, I want one place to manage residents linked to units.
- As billing user, I want invoice email/PDF to always use the same resident record.

#### Requirements
1. **Single source of truth:** `residents` table only.
2. **Unit Directory import:** Add import mode:
   - `update_listed` (default): upsert residents for flats in sheet only; do not delete other flats' residents
   - `replace_listed`: delete existing residents for flats appearing in sheet, then insert
   - `full_replace`: dangerous — delete all apartment residents then import (admin confirm)
3. **Unit detail → Residents tab:** Full CRUD inline (extend `unitDirectory.js`); remove redundant navigation to separate page for same action.
4. **Owners & Tenants page:** Rename to **Residents**; add flat + block filters; export Excel; same CRUD.
5. **Shared resolver:** Export `getBillToForInvoice` / resident lookup from one module (e.g. `src/residents.js`) used by `invoicePdf.js`, Send Invoices, reminders.
6. **Validation:** Warn if multiple OWNER records on same flat; validate email format.

#### Schema
No new tables required if `residents` exists. Optional:

```sql
alter table public.residents
  add column if not exists is_primary boolean not null default false;
```

#### Acceptance criteria
- [ ] Edit resident in unit detail → Send Invoices shows updated email same session (after `pullState` or local update).
- [ ] Unit Directory import with `update_listed` does not delete residents on unlisted flats.
- [ ] `invoicePdf.js` imports resident helpers from `src/residents.js` only.

#### Files to touch
- `src/residents.js` (new) — CRUD, fetch, `getBillToForInvoice`, cache
- `src/unitDirectory.js` — import modes, inline CRUD
- `src/main.js` — refactor residents page to use `residents.js`
- `src/invoicePdf.js` — import from `residents.js`
- `index.html` — label updates

---

### Sprint 1.4 — Block / tower dashboards

#### Problem
`units.block` exists but KPIs are society-wide only.

#### User stories
- As manager, I want to filter billing and parking by block/tower.

#### Requirements
1. **Global block filter** (dropdown + "All blocks") persisted in `sessionStorage` key `communityhub_block_filter`.
2. **Apply filter to:**
   - Maintenance Billing (invoice list, aging, flat summary)
   - Unit Directory table
   - Parking registry unit list (optional KPI strip)
3. **Block KPI strip** (when block selected): unit count, outstanding dues, open invoices, vehicle count.
4. Derive block list from distinct `units.block` + derive from flat number fallback (`unitDirectory.js` pattern).

#### Acceptance criteria
- [ ] Select "Block D" → invoice register shows only D-* flats and combined groups whose members are all in D (or any member in D — document choice: **any member in block**).
- [ ] Filter persists across page navigation in session.

#### Files to touch
- `src/blockFilter.js` (new)
- `src/maintenanceBilling.js`, `src/unitDirectory.js`, `src/registry.js`
- `index.html` — filter control in header or billing toolbar

---

## Phase 2 — Trust, control & bank ops

**Goal:** Treasurers reconcile bank statements; admins see who changed what; RBAC v2 enforced.  
**Estimated effort:** 4–6 weeks

### Sprint 2.1 — Activity audit trail

#### Problem
`vehicle_audit_log` exists; billing, residents, and role changes are not logged.

#### Schema (`supabase_activity_audit_log.sql`)

```sql
create table if not exists public.activity_audit_log (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  entity_type text not null,  -- INVOICE, RESIDENT, ROLE, ALLOCATION, BANK_MATCH, ...
  entity_id text not null,
  action text not null,       -- CREATE, UPDATE, DELETE, SEND_PDF, SEND_EMAIL, ...
  actor_id uuid references auth.users(id) on delete set null,
  actor_label text,
  summary text,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);
create index idx_activity_audit_apartment on public.activity_audit_log (apartment_id, created_at desc);
create index idx_activity_audit_entity on public.activity_audit_log (entity_type, entity_id);
```

#### Events to log (minimum)
| Entity | Actions |
|--------|---------|
| Invoice | create (bulk), delete, penalty apply, amount change |
| Resident | create, update, delete, import batch |
| Role assignment | grant, revoke |
| Payment allocation | create, delete |
| Reminder | send |
| Bank reconciliation | match, unmatch |

#### UI
- Admin → new sub-tab **Activity Log** (or Finance → Audit)
- Filters: entity type, date range, actor
- Invoice detail → collapsible "History" section

#### Helper (`src/activityAudit.js`)

```js
export async function logActivity({ entityType, entityId, action, summary, oldData, newData })
```

Call from maintenance billing, residents, admin user management.

#### Acceptance criteria
- [ ] Delete invoice → audit row with actor and invoice snapshot.
- [ ] RLS: read requires `accounts.view` or `rbac.view`.

---

### Sprint 2.2 — Bank reconciliation

#### Schema (`supabase_bank_reconciliation.sql`)

```sql
create table if not exists public.bank_statement_imports (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  bank_account_id uuid references public.apartment_bank_accounts(id),
  file_name text,
  period_start date,
  period_end date,
  imported_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.bank_statement_lines (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.bank_statement_imports(id) on delete cascade,
  apartment_id uuid not null,
  line_date date not null,
  description text,
  debit numeric(12, 2) not null default 0,
  credit numeric(12, 2) not null default 0,
  balance numeric(12, 2),
  match_status text not null default 'UNMATCHED' check (match_status in ('UNMATCHED', 'MATCHED', 'IGNORED')),
  transaction_id uuid references public.transactions(id) on delete set null,
  matched_at timestamptz,
  matched_by uuid references auth.users(id)
);
```

#### UI (`src/bankReconciliation.js`)
- Finance → new route or subview **Bank Reconciliation**
- Upload CSV/Excel (template: Date, Description, Debit, Credit, Balance)
- Split view: statement lines | unmatched ledger txns (bank wallet)
- Suggest matches: same amount, date ±3 days
- Manual match: select line + txn → `MATCHED`
- Mark line `IGNORED` (charges, etc.)

#### Acceptance criteria
- [ ] Import 50 lines → match 20 collections → unmatched count updates.
- [ ] Matched txn shows reconciliation badge in ledger list.

---

### Sprint 2.3 — RBAC v2 UI

#### Problem
`permissions`, `user_role_assignments`, `role_permissions` exist; UI writes `profiles.role` only.

#### Requirements
1. User management modal writes `user_role_assignments` per apartment.
2. `main.js` permission check uses `effective_apartment_permission()` or client-side fetch of assignments.
3. Map nav items to permission keys (already in `navigation.js`).
4. Roles to support: `apartment_admin`, `property_manager`, `accounts_manager`, `security`, `resident_viewer`.
5. Do not remove v1 fallback until v2 confirmed working.

#### Acceptance criteria
- [ ] `resident_viewer` login: only sees permitted nav; direct URL to billing blocked.
- [ ] RLS on `maintenance_invoices` respects apartment membership.

#### Files
- `src/rbac.js` (new or extend `main.js`)
- `supabase_rls_operational.sql` — verify policies

---

## Phase 3 — Resident-facing & payments

**Goal:** Owners view their data and pay online.  
**Estimated effort:** 6–8 weeks

### Sprint 3.1 — Resident portal (read-only)

#### Schema (`supabase_resident_portal.sql`)

```sql
create table if not exists public.resident_user_links (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  resident_id uuid not null references public.residents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  verified_at timestamptz,
  unique (apartment_id, user_id, resident_id)
);
```

**Linking strategy:** On login, if `auth.users.email` matches `residents.email`, auto-link (or admin approval queue).

#### Portal routes (hash)
- `#portal-home` — my flats summary
- `#portal-invoices` — open/paid, PDF download
- `#portal-payments` — collection history
- `#portal-vehicles` — read-only
- `#portal-notices` — Phase 3.3
- `#portal-tickets` — Phase 4.1 (stub OK)

#### RLS
Residents see only data for linked `unit_id`s / resident records.

#### Acceptance criteria
- [ ] Owner login sees only their flats' invoices.
- [ ] No access to registry edit, raise invoice, or other units.

#### Files
- `src/residentPortal.js` (new)
- `index.html` — portal views (or separate layout section)
- `navigation.js` — portal nav when role is `resident_viewer`

---

### Sprint 3.2 — Online payment (Razorpay / Cashfree)

#### Schema (`supabase_payment_intents.sql`)

```sql
create table if not exists public.payment_intents (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  invoice_id uuid not null references public.maintenance_invoices(id),
  gateway text not null check (gateway in ('RAZORPAY', 'CASHFREE')),
  gateway_order_id text,
  amount numeric(12, 2) not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'PAID', 'FAILED', 'EXPIRED')),
  metadata jsonb,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
```

#### Backend (required)
- **Supabase Edge Function** `payment-webhook`: verify signature → create `transactions` (IN, Maintenance Collection) → `maintenance_payment_allocations` → refresh invoice paid.
- **Edge Function** `create-payment-order`: create gateway order, return checkout URL / UPI link.

#### Admin config
Store gateway keys in `society_config` extension or `apartment_payment_config` table (encrypted / service role only).

#### UI
- Invoice PDF: payment link / QR
- Portal: Pay button on open invoices
- Public pay page: signed token URL `?pay=<invoice_id>&token=<hmac>` for email links without login

#### Acceptance criteria
- [ ] Test mode payment marks invoice paid and creates ledger entry.
- [ ] Webhook idempotent (duplicate events ignored).

---

### Sprint 3.3 — Notices & circulars

#### Schema (`supabase_society_notices.sql`)

```sql
create table if not exists public.society_notices (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  title text not null,
  body text not null,
  priority text not null default 'NORMAL' check (priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  audience text not null default 'ALL' check (audience in ('ALL', 'BLOCKS', 'UNITS')),
  block_filters text[],
  unit_ids uuid[],
  published_at timestamptz,
  expires_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.notice_read_log (
  notice_id uuid references public.society_notices(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (notice_id, user_id)
);
```

#### UI
- Admin/Property → **Notices** (new page)
- Create, publish, target blocks/units
- Optional: email blast (Edge Function Phase 3+)
- Portal: notice board

#### Acceptance criteria
- [ ] Block A notice visible only to Block A residents in portal.

---

## Phase 4 — Operations & facilities

**Goal:** Day-to-day society operations beyond finance.  
**Estimated effort:** 8–10 weeks

### Sprint 4.1 — Helpdesk / complaints

#### Schema (`supabase_helpdesk.sql`)

```sql
create table if not exists public.helpdesk_tickets (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  unit_id uuid references public.units(id),
  category text not null,
  subject text not null,
  description text,
  status text not null default 'OPEN' check (status in ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED')),
  priority text not null default 'NORMAL',
  assigned_to uuid references public.staff_members(id),
  sla_due_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
```

- Storage bucket for ticket attachments (like receipts).
- UI: Property → Helpdesk; portal: raise ticket + status.

---

### Sprint 4.2 — Move-in / move-out checklist

#### Schema (`supabase_unit_transitions.sql`)

```sql
create table if not exists public.unit_transitions (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  unit_id uuid not null references public.units(id),
  transition_type text not null check (transition_type in ('MOVE_IN', 'MOVE_OUT')),
  status text not null default 'IN_PROGRESS',
  checklist jsonb not null default '{}',
  notes text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
```

**Move-in checklist items:** KYC uploaded, keys issued, parking assigned, welcome notice sent.  
**Move-out:** dues cleared (query open invoices), vehicles deallocated, NOC generated (PDF), keys returned.

Integrate: document vault (4.3), billing balance check.

---

### Sprint 4.3 — Document vault per flat

#### Schema (`supabase_unit_documents.sql`)

```sql
create table if not exists public.unit_documents (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  unit_id uuid not null references public.units(id) on delete cascade,
  doc_type text not null check (doc_type in ('SALE_DEED', 'RENTAL_AGREEMENT', 'ID', 'NOC', 'OTHER')),
  title text not null,
  file_path text not null,
  expires_at date,
  uploaded_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

- Storage bucket: `unit-documents` (RLS by apartment + unit).
- UI: Unit detail tab **Documents**; upload/list/download/delete.

---

### Sprint 4.4 — Asset register

#### Schema (`supabase_society_assets.sql`)

```sql
create table if not exists public.society_assets (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  name text not null,
  asset_type text not null,
  location text,
  vendor_id uuid references public.expense_vendors(id),
  amc_end_date date,
  last_service_date date,
  next_service_due date,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.asset_service_log (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.society_assets(id) on delete cascade,
  service_date date not null,
  description text,
  expense_transaction_id uuid references public.transactions(id),
  created_at timestamptz not null default now()
);
```

- UI: Admin → Assets; alerts for AMC expiring in 30 days.

---

### Sprint 4.5 — Amenity booking

#### Schema (`supabase_amenity_bookings.sql`)

```sql
create table if not exists public.amenities (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  name text not null,
  slot_duration_minutes int not null default 60,
  max_hours_per_month int,
  fee_amount numeric(12, 2) default 0,
  is_active boolean not null default true
);

create table if not exists public.amenity_bookings (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  amenity_id uuid not null references public.amenities(id),
  unit_id uuid not null references public.units(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'CONFIRMED' check (status in ('CONFIRMED', 'CANCELLED')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

- UI: calendar view; portal booking; optional fee → invoice line on next bill.

---

### Sprint 4.6 — Visitor / delivery log

#### Schema (`supabase_visitor_log.sql`)

```sql
create table if not exists public.visitor_log (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  unit_id uuid references public.units(id),
  visitor_name text not null,
  visitor_phone text,
  vehicle_reg text,
  purpose text not null check (purpose in ('GUEST', 'DELIVERY', 'SERVICE', 'OTHER')),
  entry_at timestamptz not null default now(),
  exit_at timestamptz,
  logged_by uuid references auth.users(id),
  notes text
);
```

- UI: Property → Visitor Log (security role); quick delivery preset.

---

### Sprint 4.7 — Staff attendance & payroll

#### Schema (`supabase_staff_payroll.sql`)

```sql
create table if not exists public.staff_attendance (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  staff_id uuid not null references public.staff_members(id) on delete cascade,
  work_date date not null,
  status text not null check (status in ('PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE')),
  unique (staff_id, work_date)
);

create table if not exists public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  period_label text not null,
  total_amount numeric(12, 2),
  transaction_id uuid references public.transactions(id),
  created_at timestamptz not null default now()
);
```

- UI: Admin → Staff → attendance grid; generate payroll → draft expense txn.

---

## Phase 5 — Parking depth

**Goal:** Visitor parking and violation fines integrated with billing.  
**Estimated effort:** 4–6 weeks

### Sprint 5.1 — Visitor parking passes

#### Schema (`supabase_visitor_parking.sql`)

```sql
create table if not exists public.visitor_parking_passes (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  unit_id uuid not null references public.units(id),
  host_resident_id uuid references public.residents(id),
  vehicle_reg text not null,
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'EXPIRED', 'REVOKED')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

- Separate from EH/BH pools; security creates/revokes.
- Registry: "Active visitor passes" panel; link from visitor log.

---

### Sprint 5.2 — Parking violation fines

#### Schema (`supabase_parking_violations.sql`)

```sql
create table if not exists public.parking_fine_rules (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  name text not null,
  flat_amount numeric(12, 2) not null,
  is_active boolean not null default true
);

create table if not exists public.parking_violations (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  unit_id uuid not null references public.units(id),
  rule_id uuid references public.parking_fine_rules(id),
  violation_date date not null,
  description text,
  amount numeric(12, 2) not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'INVOICED', 'WAIVED')),
  invoice_line_id uuid references public.maintenance_invoice_lines(id),
  created_at timestamptz not null default now()
);
```

- Apply to next open invoice or new line (pattern from `applyPenaltiesToOverdue`).
- Audit log entry on create/waive.

---

## Phase 6 — Future (out of scope for initial build)

- Multi-society portfolio rollup
- Full double-entry GL
- Native mobile apps
- IoT / lift integrations
- Server-side email (Resend/SendGrid) — **recommended before Phase 3 bulk notices**

---

## Dependency graph

```
Phase 1.3 Unified residents ──┬──► Phase 1.2 Reminders (email)
                              ├──► Phase 3.1 Resident portal
                              └──► Phase 3.2 Payments

Phase 2.3 RBAC v2 ────────────┬──► Phase 3.1 Resident portal
                              └──► Phase 2.1 Audit trail (actor)

Phase 1.1 Batch history ──────► Phase 1.2 (context for reminders)

Phase 2.1 Audit trail ────────► Phase 2.2 Bank recon (match events)

Phase 3.1 Portal ─────────────┬──► Phase 3.3 Notices
                              ├──► Phase 4.1 Helpdesk
                              └──► Phase 3.2 Payments

Phase 4.3 Document vault ─────► Phase 4.2 Move-in/out

Phase 4.6 Visitor log ────────► Phase 5.1 Visitor parking

Phase 1.2 Penalties engine ───► Phase 5.2 Violation fines (same apply pattern)
```

---

## Agent implementation checklist (every sprint)

- [ ] Create `supabase_<feature>.sql` with RLS policies matching existing maintenance/billing patterns
- [ ] Update `src/store.js` `pullState()` if new tables needed in UI
- [ ] Add module in `src/<feature>.js`
- [ ] Add HTML views/modals in `index.html`
- [ ] Add styles in `src/style.css` (match existing modal/card patterns)
- [ ] Wire route in `main.js` + `navigation.js` if new page
- [ ] Export `init*` function called from `main.js` boot
- [ ] Run `npm run build` — must pass
- [ ] Document SQL file name in sprint section for user to run in Supabase

---

## Recommended build order for Cursor agent

| Order | Sprint ID | Name |
|-------|-----------|------|
| 1 | 1.1 | Billing batch history |
| 2 | 1.3 | Unified residents |
| 3 | 1.2 | Dues aging & reminders |
| 4 | 1.4 | Block dashboards |
| 5 | 2.3 | RBAC v2 UI |
| 6 | 2.1 | Activity audit trail |
| 7 | 2.2 | Bank reconciliation |
| 8 | 3.1 | Resident portal |
| 9 | 3.2 | Online payments |
| 10 | 3.3 | Notices & circulars |
| 11 | 4.1–4.7 | Operations modules (order flexible) |
| 12 | 5.1–5.2 | Parking extensions |

> **Note:** Sprint 1.3 before 1.2 ensures reminder emails use unified resident data.

---

## Reference — existing SQL migration order (for new environments)

1. `supabase_rbac.sql` or `supabase_rbac_v2.sql`
2. `supabase_rls_operational.sql`
3. `supabase_units_directory.sql`
4. `supabase_maintenance_billing.sql`
5. `supabase_maintenance_billing_v2.sql`
6. `supabase_maintenance_billing_extra_pool.sql`
7. `supabase_maintenance_penalty_rules.sql`
8. `supabase_maintenance_billing_groups.sql`
9. `supabase_expense_references.sql`
10. `supabase_transactions_extras.sql`
11. `supabase_admin_reference.sql`
12. Phase sprint SQL files (this document)

---

*Last updated: generated for CommunityHub phased rollout. Start with Phase 1 Sprint 1.1 when implementing.*
