-- CommunityHub RBAC v2 (scoped roles) + Apartment Management (owners/tenants)
-- Run this in Supabase SQL editor. Safe to re-run (uses IF NOT EXISTS where possible).

-- ===============
-- Identity / profile
-- ===============
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  created_at timestamptz not null default now()
);

-- Backfill email for existing users
update public.profiles p
set email = u.email
from auth.users u
where p.id = u.id and p.email is null;

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email), new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ===============
-- Apartments (tenants)
-- ===============
create table if not exists public.apartments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- ===============
-- Permissions / roles
-- ===============
create table if not exists public.permissions (
  key text primary key,
  module text not null,
  description text not null
);

create table if not exists public.roles (
  key text primary key,
  scope text not null check (scope in ('system','apartment')),
  label text not null,
  description text not null
);

create table if not exists public.role_permissions (
  role_key text references public.roles(key) on delete cascade,
  permission_key text references public.permissions(key) on delete cascade,
  primary key (role_key, permission_key)
);

-- v2 assignment table (supports true SaaS scope)
create table if not exists public.user_role_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  role_key text not null references public.roles(key) on delete cascade,
  scope text not null check (scope in ('system','apartment')),
  apartment_id uuid references public.apartments(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, role_key, scope, apartment_id)
);

-- Enforce: system scope has NULL apartment_id; apartment scope requires apartment_id
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_role_assignments_scope_check'
      and conrelid = 'public.user_role_assignments'::regclass
  ) then
    alter table public.user_role_assignments
      add constraint user_role_assignments_scope_check check (
        (scope = 'system' and apartment_id is null)
        or (scope = 'apartment' and apartment_id is not null)
      );
  end if;
exception when undefined_table then
  null;
end $$;

-- Migration helpers for existing installs (RBAC v1 -> v2)
-- If tables already exist, add missing columns instead of failing.
alter table public.roles add column if not exists scope text;
alter table public.roles add column if not exists label text;
alter table public.roles add column if not exists description text;
update public.roles set scope = coalesce(scope, 'apartment') where scope is null;

-- Migrate from legacy user_roles (if present) into user_role_assignments, then drop legacy.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'user_roles'
  ) then
    -- Ensure legacy columns exist for consistent select
    begin
      alter table public.user_roles add column if not exists scope text;
    exception when others then null; end;
    begin
      alter table public.user_roles add column if not exists apartment_id uuid;
    exception when others then null; end;

    insert into public.user_role_assignments (user_id, role_key, scope, apartment_id)
    select ur.user_id, ur.role_key, coalesce(ur.scope, 'apartment'), ur.apartment_id
    from public.user_roles ur
    on conflict do nothing;

    -- Drop legacy table and any dependent policies/functions referencing it.
    -- This is safe because this script re-creates the correct policies/functions later.
    drop table public.user_roles cascade;
  end if;
end $$;

do $$
begin
  -- Add/ensure check constraint for roles.scope
  if not exists (
    select 1 from pg_constraint
    where conname = 'roles_scope_check' and conrelid = 'public.roles'::regclass
  ) then
    alter table public.roles
      add constraint roles_scope_check check (scope in ('system','apartment'));
  end if;

  -- Add/ensure check constraint for user_roles.scope
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_roles_scope_check' and conrelid = 'public.user_roles'::regclass
  ) then
    alter table public.user_roles
      add constraint user_roles_scope_check check (scope in ('system','apartment'));
  end if;
exception when undefined_table then
  -- ignore if tables don't exist yet (first-time install)
  null;
end $$;

-- Seed permissions for current modules
insert into public.permissions (key, module, description) values
  ('vehicle_registry.view','vehicle_registry','View vehicle registry'),
  ('vehicle_registry.edit','vehicle_registry','Edit vehicle registry (allocations, import, etc)'),
  ('accounts.view','accounts','View accounts/ledger'),
  ('accounts.edit','accounts','Create/edit transactions'),
  ('setup.view','setup','View setup'),
  ('setup.edit','setup','Edit setup (policies)'),
  ('rbac.view','rbac','View access control mappings'),
  ('rbac.edit','rbac','Edit roles/permissions/mappings'),
  ('apartment_mgmt.view','apartment_mgmt','View apartment management (owners/tenants)'),
  ('apartment_mgmt.edit','apartment_mgmt','Edit apartment management (owners/tenants)'),
  ('system.apartments.manage','system','Create/edit apartments'),
  ('system.users.manage','system','Manage users globally')
