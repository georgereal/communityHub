-- Exclude entries from the active Financial Ledger (shown in separate excluded table).
-- Run in Supabase SQL Editor after transactions table exists.

alter table public.transactions
  add column if not exists excluded_from_ledger boolean not null default false;

create index if not exists idx_transactions_ledger_exclude
  on public.transactions (apartment_id, excluded_from_ledger)
  where excluded_from_ledger = true;

comment on column public.transactions.excluded_from_ledger is
  'When true, row is hidden from the main ledger and excluded from ledger bank balance; shown in Excluded entries.';
