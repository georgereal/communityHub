-- Phase 2.1 — Activity audit trail (billing, residents, roles, bank recon, reminders)
-- Standalone: does NOT require supabase_rls_operational.sql or effective_apartment_permission().
-- Read ≈ accounts.view / rbac.view (admin, accounts_manager, property_manager on mapped apartments).
-- Insert: any mapped apartment member (app enforces finer permissions).

create table if not exists public.activity_audit_log (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  entity_type text not null,
  entity_id text not null,
  action text not null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_label text,
  summary text,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_activity_audit_apartment
  on public.activity_audit_log (apartment_id, created_at desc);

create index if not exists idx_activity_audit_entity
  on public.activity_audit_log (entity_type, entity_id);

alter table public.activity_audit_log enable row level security;

drop policy if exists "activity_audit_log read" on public.activity_audit_log;
create policy "activity_audit_log read"
on public.activity_audit_log for select
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.user_id = auth.uid()
        and ua.apartment_id = activity_audit_log.apartment_id
        and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager', 'property_manager')
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "activity_audit_log insert" on public.activity_audit_log;
create policy "activity_audit_log insert"
on public.activity_audit_log for insert
with check (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = activity_audit_log.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);