on conflict (key) do nothing;

-- Seed roles
insert into public.roles (key, scope, label, description) values
  ('system_admin','system','System Administrator','Full platform access across all apartments'),
  ('apartment_admin','apartment','Apartment Administrator','Admin for a specific apartment'),
  ('property_manager','apartment','Property Manager','Vehicle registry + setup operations'),
  ('accounts_manager','apartment','Accounts Manager','Accounts and reports operations'),
  ('security','apartment','Security','Vehicle registry operations'),
  ('resident_viewer','apartment','Resident Viewer','Read-only for assigned apartment')
on conflict (key) do nothing;

-- Role -> permissions mapping (edit as needed)
-- System admin: everything
insert into public.role_permissions (role_key, permission_key)
select 'system_admin', p.key from public.permissions p
on conflict do nothing;

-- Apartment admin: everything except system-level global management
insert into public.role_permissions (role_key, permission_key) values
  ('apartment_admin','vehicle_registry.view'),
  ('apartment_admin','vehicle_registry.edit'),
  ('apartment_admin','accounts.view'),
  ('apartment_admin','accounts.edit'),
  ('apartment_admin','setup.view'),
  ('apartment_admin','setup.edit'),
  ('apartment_admin','rbac.view'),
  ('apartment_admin','rbac.edit'),
  ('apartment_admin','apartment_mgmt.view'),
  ('apartment_admin','apartment_mgmt.edit')
on conflict do nothing;

insert into public.role_permissions (role_key, permission_key) values
  ('property_manager','vehicle_registry.view'),
  ('property_manager','vehicle_registry.edit'),
  ('property_manager','apartment_mgmt.view'),
  ('property_manager','apartment_mgmt.edit'),
  ('accounts_manager','accounts.view'),
  ('accounts_manager','accounts.edit'),
  ('accounts_manager','apartment_mgmt.view'),
  ('security','vehicle_registry.view'),
  ('security','vehicle_registry.edit'),
  ('resident_viewer','vehicle_registry.view'),
  ('resident_viewer','accounts.view'),
  ('resident_viewer','apartment_mgmt.view')
on conflict do nothing;

-- ===============
-- Apartment Management data: residents (owners/tenants)
-- ===============
create table if not exists public.residents (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  unit_number text not null,
  kind text not null check (kind in ('OWNER','TENANT')),
  full_name text not null,
  phone text,
  email text,
  notes text,
  created_at timestamptz not null default now()
);

-- ===============
-- RLS
-- ===============
alter table public.profiles enable row level security;
alter table public.apartments enable row level security;
alter table public.permissions enable row level security;
alter table public.roles enable row level security;
alter table public.role_permissions enable row level security;
alter table public.user_role_assignments enable row level security;
alter table public.residents enable row level security;

-- Helpers
create or replace function public.has_system_role(r text)
returns boolean as $$
  select exists(
    select 1 from public.user_role_assignments ura
    where ura.user_id = auth.uid()
      and ura.scope = 'system'
      and ura.role_key = r
  );
$$ language sql stable;

create or replace function public.has_apartment_permission(aid uuid, perm text)
returns boolean as $$
  select exists(
    select 1
    from public.user_role_assignments ura
    join public.role_permissions rp on rp.role_key = ura.role_key
    where ura.user_id = auth.uid()
      and ura.scope = 'apartment'
      and ura.apartment_id = aid
      and rp.permission_key = perm
  ) or public.has_system_role('system_admin');
$$ language sql stable;

-- PROFILES: self-read; system admin can read all
drop policy if exists "profiles self read" on public.profiles;
create policy "profiles self read"
on public.profiles for select
using (id = auth.uid() or public.has_system_role('system_admin'));

