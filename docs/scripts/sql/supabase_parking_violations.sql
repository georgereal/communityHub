-- Phase 5.2 — Parking violation fines

create table if not exists public.parking_fine_rules (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  name text not null,
  flat_amount numeric(12, 2) not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.parking_violations (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  rule_id uuid references public.parking_fine_rules(id) on delete set null,
  violation_date date not null,
  description text,
  amount numeric(12, 2) not null,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'INVOICED', 'WAIVED')),
  invoice_line_id uuid references public.maintenance_invoice_lines(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_parking_violations_apartment
  on public.parking_violations (apartment_id, violation_date desc);

alter table public.parking_fine_rules enable row level security;
alter table public.parking_violations enable row level security;

drop policy if exists "parking_fine_rules read" on public.parking_fine_rules;
drop policy if exists "parking_fine_rules insert" on public.parking_fine_rules;
drop policy if exists "parking_fine_rules update" on public.parking_fine_rules;
drop policy if exists "parking_fine_rules write" on public.parking_fine_rules;

create policy "parking_fine_rules read"
on public.parking_fine_rules for select
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = parking_fine_rules.apartment_id
  )
);

create policy "parking_fine_rules insert"
on public.parking_fine_rules for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = parking_fine_rules.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager', 'accounts_manager')
  )
);

create policy "parking_fine_rules update"
on public.parking_fine_rules for update
using (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = parking_fine_rules.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager', 'accounts_manager')
  )
);

drop policy if exists "parking_violations read" on public.parking_violations;
drop policy if exists "parking_violations insert" on public.parking_violations;
drop policy if exists "parking_violations update" on public.parking_violations;
drop policy if exists "parking_violations write" on public.parking_violations;

create policy "parking_violations read"
on public.parking_violations for select
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = parking_violations.apartment_id
  )
);

create policy "parking_violations insert"
on public.parking_violations for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = parking_violations.apartment_id
  )
);

create policy "parking_violations update"
on public.parking_violations for update
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = parking_violations.apartment_id
  )
);
