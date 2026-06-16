-- Phase 5.1 — Visitor parking passes

create table if not exists public.visitor_parking_passes (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  host_resident_id uuid references public.residents(id) on delete set null,
  vehicle_reg text not null,
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'EXPIRED', 'REVOKED')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_visitor_parking_passes_apartment
  on public.visitor_parking_passes (apartment_id, valid_until desc);

alter table public.visitor_parking_passes enable row level security;

drop policy if exists "visitor_parking_passes read" on public.visitor_parking_passes;
drop policy if exists "visitor_parking_passes insert" on public.visitor_parking_passes;
drop policy if exists "visitor_parking_passes update" on public.visitor_parking_passes;
drop policy if exists "visitor_parking_passes write" on public.visitor_parking_passes;

create policy "visitor_parking_passes read"
on public.visitor_parking_passes for select
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = visitor_parking_passes.apartment_id
  )
);

create policy "visitor_parking_passes insert"
on public.visitor_parking_passes for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = visitor_parking_passes.apartment_id
  )
);

create policy "visitor_parking_passes update"
on public.visitor_parking_passes for update
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = visitor_parking_passes.apartment_id
  )
);
