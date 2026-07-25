-- Per-society role → module and CRUD access.
-- Run in Supabase SQL Editor after supabase_page_access.sql / supabase_module_access.sql

create table if not exists public.society_role_module_access (
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  role_key text not null references public.roles(key) on delete cascade,
  module_key text not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (apartment_id, role_key, module_key)
);

create table if not exists public.society_role_crud_access (
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  role_key text not null references public.roles(key) on delete cascade,
  resource_key text not null,
  can_create boolean not null default false,
  can_read boolean not null default false,
  can_update boolean not null default false,
  can_delete boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (apartment_id, role_key, resource_key)
);

create index if not exists idx_society_role_module_access_apt_role
  on public.society_role_module_access (apartment_id, role_key);
create index if not exists idx_society_role_crud_access_apt_role
  on public.society_role_crud_access (apartment_id, role_key);

comment on table public.society_role_module_access is
  'Per-society role → module on/off. Missing row = infer from page/permission defaults.';
comment on table public.society_role_crud_access is
  'Per-society role → CRUD on a resource domain (vehicle_registry, accounts, …).';

alter table public.society_role_module_access enable row level security;
alter table public.society_role_crud_access enable row level security;

-- society_role_module_access
drop policy if exists "society_role_module_access read" on public.society_role_module_access;
create policy "society_role_module_access read"
on public.society_role_module_access for select
using (
  public.can_access_apartment(apartment_id)
  and (
    public.effective_apartment_permission(apartment_id, 'rbac.view')
    or public.effective_apartment_permission(apartment_id, 'rbac.edit')
    or public.is_admin()
  )
);

drop policy if exists "society_role_module_access insert" on public.society_role_module_access;
drop policy if exists "society_role_module_access update" on public.society_role_module_access;
drop policy if exists "society_role_module_access delete" on public.society_role_module_access;
create policy "society_role_module_access insert"
on public.society_role_module_access for insert
with check (
  public.is_admin()
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
);
create policy "society_role_module_access update"
on public.society_role_module_access for update
using (
  public.is_admin()
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
)
with check (
  public.is_admin()
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
);
create policy "society_role_module_access delete"
on public.society_role_module_access for delete
using (
  public.is_admin()
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
);

-- society_role_crud_access
drop policy if exists "society_role_crud_access read" on public.society_role_crud_access;
create policy "society_role_crud_access read"
on public.society_role_crud_access for select
using (
  public.can_access_apartment(apartment_id)
  and (
    public.effective_apartment_permission(apartment_id, 'rbac.view')
    or public.effective_apartment_permission(apartment_id, 'rbac.edit')
    or public.is_admin()
  )
);

drop policy if exists "society_role_crud_access insert" on public.society_role_crud_access;
drop policy if exists "society_role_crud_access update" on public.society_role_crud_access;
drop policy if exists "society_role_crud_access delete" on public.society_role_crud_access;
create policy "society_role_crud_access insert"
on public.society_role_crud_access for insert
with check (
  public.is_admin()
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
);
create policy "society_role_crud_access update"
on public.society_role_crud_access for update
using (
  public.is_admin()
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
)
with check (
  public.is_admin()
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
);
create policy "society_role_crud_access delete"
on public.society_role_crud_access for delete
using (
  public.is_admin()
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
);
