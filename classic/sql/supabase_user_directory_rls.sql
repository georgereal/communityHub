-- User directory + access assignment RLS for v2 apartment admins.
-- Run in Supabase SQL Editor after supabase_rls_operational.sql / supabase_rbac_v2.sql
-- Safe to re-run.

-- Helper: who may assign roles / apartment access for a society
create or replace function public.can_manage_apartment_access(aid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select aid is not null
    and (
      public.has_system_role('system_admin')
      or public.is_admin()
      or public.has_apartment_permission(aid, 'rbac.edit')
      or public.effective_apartment_permission(aid, 'rbac.edit')
      or exists (
        select 1
        from public.user_role_assignments ura
        where ura.user_id = auth.uid()
          and ura.scope = 'apartment'
          and ura.apartment_id = aid
          and ura.role_key = 'apartment_admin'
      )
    );
$$;

-- PROFILES: read peers in societies you can manage
drop policy if exists "profiles read" on public.profiles;
create policy "profiles read"
on public.profiles for select
using (
  id = auth.uid()
  or public.is_admin()
  or public.has_system_role('system_admin')
  or exists (
    select 1
    from public.user_apartments ua
    where ua.user_id = profiles.id
      and (
        public.effective_apartment_permission(ua.apartment_id, 'rbac.view')
        or public.effective_apartment_permission(ua.apartment_id, 'setup.edit')
      )
  )
);

-- PROFILES: update — includes first-time assignment (target may have no mappings yet)
drop policy if exists "profiles admin update" on public.profiles;
create policy "profiles admin update"
on public.profiles for update
using (
  public.is_admin()
  or public.has_system_role('system_admin')
  or exists (
    select 1
    from public.user_apartments ua
    where ua.user_id = profiles.id
      and public.can_manage_apartment_access(ua.apartment_id)
  )
  or exists (
    select 1
    from public.user_apartments ua
    where ua.user_id = auth.uid()
      and public.can_manage_apartment_access(ua.apartment_id)
  )
)
with check (
  public.is_admin()
  or public.has_system_role('system_admin')
  or exists (
    select 1
    from public.user_apartments ua
    where ua.user_id = profiles.id
      and public.can_manage_apartment_access(ua.apartment_id)
  )
  or exists (
    select 1
    from public.user_apartments ua
    where ua.user_id = auth.uid()
      and public.can_manage_apartment_access(ua.apartment_id)
  )
);

-- USER_APARTMENTS: read mappings for societies you manage
drop policy if exists "read own mappings" on public.user_apartments;
drop policy if exists "user_apartments read" on public.user_apartments;
create policy "user_apartments read"
on public.user_apartments for select
using (
  user_id = auth.uid()
  or public.is_admin()
  or public.has_system_role('system_admin')
  or public.effective_apartment_permission(apartment_id, 'rbac.view')
  or public.effective_apartment_permission(apartment_id, 'setup.view')
);

-- USER_APARTMENTS: insert / update / delete for apartment admins
drop policy if exists "admin manage mappings" on public.user_apartments;
drop policy if exists "user_apartments manage" on public.user_apartments;
create policy "user_apartments manage"
on public.user_apartments for all
using (public.can_manage_apartment_access(apartment_id))
with check (public.can_manage_apartment_access(apartment_id));

-- ROLE ASSIGNMENTS: apartment staff can read/manage roles in their societies
drop policy if exists "user_role_assignments read" on public.user_role_assignments;
drop policy if exists "user_role_assignments read own" on public.user_role_assignments;
create policy "user_role_assignments read"
on public.user_role_assignments for select
using (
  user_id = auth.uid()
  or public.has_system_role('system_admin')
  or public.is_admin()
  or (
    scope = 'apartment'
    and apartment_id is not null
    and (
      public.can_manage_apartment_access(apartment_id)
      or public.effective_apartment_permission(apartment_id, 'rbac.view')
    )
  )
);

drop policy if exists "user_role_assignments manage" on public.user_role_assignments;
drop policy if exists "user_role_assignments system manage" on public.user_role_assignments;
create policy "user_role_assignments manage"
on public.user_role_assignments for all
using (
  public.has_system_role('system_admin')
  or public.is_admin()
  or (
    scope = 'apartment'
    and apartment_id is not null
    and public.can_manage_apartment_access(apartment_id)
  )
)
with check (
  public.has_system_role('system_admin')
  or public.is_admin()
  or (
    scope = 'apartment'
    and apartment_id is not null
    and public.can_manage_apartment_access(apartment_id)
  )
);
