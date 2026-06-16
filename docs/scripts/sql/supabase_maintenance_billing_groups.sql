-- Combined invoicing: billing groups (multi-flat owners / caretakers)
-- Run in Supabase SQL Editor after supabase_maintenance_billing_v2.sql

create table if not exists public.maintenance_billing_groups (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  name text not null,
  contact_name text,
  notes text,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (apartment_id, name)
);

create index if not exists idx_maintenance_billing_groups_apartment
  on public.maintenance_billing_groups (apartment_id, is_active, sort_order);

comment on table public.maintenance_billing_groups is 'Pre-defined flat groups for combined invoices (e.g. one owner with multiple units)';

create table if not exists public.maintenance_billing_group_units (
  group_id uuid not null references public.maintenance_billing_groups(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  apartment_id uuid not null,
  primary key (group_id, unit_id),
  unique (apartment_id, unit_id)
);

create index if not exists idx_maintenance_billing_group_units_group
  on public.maintenance_billing_group_units (group_id);

comment on table public.maintenance_billing_group_units is 'Flats in a billing group; each flat may belong to at most one group per apartment';

-- Combined invoice support
alter table public.maintenance_invoices
  add column if not exists billing_group_id uuid references public.maintenance_billing_groups(id) on delete set null;

alter table public.maintenance_invoices
  alter column unit_id drop not null;

alter table public.maintenance_invoices
  drop constraint if exists maintenance_invoices_unit_or_group_check;
alter table public.maintenance_invoices
  add constraint maintenance_invoices_unit_or_group_check
  check (unit_id is not null or billing_group_id is not null);

alter table public.maintenance_invoices
  drop constraint if exists maintenance_invoices_apartment_id_unit_id_period_label_key;

create unique index if not exists idx_maintenance_invoices_unit_period
  on public.maintenance_invoices (apartment_id, unit_id, period_label)
  where billing_group_id is null and unit_id is not null;

create unique index if not exists idx_maintenance_invoices_group_period
  on public.maintenance_invoices (apartment_id, billing_group_id, period_label)
  where billing_group_id is not null;

create index if not exists idx_maintenance_invoices_billing_group
  on public.maintenance_invoices (billing_group_id)
  where billing_group_id is not null;

comment on column public.maintenance_invoices.billing_group_id is 'When set, invoice covers all flats in the group; unit_id may be null or a primary flat';

alter table public.maintenance_invoice_lines
  add column if not exists unit_id uuid references public.units(id) on delete set null;

comment on column public.maintenance_invoice_lines.unit_id is 'Flat this line belongs to (used on combined group invoices)';

-- RLS
alter table public.maintenance_billing_groups enable row level security;
alter table public.maintenance_billing_group_units enable row level security;

drop policy if exists "maintenance_billing_groups read" on public.maintenance_billing_groups;
create policy "maintenance_billing_groups read"
on public.maintenance_billing_groups for select
using (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_billing_groups.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);

drop policy if exists "maintenance_billing_groups insert" on public.maintenance_billing_groups;
create policy "maintenance_billing_groups insert"
on public.maintenance_billing_groups for insert
with check (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_billing_groups.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);

drop policy if exists "maintenance_billing_groups update" on public.maintenance_billing_groups;
create policy "maintenance_billing_groups update"
on public.maintenance_billing_groups for update
using (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_billing_groups.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);

drop policy if exists "maintenance_billing_groups delete" on public.maintenance_billing_groups;
create policy "maintenance_billing_groups delete"
on public.maintenance_billing_groups for delete
using (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_billing_groups.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);

drop policy if exists "maintenance_billing_group_units read" on public.maintenance_billing_group_units;
create policy "maintenance_billing_group_units read"
on public.maintenance_billing_group_units for select
using (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_billing_group_units.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);

drop policy if exists "maintenance_billing_group_units insert" on public.maintenance_billing_group_units;
create policy "maintenance_billing_group_units insert"
on public.maintenance_billing_group_units for insert
with check (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_billing_group_units.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);

drop policy if exists "maintenance_billing_group_units delete" on public.maintenance_billing_group_units;
create policy "maintenance_billing_group_units delete"
on public.maintenance_billing_group_units for delete
using (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_billing_group_units.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);
