-- Society-level OAuth credentials for unattended background spreadsheet sync.
-- Run after supabase_ledger_oauth.sql

create table if not exists public.ledger_sync_service_accounts (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  provider text not null check (provider in ('GOOGLE', 'MICROSOFT')),
  account_email text,
  access_token text not null,
  refresh_token text,
  token_expires_at timestamptz,
  scopes text,
  provider_account_id text,
  account_meta jsonb not null default '{}'::jsonb,
  connected_by uuid references auth.users(id) on delete set null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (apartment_id, provider)
);

create index if not exists idx_ledger_sync_service_accounts_apartment
  on public.ledger_sync_service_accounts (apartment_id, provider);

alter table public.ledger_sync_service_accounts enable row level security;
-- No SELECT/INSERT policies for authenticated users — tokens are server-only.
-- Cron and API routes use the service role key.

create or replace function public.get_ledger_sync_service_status(p_apartment_id uuid)
returns table (
  provider text,
  account_email text,
  connected_at timestamptz,
  token_expires_at timestamptz,
  has_refresh_token boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    sa.provider,
    sa.account_email,
    sa.connected_at,
    sa.token_expires_at,
    (sa.refresh_token is not null and sa.refresh_token <> '') as has_refresh_token
  from public.ledger_sync_service_accounts sa
  where sa.apartment_id = p_apartment_id
    and exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = p_apartment_id
    );
$$;

grant execute on function public.get_ledger_sync_service_status(uuid) to authenticated;

comment on table public.ledger_sync_service_accounts is
  'Dedicated spreadsheet OAuth account per society for Vercel cron /api/sync. Not tied to any app user session.';
