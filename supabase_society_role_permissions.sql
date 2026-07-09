-- Society-scoped role permission overrides (per apartment).
-- Run in Supabase SQL Editor after supabase_rbac_v2.sql and supabase_rls_operational.sql.

create table if not exists public.society_role_permissions (
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  role_key text not null references public.roles(key) on delete cascade,
  permission_key text not null references public.permissions(key) on delete cascade,
  granted boolean not null,
  updated_at timestamptz not null default now(),
  primary key (apartment_id, role_key, permission_key)
);

create index if not exists idx_society_role_permissions_apt_role
  on public.society_role_permissions (apartment_id, role_key);

comment on table public.society_role_permissions is
  'Per-society overrides to platform role_permissions. Row present = explicit grant/deny for that permission.';

alter table public.society_role_permissions enable row level security;

-- Effective permission for one role in one society (platform default + society override).
create or replace function public.role_has_effective_permission(aid uuid, rkey text, perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select srp.granted
      from public.society_role_permissions srp
      where srp.apartment_id = aid
        and srp.role_key = rkey
        and srp.permission_key = perm
    ),
    exists(
      select 1
      from public.role_permissions rp
      where rp.role_key = rkey
        and rp.permission_key = perm
    )
  );
$$;

-- Apartment permission check with society overrides.
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
    where ura.user_id = auth.uid()
      and ura.scope = 'apartment'
      and ura.apartment_id = aid
      and public.role_has_effective_permission(aid, ura.role_key, perm)
  ) or public.has_system_role('system_admin');
$$;

drop policy if exists "society_role_permissions read" on public.society_role_permissions;
create policy "society_role_permissions read"
on public.society_role_permissions for select
using (
  public.can_access_apartment(apartment_id)
  and (
    public.effective_apartment_permission(apartment_id, 'rbac.view')
    or public.effective_apartment_permission(apartment_id, 'rbac.edit')
    or public.is_admin()
  )
);

drop policy if exists "society_role_permissions insert" on public.society_role_permissions;
drop policy if exists "society_role_permissions update" on public.society_role_permissions;
drop policy if exists "society_role_permissions delete" on public.society_role_permissions;

create policy "society_role_permissions insert"
on public.society_role_permissions for insert
with check (
  public.is_admin()
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
);

create policy "society_role_permissions update"
on public.society_role_permissions for update
using (
  public.is_admin()
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
)
with check (
  public.is_admin()
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
);

create policy "society_role_permissions delete"
on public.society_role_permissions for delete
using (
  public.is_admin()
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
);
