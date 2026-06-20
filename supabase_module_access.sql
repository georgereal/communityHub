-- Module access: enable/disable nav modules per apartment and per user override.
-- Run in Supabase SQL Editor. Safe to re-run.

create table if not exists public.apartment_module_settings (
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  module_key text not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (apartment_id, module_key)
);

create table if not exists public.user_module_access (
  user_id uuid not null references auth.users(id) on delete cascade,
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  module_key text not null,
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, apartment_id, module_key)
);

create index if not exists idx_apartment_module_settings_apt on public.apartment_module_settings (apartment_id);
create index if not exists idx_user_module_access_user_apt on public.user_module_access (user_id, apartment_id);

comment on table public.apartment_module_settings is 'Society-wide module toggles (Finance, Property, etc.). Missing row = enabled.';
comment on table public.user_module_access is 'Per-user module override for a society. Missing row = inherit apartment setting.';

alter table public.apartment_module_settings enable row level security;
alter table public.user_module_access enable row level security;

-- apartment_module_settings
drop policy if exists "apartment_module_settings read" on public.apartment_module_settings;
create policy "apartment_module_settings read"
on public.apartment_module_settings for select
using (public.can_access_apartment(apartment_id));

drop policy if exists "apartment_module_settings write" on public.apartment_module_settings;
create policy "apartment_module_settings insert"
on public.apartment_module_settings for insert
with check (public.effective_apartment_permission(apartment_id, 'setup.edit'));

create policy "apartment_module_settings update"
on public.apartment_module_settings for update
using (public.effective_apartment_permission(apartment_id, 'setup.edit'))
with check (public.effective_apartment_permission(apartment_id, 'setup.edit'));

create policy "apartment_module_settings delete"
on public.apartment_module_settings for delete
using (public.effective_apartment_permission(apartment_id, 'setup.edit'));

-- user_module_access
drop policy if exists "user_module_access read" on public.user_module_access;
create policy "user_module_access read"
on public.user_module_access for select
using (
  user_id = auth.uid()
  or public.effective_apartment_permission(apartment_id, 'setup.edit')
);

drop policy if exists "user_module_access write" on public.user_module_access;
create policy "user_module_access insert"
on public.user_module_access for insert
with check (public.effective_apartment_permission(apartment_id, 'setup.edit'));

create policy "user_module_access update"
on public.user_module_access for update
using (public.effective_apartment_permission(apartment_id, 'setup.edit'))
with check (public.effective_apartment_permission(apartment_id, 'setup.edit'));

create policy "user_module_access delete"
on public.user_module_access for delete
using (public.effective_apartment_permission(apartment_id, 'setup.edit'));
