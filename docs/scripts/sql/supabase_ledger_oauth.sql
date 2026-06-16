-- Per-society OAuth apps + per-user spreadsheet connections (no public env keys)
-- Run after supabase_ledger_spreadsheet_sync.sql

create table if not exists public.ledger_sync_oauth_apps (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  provider text not null check (provider in ('GOOGLE', 'MICROSOFT')),
  client_id text not null,
  tenant_id text not null default 'common',
  redirect_uri text,
  enabled boolean not null default true,
  configured_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (apartment_id, provider)
);

create table if not exists public.user_oauth_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  provider text not null check (provider in ('GOOGLE', 'MICROSOFT')),
  account_email text,
  access_token text not null,
  refresh_token text,
  token_expires_at timestamptz,
  scopes text,
  provider_account_id text,
  account_meta jsonb not null default '{}'::jsonb,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, apartment_id, provider)
);

create index if not exists idx_user_oauth_connections_apartment
  on public.user_oauth_connections (apartment_id, provider);

alter table public.ledger_sync_settings
  add column if not exists last_synced_by uuid references auth.users(id) on delete set null;

alter table public.ledger_sync_oauth_apps enable row level security;
alter table public.user_oauth_connections enable row level security;

drop policy if exists "ledger_sync_oauth_apps read" on public.ledger_sync_oauth_apps;
drop policy if exists "ledger_sync_oauth_apps write" on public.ledger_sync_oauth_apps;
drop policy if exists "user_oauth_connections own" on public.user_oauth_connections;

create policy "ledger_sync_oauth_apps read"
on public.ledger_sync_oauth_apps for select
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = ledger_sync_oauth_apps.apartment_id
  )
);

create policy "ledger_sync_oauth_apps write"
on public.ledger_sync_oauth_apps for all
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = ledger_sync_oauth_apps.apartment_id
  )
);

create policy "user_oauth_connections own"
on public.user_oauth_connections for all
using (user_id = auth.uid())
with check (user_id = auth.uid());

comment on table public.ledger_sync_oauth_apps is
  'Society-specific OAuth app registration (client ID / tenant). Configured by accounts admin — not public env vars.';

comment on table public.user_oauth_connections is
  'Per-user OAuth tokens after SSO connect. Only the owning user can read/write their row (RLS).';
