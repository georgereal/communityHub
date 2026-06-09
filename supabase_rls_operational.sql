-- Enable Row Level Security on all app tables (fixes Supabase "rls_disabled_in_public")
-- Run in Supabase SQL Editor for project irslryoaxybztcrquzpu.
-- Safe to re-run (uses IF EXISTS / OR REPLACE).

-- ============================================================
-- Helper functions (bridge v1 profiles.role + v2 RBAC)
-- ============================================================

create or replace function public.no_admin_exists()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists(select 1 from public.profiles p where p.role = 'admin');
$$;

create or replace function public.no_system_admin_exists()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists(
    select 1 from public.user_role_assignments ura
    where ura.scope = 'system' and ura.role_key = 'system_admin'
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  );
$$;

create or replace function public.has_system_role(r text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.user_role_assignments ura
    where ura.user_id = auth.uid()
      and ura.scope = 'system'
      and ura.role_key = r
  );
$$;

create or replace function public.can_access_apartment(aid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and (
      public.has_system_role('system_admin')
      or public.is_admin()
      or exists (
        select 1 from public.user_apartments ua
        where ua.user_id = auth.uid() and ua.apartment_id = aid
      )
      or exists (
        select 1 from public.user_role_assignments ura
        where ura.user_id = auth.uid()
          and ura.scope = 'apartment'
          and ura.apartment_id = aid
      )
    );
$$;

-- v2 permission check (from supabase_rbac_v2.sql)
create or replace function public.has_apartment_permission(aid uuid, perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1
    from public.user_role_assignments ura
    join public.role_permissions rp on rp.role_key = ura.role_key
    where ura.user_id = auth.uid()
      and ura.scope = 'apartment'
      and ura.apartment_id = aid
      and rp.permission_key = perm
  ) or public.has_system_role('system_admin');
$$;

-- v1 role fallback when profiles.role is used instead of user_role_assignments
create or replace function public.v1_role_has_perm(role text, perm text)
returns boolean
language sql
immutable
as $$
  select case coalesce(role, 'resident_viewer')
    when 'admin' then true
    when 'property_manager' then perm in (
      'vehicle_registry.view', 'vehicle_registry.edit',
      'setup.view', 'setup.edit', 'apartment_mgmt.view'
    )
    when 'accounts_manager' then perm in (
      'accounts.view', 'accounts.edit', 'apartment_mgmt.view'
    )
    when 'security' then perm in (
      'vehicle_registry.view', 'vehicle_registry.edit'
    )
    when 'resident_viewer' then perm in (
      'vehicle_registry.view', 'accounts.view', 'apartment_mgmt.view'
    )
    else false
  end;
$$;

create or replace function public.effective_apartment_permission(aid uuid, perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.can_access_apartment(aid)
    and (
      public.has_system_role('system_admin')
      or (public.is_admin() and public.can_access_apartment(aid))
      or public.has_apartment_permission(aid, perm)
      or (
        exists (
          select 1 from public.user_apartments ua
          where ua.user_id = auth.uid() and ua.apartment_id = aid
        )
        and public.v1_role_has_perm(
          (select p.role from public.profiles p where p.id = auth.uid()),
          perm
        )
      )
    );
$$;

-- ============================================================
-- Enable RLS on every public table used by the app
-- ============================================================

alter table if exists public.profiles enable row level security;
alter table if exists public.apartments enable row level security;
alter table if exists public.user_apartments enable row level security;
alter table if exists public.roles enable row level security;
alter table if exists public.permissions enable row level security;
alter table if exists public.role_permissions enable row level security;
alter table if exists public.user_role_assignments enable row level security;
alter table if exists public.residents enable row level security;
alter table if exists public.units enable row level security;
alter table if exists public.vehicles enable row level security;
alter table if exists public.transactions enable row level security;
alter table if exists public.parking_slots enable row level security;
alter table if exists public.society_config enable row level security;

-- ============================================================
-- PROFILES
-- ============================================================

drop policy if exists "read own profile" on public.profiles;
drop policy if exists "profiles self read" on public.profiles;
create policy "profiles read"
on public.profiles for select
using (
  id = auth.uid()
  or public.is_admin()
  or public.has_system_role('system_admin')
);

drop policy if exists "admin update profiles" on public.profiles;
drop policy if exists "profiles system admin update" on public.profiles;
create policy "profiles admin update"
on public.profiles for update
using (public.is_admin() or public.has_system_role('system_admin'))
with check (public.is_admin() or public.has_system_role('system_admin'));

drop policy if exists "profiles self update" on public.profiles;
create policy "profiles self update"
on public.profiles for update
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists "bootstrap first admin" on public.profiles;
create policy "bootstrap first admin"
on public.profiles for update
using (id = auth.uid() and public.no_admin_exists())
with check (id = auth.uid() and role = 'admin' and public.no_admin_exists());

-- ============================================================
-- APARTMENTS
-- ============================================================

drop policy if exists "read mapped apartments" on public.apartments;
drop policy if exists "apartments scoped read" on public.apartments;
create policy "apartments read"
on public.apartments for select
using (public.can_access_apartment(id));

drop policy if exists "admin manage apartments" on public.apartments;
drop policy if exists "apartments system manage" on public.apartments;
create policy "apartments manage"
on public.apartments for all
using (public.is_admin() or public.has_system_role('system_admin'))
with check (public.is_admin() or public.has_system_role('system_admin'));

-- ============================================================
-- USER_APARTMENTS
-- ============================================================

drop policy if exists "read own mappings" on public.user_apartments;
create policy "user_apartments read"
on public.user_apartments for select
using (
  user_id = auth.uid()
  or public.is_admin()
  or public.has_system_role('system_admin')
);

drop policy if exists "admin manage mappings" on public.user_apartments;
create policy "user_apartments manage"
on public.user_apartments for all
using (public.is_admin() or public.has_system_role('system_admin'))
with check (public.is_admin() or public.has_system_role('system_admin'));

-- ============================================================
-- RBAC catalog (roles, permissions, role_permissions, assignments)
-- ============================================================

drop policy if exists "roles read" on public.roles;
create policy "roles read"
on public.roles for select
using (auth.uid() is not null);

drop policy if exists "roles manage" on public.roles;
create policy "roles manage"
on public.roles for all
using (public.has_system_role('system_admin'))
with check (public.has_system_role('system_admin'));

drop policy if exists "rbac catalog read" on public.permissions;
create policy "permissions read"
on public.permissions for select
using (auth.uid() is not null);

drop policy if exists "rbac catalog manage" on public.permissions;
create policy "permissions manage"
on public.permissions for all
using (public.has_system_role('system_admin'))
with check (public.has_system_role('system_admin'));

drop policy if exists "role_permissions read" on public.role_permissions;
drop policy if exists "role_permissions authenticated read" on public.role_permissions;
create policy "role_permissions read"
on public.role_permissions for select
using (auth.uid() is not null);

drop policy if exists "role_permissions manage" on public.role_permissions;
create policy "role_permissions manage"
on public.role_permissions for all
using (public.has_system_role('system_admin'))
with check (public.has_system_role('system_admin'));

drop policy if exists "user_role_assignments read own" on public.user_role_assignments;
create policy "user_role_assignments read"
on public.user_role_assignments for select
using (
  user_id = auth.uid()
  or public.has_system_role('system_admin')
  or public.is_admin()
);

drop policy if exists "user_role_assignments system manage" on public.user_role_assignments;
create policy "user_role_assignments manage"
on public.user_role_assignments for all
using (public.has_system_role('system_admin') or public.is_admin())
with check (public.has_system_role('system_admin') or public.is_admin());

drop policy if exists "bootstrap first system admin" on public.user_role_assignments;
create policy "bootstrap first system admin"
on public.user_role_assignments for insert
with check (
  user_id = auth.uid()
  and scope = 'system'
  and role_key = 'system_admin'
  and public.no_system_admin_exists()
);

-- ============================================================
-- RESIDENTS
-- ============================================================

drop policy if exists "residents scoped read" on public.residents;
create policy "residents read"
on public.residents for select
using (public.effective_apartment_permission(apartment_id, 'apartment_mgmt.view'));

drop policy if exists "residents scoped manage" on public.residents;
drop policy if exists "residents scoped update" on public.residents;
drop policy if exists "residents scoped delete" on public.residents;
create policy "residents insert"
on public.residents for insert
with check (public.effective_apartment_permission(apartment_id, 'apartment_mgmt.edit'));

create policy "residents update"
on public.residents for update
using (public.effective_apartment_permission(apartment_id, 'apartment_mgmt.edit'))
with check (public.effective_apartment_permission(apartment_id, 'apartment_mgmt.edit'));

create policy "residents delete"
on public.residents for delete
using (public.effective_apartment_permission(apartment_id, 'apartment_mgmt.edit'));

-- ============================================================
-- OPERATIONAL DATA (likely the tables Supabase flagged)
-- ============================================================

-- units
drop policy if exists "units read" on public.units;
create policy "units read"
on public.units for select
using (public.effective_apartment_permission(apartment_id, 'vehicle_registry.view'));

drop policy if exists "units write" on public.units;
create policy "units insert"
on public.units for insert
with check (public.effective_apartment_permission(apartment_id, 'vehicle_registry.edit'));

create policy "units update"
on public.units for update
using (public.effective_apartment_permission(apartment_id, 'vehicle_registry.edit'))
with check (public.effective_apartment_permission(apartment_id, 'vehicle_registry.edit'));

create policy "units delete"
on public.units for delete
using (public.effective_apartment_permission(apartment_id, 'vehicle_registry.edit'));

-- vehicles
drop policy if exists "vehicles read" on public.vehicles;
create policy "vehicles read"
on public.vehicles for select
using (public.effective_apartment_permission(apartment_id, 'vehicle_registry.view'));

drop policy if exists "vehicles write" on public.vehicles;
create policy "vehicles insert"
on public.vehicles for insert
with check (public.effective_apartment_permission(apartment_id, 'vehicle_registry.edit'));

create policy "vehicles update"
on public.vehicles for update
using (public.effective_apartment_permission(apartment_id, 'vehicle_registry.edit'))
with check (public.effective_apartment_permission(apartment_id, 'vehicle_registry.edit'));

create policy "vehicles delete"
on public.vehicles for delete
using (public.effective_apartment_permission(apartment_id, 'vehicle_registry.edit'));

-- parking_slots
drop policy if exists "parking_slots read" on public.parking_slots;
create policy "parking_slots read"
on public.parking_slots for select
using (public.effective_apartment_permission(apartment_id, 'vehicle_registry.view'));

drop policy if exists "parking_slots write" on public.parking_slots;
create policy "parking_slots insert"
on public.parking_slots for insert
with check (public.effective_apartment_permission(apartment_id, 'vehicle_registry.edit'));

create policy "parking_slots update"
on public.parking_slots for update
using (public.effective_apartment_permission(apartment_id, 'vehicle_registry.edit'))
with check (public.effective_apartment_permission(apartment_id, 'vehicle_registry.edit'));

create policy "parking_slots delete"
on public.parking_slots for delete
using (public.effective_apartment_permission(apartment_id, 'vehicle_registry.edit'));

-- transactions
drop policy if exists "transactions read" on public.transactions;
create policy "transactions read"
on public.transactions for select
using (public.effective_apartment_permission(apartment_id, 'accounts.view'));

drop policy if exists "transactions write" on public.transactions;
create policy "transactions insert"
on public.transactions for insert
with check (public.effective_apartment_permission(apartment_id, 'accounts.edit'));

create policy "transactions update"
on public.transactions for update
using (public.effective_apartment_permission(apartment_id, 'accounts.edit'))
with check (public.effective_apartment_permission(apartment_id, 'accounts.edit'));

create policy "transactions delete"
on public.transactions for delete
using (public.effective_apartment_permission(apartment_id, 'accounts.edit'));

-- society_config
drop policy if exists "society_config read" on public.society_config;
create policy "society_config read"
on public.society_config for select
using (public.effective_apartment_permission(apartment_id, 'setup.view'));

drop policy if exists "society_config write" on public.society_config;
create policy "society_config insert"
on public.society_config for insert
with check (public.effective_apartment_permission(apartment_id, 'setup.edit'));

create policy "society_config update"
on public.society_config for update
using (public.effective_apartment_permission(apartment_id, 'setup.edit'))
with check (public.effective_apartment_permission(apartment_id, 'setup.edit'));

create policy "society_config delete"
on public.society_config for delete
using (public.effective_apartment_permission(apartment_id, 'setup.edit'));
