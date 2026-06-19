-- Income & expenses spreadsheet sync — run in Supabase SQL editor

alter table public.transactions
  add column if not exists external_sync_key text;

alter table public.transactions
  add column if not exists sync_hash text;

create unique index if not exists idx_transactions_external_sync_key
  on public.transactions (apartment_id, external_sync_key)
  where external_sync_key is not null;

create table if not exists public.ledger_sync_settings (
  apartment_id uuid primary key references public.apartments(id) on delete cascade,
  provider text not null default 'NONE' check (provider in ('NONE', 'GOOGLE', 'MICROSOFT', 'FILE')),
  spreadsheet_url text,
  sheet_name text not null default 'Transactions',
  range_a1 text not null default 'A:H',
  last_synced_at timestamptz,
  last_sync_status text,
  last_sync_message text,
  last_sync_imported int not null default 0,
  last_sync_pushed int not null default 0,
  last_sync_etag text,
  column_mapping jsonb default '{}'::jsonb,
  last_sync_hash_version text,
  sync_interval_minutes integer default 0, -- 0 means manual only
  sync_deletions boolean default false,    -- Whether to sync deletions bidirectionally
  updated_at timestamptz not null default now()
);

alter table public.ledger_sync_settings enable row level security;

drop policy if exists "ledger_sync_settings read" on public.ledger_sync_settings;
drop policy if exists "ledger_sync_settings write" on public.ledger_sync_settings;

create policy "ledger_sync_settings read"
on public.ledger_sync_settings for select
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = ledger_sync_settings.apartment_id
  )
);

create policy "ledger_sync_settings write"
on public.ledger_sync_settings for all
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = ledger_sync_settings.apartment_id
  )
);
