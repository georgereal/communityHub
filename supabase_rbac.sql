-- CommunityHub RBAC + user/apartment mapping (Supabase)
-- Run this in Supabase SQL editor.

-- 1) Profiles (one row per auth user)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  role text not null default 'resident_viewer',
  created_at timestamptz not null default now()
);

-- Role reference (edit freely)
create table if not exists public.roles (
  key text primary key,
  label text not null,
  description text not null
);

insert into public.roles (key, label, description) values
  ('admin','Admin','Full access including user management and settings'),
  ('property_manager','Property Manager','Operational access across registry/units and limited setup'),
  ('accounts_manager','Accounts Manager','Full access to Accounts and reports'),
  ('security','Security','Vehicle registry view + limited edits'),
  ('resident_viewer','Resident Viewer','Read-only access to assigned apartment')
on conflict (key) do nothing;

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email), 'resident_viewer')
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

-- Backfill email when possible (optional safe)
update public.profiles p
set email = u.email
from auth.users u
where p.id = u.id and p.email is null;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 2) Apartments
create table if not exists public.apartments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- 3) User <-> apartment mapping
create table if not exists public.user_apartments (
  user_id uuid references public.profiles(id) on delete cascade,
  apartment_id uuid references public.apartments(id) on delete cascade,
  primary key (user_id, apartment_id)
);

-- Enable RLS
alter table public.profiles enable row level security;
alter table public.apartments enable row level security;
alter table public.user_apartments enable row level security;

-- Helper: is admin?
create or replace function public.is_admin()
returns boolean as $$
  select exists(select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin');
$$ language sql stable;

-- Bootstrap: allow the FIRST ever admin to self-promote
create or replace function public.no_admin_exists()
returns boolean as $$
  select not exists(select 1 from public.profiles p where p.role = 'admin');
$$ language sql stable;

-- PROFILES policies
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile"
on public.profiles for select
using (id = auth.uid() or public.is_admin());

drop policy if exists "admin update profiles" on public.profiles;
create policy "admin update profiles"
on public.profiles for update
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "bootstrap first admin" on public.profiles;
create policy "bootstrap first admin"
on public.profiles for update
using (id = auth.uid() and public.no_admin_exists())
with check (id = auth.uid() and role = 'admin' and public.no_admin_exists());

-- APARTMENTS policies
drop policy if exists "read mapped apartments" on public.apartments;
create policy "read mapped apartments"
on public.apartments for select
using (
  public.is_admin()
  or exists (
    select 1 from public.user_apartments ua
    where ua.apartment_id = apartments.id
      and ua.user_id = auth.uid()
  )
);

drop policy if exists "admin manage apartments" on public.apartments;
create policy "admin manage apartments"
on public.apartments for all
using (public.is_admin())
with check (public.is_admin());

-- USER_APARTMENTS policies
drop policy if exists "read own mappings" on public.user_apartments;
create policy "read own mappings"
on public.user_apartments for select
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "admin manage mappings" on public.user_apartments;
create policy "admin manage mappings"
on public.user_apartments for all
using (public.is_admin())
with check (public.is_admin());

-- Seed (optional): make your first user admin manually:
-- update public.profiles set role='admin' where id = '<your-auth-uid>';

