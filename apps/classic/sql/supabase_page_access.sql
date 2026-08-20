-- Page-level access: society role templates + per-user overrides.
-- Run in Supabase SQL Editor after supabase_rbac_v2.sql

create table if not exists public.society_role_page_access (
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  role_key text not null references public.roles(key) on delete cascade,
  route text not null,
  allowed boolean not null,
  updated_at timestamptz not null default now(),
  primary key (apartment_id, role_key, route)
);

create table if not exists public.user_page_overrides (
  user_id uuid not null references auth.users(id) on delete cascade,
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  route text not null,
  access text not null check (access in ('grant', 'deny')),
  updated_at timestamptz not null default now(),
  primary key (user_id, apartment_id, route)
);

create index if not exists idx_society_role_page_access_apt_role
  on public.society_role_page_access (apartment_id, role_key);
create index if not exists idx_user_page_overrides_user_apt
  on public.user_page_overrides (user_id, apartment_id);

comment on table public.society_role_page_access is
  'Per-society overrides to default role page access. Row present = explicit allow/deny for that route.';
comment on table public.user_page_overrides is
  'Per-user page grant/deny on top of role template for a society.';

alter table public.society_role_page_access enable row level security;
alter table public.user_page_overrides enable row level security;

-- society_role_page_access
drop policy if exists "society_role_page_access read" on public.society_role_page_access;
create policy "society_role_page_access read"
on public.society_role_page_access for select
using (
  public.can_access_apartment(apartment_id)
  and (
    public.effective_apartment_permission(apartment_id, 'rbac.view')
    or public.effective_apartment_permission(apartment_id, 'rbac.edit')
    or public.is_admin()
  )
);

drop policy if exists "society_role_page_access write" on public.society_role_page_access;
drop policy if exists "society_role_page_access insert" on public.society_role_page_access;
drop policy if exists "society_role_page_access update" on public.society_role_page_access;
drop policy if exists "society_role_page_access delete" on public.society_role_page_access;
create policy "society_role_page_access insert"
on public.society_role_page_access for insert
with check (
  public.is_admin()
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
);

create policy "society_role_page_access update"
on public.society_role_page_access for update
using (
  public.is_admin()
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
)
with check (
  public.is_admin()
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
);

create policy "society_role_page_access delete"
on public.society_role_page_access for delete
using (
  public.is_admin()
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
);

-- user_page_overrides
drop policy if exists "user_page_overrides read" on public.user_page_overrides;
create policy "user_page_overrides read"
on public.user_page_overrides for select
using (
  user_id = auth.uid()
  or public.is_admin()
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
);

drop policy if exists "user_page_overrides write" on public.user_page_overrides;
drop policy if exists "user_page_overrides insert" on public.user_page_overrides;
drop policy if exists "user_page_overrides update" on public.user_page_overrides;
drop policy if exists "user_page_overrides delete" on public.user_page_overrides;
create policy "user_page_overrides insert"
on public.user_page_overrides for insert
with check (
  public.is_admin()
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
);

create policy "user_page_overrides update"
on public.user_page_overrides for update
using (
  public.is_admin()
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
)
with check (
  public.is_admin()
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
);

create policy "user_page_overrides delete"
on public.user_page_overrides for delete
using (
  public.is_admin()
  or public.effective_apartment_permission(apartment_id, 'rbac.edit')
);
