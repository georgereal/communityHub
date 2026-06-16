-- Visitor approvals: multi-flat visits + resident sign-off at gate
-- Run after supabase_visitor_log.sql and supabase_gate_parcels.sql

alter table public.visitor_log
  add column if not exists visitor_email text,
  add column if not exists approval_status text not null default 'NOT_REQUIRED'
    check (approval_status in ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'DENIED', 'PARTIAL')),
  add column if not exists requested_at timestamptz;

comment on column public.visitor_log.approval_status is
  'PENDING until all visitor_log_units approved; APPROVED allows entry (entry_at set)';

create table if not exists public.visitor_log_units (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  visitor_log_id uuid not null references public.visitor_log(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  approval_status text not null default 'PENDING'
    check (approval_status in ('PENDING', 'APPROVED', 'DENIED')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  denied_reason text,
  created_at timestamptz not null default now(),
  unique (visitor_log_id, unit_id)
);

create index if not exists idx_visitor_log_units_apartment
  on public.visitor_log_units (apartment_id, approval_status);

create index if not exists idx_visitor_log_units_log
  on public.visitor_log_units (visitor_log_id);

alter table public.visitor_log_units enable row level security;

drop policy if exists "visitor_log_units read" on public.visitor_log_units;
drop policy if exists "visitor_log_units insert" on public.visitor_log_units;
drop policy if exists "visitor_log_units update" on public.visitor_log_units;

create policy "visitor_log_units read"
on public.visitor_log_units for select
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = visitor_log_units.apartment_id
  )
);

create policy "visitor_log_units insert"
on public.visitor_log_units for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = visitor_log_units.apartment_id
  )
);

create policy "visitor_log_units update"
on public.visitor_log_units for update
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = visitor_log_units.apartment_id
  )
);

-- Extend in-app notifications for visitor approval requests
alter table public.user_notifications
  add column if not exists visitor_log_id uuid references public.visitor_log(id) on delete cascade,
  add column if not exists visitor_unit_id uuid references public.visitor_log_units(id) on delete cascade;

create index if not exists idx_user_notifications_visitor
  on public.user_notifications (visitor_log_id)
  where visitor_log_id is not null;
