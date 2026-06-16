-- Vehicle change audit log (run in Supabase SQL Editor)
-- Tracks inserts/updates/deletes for syncing deltas to external systems.
-- Standalone: does NOT require supabase_rls_operational.sql first.

create table if not exists public.vehicle_audit_log (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  vehicle_id uuid,
  unit_number text,
  plate text not null,
  action text not null check (action in ('insert', 'update', 'delete')),
  source text not null default 'ui',
  changed_at timestamptz not null default now(),
  changed_by text,
  changes jsonb not null default '[]'::jsonb,
  synced_at timestamptz
);

create index if not exists idx_vehicle_audit_log_apartment on public.vehicle_audit_log (apartment_id);
create index if not exists idx_vehicle_audit_log_changed_at on public.vehicle_audit_log (changed_at desc);
create index if not exists idx_vehicle_audit_log_pending on public.vehicle_audit_log (apartment_id, synced_at)
  where synced_at is null;

alter table public.vehicle_audit_log enable row level security;

-- Portable RLS: mapped apartment members + admins (no effective_apartment_permission required).
drop policy if exists "vehicle_audit_log read" on public.vehicle_audit_log;
create policy "vehicle_audit_log read"
on public.vehicle_audit_log for select
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = vehicle_audit_log.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "vehicle_audit_log insert" on public.vehicle_audit_log;
create policy "vehicle_audit_log insert"
on public.vehicle_audit_log for insert
with check (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = vehicle_audit_log.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "vehicle_audit_log update" on public.vehicle_audit_log;
create policy "vehicle_audit_log update"
on public.vehicle_audit_log for update
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = vehicle_audit_log.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
)
with check (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = vehicle_audit_log.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);
