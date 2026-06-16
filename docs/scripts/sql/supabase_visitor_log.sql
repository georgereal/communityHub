-- Phase 4.6 — Visitor / delivery log

create table if not exists public.visitor_log (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  unit_id uuid references public.units(id) on delete set null,
  visitor_name text not null,
  visitor_phone text,
  vehicle_reg text,
  purpose text not null check (purpose in ('GUEST', 'DELIVERY', 'SERVICE', 'OTHER')),
  entry_at timestamptz not null default now(),
  exit_at timestamptz,
  logged_by uuid references auth.users(id) on delete set null,
  notes text
);

create index if not exists idx_visitor_log_apartment on public.visitor_log (apartment_id, entry_at desc);

alter table public.visitor_log enable row level security;

drop policy if exists "visitor_log read" on public.visitor_log;
drop policy if exists "visitor_log insert" on public.visitor_log;
drop policy if exists "visitor_log update" on public.visitor_log;
drop policy if exists "visitor_log write" on public.visitor_log;

create policy "visitor_log read"
on public.visitor_log for select
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = visitor_log.apartment_id
  )
);

create policy "visitor_log insert"
on public.visitor_log for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = visitor_log.apartment_id
  )
);

create policy "visitor_log update"
on public.visitor_log for update
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = visitor_log.apartment_id
  )
);
