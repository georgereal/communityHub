-- Exclude non-P&L ledger rows from Financial Reports (bank rejects, internal transfers).
-- Run in Supabase SQL Editor after transactions table exists.

alter table public.transactions
  add column if not exists exclude_from_reports boolean not null default false;

create index if not exists idx_transactions_report_exclude
  on public.transactions (apartment_id, exclude_from_reports)
  where exclude_from_reports = true;

comment on column public.transactions.exclude_from_reports is
  'When true, transaction stays in the ledger and bank balance but is omitted from income/expense reports and charts';