drop policy if exists "profiles system admin update" on public.profiles;
create policy "profiles system admin update"
on public.profiles for update
using (public.has_system_role('system_admin'))
with check (public.has_system_role('system_admin'));

-- APARTMENTS: system admin sees all; apartment roles see only assigned apartments
drop policy if exists "apartments scoped read" on public.apartments;
create policy "apartments scoped read"
on public.apartments for select
using (
  public.has_system_role('system_admin')
  or exists(select 1 from public.user_role_assignments ura where ura.user_id = auth.uid() and ura.scope = 'apartment' and ura.apartment_id = apartments.id)
);

drop policy if exists "apartments system manage" on public.apartments;
create policy "apartments system manage"
on public.apartments for all
using (public.has_system_role('system_admin'))
with check (public.has_system_role('system_admin'));

-- RBAC catalog tables: system admin only (read/write)
drop policy if exists "rbac catalog read" on public.permissions;
create policy "rbac catalog read"
on public.permissions for select
using (public.has_system_role('system_admin'));

drop policy if exists "rbac catalog manage" on public.permissions;
create policy "rbac catalog manage"
on public.permissions for all
using (public.has_system_role('system_admin'))
with check (public.has_system_role('system_admin'));

drop policy if exists "roles read" on public.roles;
create policy "roles read"
on public.roles for select
using (public.has_system_role('system_admin'));

drop policy if exists "roles manage" on public.roles;
create policy "roles manage"
on public.roles for all
using (public.has_system_role('system_admin'))
with check (public.has_system_role('system_admin'));

drop policy if exists "role_permissions read" on public.role_permissions;
create policy "role_permissions read"
on public.role_permissions for select
using (public.has_system_role('system_admin'));

drop policy if exists "role_permissions manage" on public.role_permissions;
create policy "role_permissions manage"
on public.role_permissions for all
using (public.has_system_role('system_admin'))
with check (public.has_system_role('system_admin'));

-- user_roles: system admin can assign; apartment admin can assign within their apartment
drop policy if exists "user_role_assignments read own" on public.user_role_assignments;
create policy "user_role_assignments read own"
on public.user_role_assignments for select
using (user_id = auth.uid() or public.has_system_role('system_admin'));

drop policy if exists "user_role_assignments system manage" on public.user_role_assignments;
create policy "user_role_assignments system manage"
on public.user_role_assignments for all
using (public.has_system_role('system_admin'))
with check (public.has_system_role('system_admin'));

-- Residents: scoped to apartment permission
drop policy if exists "residents scoped read" on public.residents;
create policy "residents scoped read"
on public.residents for select
using (public.has_apartment_permission(apartment_id, 'apartment_mgmt.view'));

drop policy if exists "residents scoped manage" on public.residents;
create policy "residents scoped manage"
on public.residents for insert
with check (public.has_apartment_permission(apartment_id, 'apartment_mgmt.edit'));

drop policy if exists "residents scoped update" on public.residents;
create policy "residents scoped update"
on public.residents for update
using (public.has_apartment_permission(apartment_id, 'apartment_mgmt.edit'))
with check (public.has_apartment_permission(apartment_id, 'apartment_mgmt.edit'));

drop policy if exists "residents scoped delete" on public.residents;
create policy "residents scoped delete"
on public.residents for delete
using (public.has_apartment_permission(apartment_id, 'apartment_mgmt.edit'));

-- Bootstrap: first system admin self-promote if none exists yet
create or replace function public.no_system_admin_exists()
returns boolean as $$
  select not exists(
    select 1 from public.user_role_assignments ura
    where ura.scope = 'system' and ura.role_key = 'system_admin'
  );
$$ language sql stable;

drop policy if exists "bootstrap first system admin" on public.user_role_assignments;
create policy "bootstrap first system admin"
on public.user_role_assignments for insert
with check (
  user_id = auth.uid()
  and scope = 'system'
  and role_key = 'system_admin'
  and public.no_system_admin_exists()
);

