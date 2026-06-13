-- Maintenance billing v2: charge heads, invoice line items, bulk batches, unit area
-- Run in Supabase SQL Editor after supabase_maintenance_billing.sql

-- Unit area for sq-ft based charges
alter table public.units add column if not exists area_sqft numeric(10, 2) check (area_sqft is null or area_sqft >= 0);
comment on column public.units.area_sqft is 'Carpet/super built-up area in sq ft for pro-rata billing';

-- Reusable charge heads (Maintenance, Water, Sinking fund, etc.)
create table if not exists public.maintenance_charge_heads (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  name text not null,
  calc_type text not null check (calc_type in (
    'FLAT',
    'PER_SQFT',
    'PRO_RATA_AREA',
    'MANUAL',
    'PER_CAR_SLOT',
    'PER_BIKE_SLOT',
    'PER_PARKING_SLOT',
    'PER_EXTRA_CAR_ALLOCATION',
    'PER_EXTRA_BIKE_ALLOCATION'
  )),
  default_amount numeric(12, 4) not null default 0 check (default_amount >= 0),
  sort_order int not null default 0,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  unique (apartment_id, name)
);

create index if not exists idx_maintenance_charge_heads_apartment
  on public.maintenance_charge_heads (apartment_id, is_active, sort_order);

comment on table public.maintenance_charge_heads is 'Billable charge categories with calculation rules';
comment on column public.maintenance_charge_heads.calc_type is 'FLAT=fixed/flat; PER_SQFT=rate×sqft; PRO_RATA_AREA=split total by sqft; MANUAL=per-flat variable; PER_CAR_SLOT/PER_BIKE_SLOT/PER_PARKING_SLOT=base slot limits; PER_EXTRA_CAR_ALLOCATION/PER_EXTRA_BIKE_ALLOCATION=rate×extra EH/BH pool vehicles at billing time';

-- Bulk billing run metadata
create table if not exists public.maintenance_billing_batches (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  period_label text not null,
  due_date date,
  notes text,
  unit_count int not null default 0 check (unit_count >= 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_maintenance_billing_batches_apartment
  on public.maintenance_billing_batches (apartment_id, created_at desc);

alter table public.maintenance_invoices
  add column if not exists batch_id uuid references public.maintenance_billing_batches(id) on delete set null;

create index if not exists idx_maintenance_invoices_batch
  on public.maintenance_invoices (batch_id);

-- Line-item breakdown per invoice
create table if not exists public.maintenance_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  invoice_id uuid not null references public.maintenance_invoices(id) on delete cascade,
  head_id uuid references public.maintenance_charge_heads(id) on delete set null,
  head_name text not null,
  calc_type text not null,
  quantity numeric(12, 4),
  rate numeric(12, 4),
  amount numeric(12, 2) not null check (amount >= 0),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_maintenance_invoice_lines_invoice
  on public.maintenance_invoice_lines (invoice_id, sort_order);
create index if not exists idx_maintenance_invoice_lines_apartment
  on public.maintenance_invoice_lines (apartment_id);

comment on table public.maintenance_invoice_lines is 'Per-head breakdown on a flat invoice';

-- RLS helper: same apartment access as maintenance_invoices
alter table public.maintenance_charge_heads enable row level security;
alter table public.maintenance_billing_batches enable row level security;
alter table public.maintenance_invoice_lines enable row level security;

-- maintenance_charge_heads policies
drop policy if exists "maintenance_charge_heads read" on public.maintenance_charge_heads;
create policy "maintenance_charge_heads read"
on public.maintenance_charge_heads for select
using (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_charge_heads.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);

drop policy if exists "maintenance_charge_heads insert" on public.maintenance_charge_heads;
create policy "maintenance_charge_heads insert"
on public.maintenance_charge_heads for insert
with check (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_charge_heads.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);

drop policy if exists "maintenance_charge_heads update" on public.maintenance_charge_heads;
create policy "maintenance_charge_heads update"
on public.maintenance_charge_heads for update
using (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_charge_heads.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);

drop policy if exists "maintenance_charge_heads delete" on public.maintenance_charge_heads;
create policy "maintenance_charge_heads delete"
on public.maintenance_charge_heads for delete
using (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_charge_heads.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);

-- maintenance_billing_batches policies
drop policy if exists "maintenance_billing_batches read" on public.maintenance_billing_batches;
create policy "maintenance_billing_batches read"
on public.maintenance_billing_batches for select
using (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_billing_batches.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);

drop policy if exists "maintenance_billing_batches insert" on public.maintenance_billing_batches;
create policy "maintenance_billing_batches insert"
on public.maintenance_billing_batches for insert
with check (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_billing_batches.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);

drop policy if exists "maintenance_billing_batches delete" on public.maintenance_billing_batches;
create policy "maintenance_billing_batches delete"
on public.maintenance_billing_batches for delete
using (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_billing_batches.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);

-- maintenance_invoice_lines policies
drop policy if exists "maintenance_invoice_lines read" on public.maintenance_invoice_lines;
create policy "maintenance_invoice_lines read"
on public.maintenance_invoice_lines for select
using (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_invoice_lines.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);

drop policy if exists "maintenance_invoice_lines insert" on public.maintenance_invoice_lines;
create policy "maintenance_invoice_lines insert"
on public.maintenance_invoice_lines for insert
with check (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_invoice_lines.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);

drop policy if exists "maintenance_invoice_lines delete" on public.maintenance_invoice_lines;
create policy "maintenance_invoice_lines delete"
on public.maintenance_invoice_lines for delete
using (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_invoice_lines.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);
