-- Income & expenses spreadsheet sync (Google Sheets / Microsoft Excel)

alter table public.transactions
  add column if not exists external_sync_key text;

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
  last_sync_status text check (last_sync_status is null or last_sync_status in ('OK', 'ERROR', 'PARTIAL')),
  last_sync_message text,
  last_sync_imported int not null default 0,
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
