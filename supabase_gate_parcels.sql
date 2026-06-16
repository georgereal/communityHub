-- Phase 4.6b — Gate parcels + visitor log extensions (delivery tracking)
-- Run in Supabase SQL editor after supabase_visitor_log.sql

alter table public.visitor_log
  add column if not exists delivery_company text,
  add column if not exists package_count int not null default 0,
  add column if not exists parcel_held boolean not null default false;

create table if not exists public.gate_parcels (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  visitor_log_id uuid references public.visitor_log(id) on delete set null,
  courier_name text,
  delivery_company text,
  description text,
  package_count int not null default 1 check (package_count > 0),
  status text not null default 'AT_GATE' check (status in ('AT_GATE', 'COLLECTED', 'RETURNED')),
  received_at timestamptz not null default now(),
  collected_at timestamptz,
  collected_by_name text,
  collected_by_phone text,
  collected_by_relation text check (collected_by_relation is null or collected_by_relation in ('RESIDENT', 'STAFF', 'OTHER')),
  notes text,
  logged_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_gate_parcels_apartment_status
  on public.gate_parcels (apartment_id, status, received_at desc);

create index if not exists idx_gate_parcels_unit
  on public.gate_parcels (unit_id, status);

alter table public.gate_parcels enable row level security;

drop policy if exists "gate_parcels read" on public.gate_parcels;
drop policy if exists "gate_parcels insert" on public.gate_parcels;
drop policy if exists "gate_parcels update" on public.gate_parcels;

create policy "gate_parcels read"
on public.gate_parcels for select
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = gate_parcels.apartment_id
  )
);

create policy "gate_parcels insert"
on public.gate_parcels for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = gate_parcels.apartment_id
  )
);

create policy "gate_parcels update"
on public.gate_parcels for update
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = gate_parcels.apartment_id
  )
);
