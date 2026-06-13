-- Phase 2.1 — Activity audit trail (billing, residents, roles, bank recon, reminders)

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
  public.effective_apartment_permission(apartment_id, 'accounts.view')
  or public.effective_apartment_permission(apartment_id, 'rbac.view')
);

drop policy if exists "activity_audit_log insert" on public.activity_audit_log;
create policy "activity_audit_log insert"
on public.activity_audit_log for insert
with check (
  public.effective_apartment_permission(apartment_id, 'accounts.edit')
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
  or public.effective_apartment_permission(apartment_id, 'apartment_mgmt.edit')
  or public.effective_apartment_permission(apartment_id, 'vehicle_registry.edit')
);
