-- Expense / income documents (vouchers) — separate from passbook ledger lines.
-- Link many docs to one ledger transaction via transaction_id (e.g. cash spends → Petty Cash funding).
-- Run in Supabase SQL Editor.

create table if not exists public.finance_documents (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  kind text not null check (kind in ('OUT', 'IN')),
  doc_date date not null,
  amount numeric not null check (amount >= 0),
  cat text,
  sub_category text,
  vendor_name text,
  description text,
  attachment_urls jsonb not null default '[]'::jsonb,
  -- Link to a ledger (transactions) row; many cash docs can share one Petty Cash funding line.
  transaction_id uuid references public.transactions(id) on delete set null,
  -- unpaid → paid → linked (void = cancelled). Legacy installs: run supabase_finance_documents_status.sql
  status text not null default 'unpaid' check (status in ('unpaid', 'paid', 'linked', 'void')),
  source text not null default 'manual' check (source in ('manual', 'excel')),
  source_file text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create index if not exists idx_finance_documents_apartment_date
  on public.finance_documents (apartment_id, doc_date desc);

create index if not exists idx_finance_documents_transaction
  on public.finance_documents (apartment_id, transaction_id)
  where transaction_id is not null;

create index if not exists idx_finance_documents_status
  on public.finance_documents (apartment_id, status, kind);

alter table public.finance_documents enable row level security;

drop policy if exists "finance_documents read" on public.finance_documents;
create policy "finance_documents read"
on public.finance_documents for select
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = finance_documents.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "finance_documents insert" on public.finance_documents;
create policy "finance_documents insert"
on public.finance_documents for insert
with check (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = finance_documents.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "finance_documents update" on public.finance_documents;
create policy "finance_documents update"
on public.finance_documents for update
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = finance_documents.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "finance_documents delete" on public.finance_documents;
create policy "finance_documents delete"
on public.finance_documents for delete
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = finance_documents.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

-- Ready for phase 2: mark ledger lines as cash-float funding parents.
alter table public.transactions
  add column if not exists is_cash_float boolean not null default false;

create index if not exists idx_transactions_cash_float
  on public.transactions (apartment_id, is_cash_float)
  where is_cash_float = true;

comment on table public.finance_documents is
  'Expense/income vouchers with attachments in private Cloudflare R2; optional link to ledger transactions (1 ledger → many docs).';
comment on column public.transactions.is_cash_float is
  'True when this ledger line funds the cash float (typically bank Petty Cash).';

-- Opt out of Petty Cash float buckets (pre-cutover / invalid funding lines).
alter table public.transactions
  add column if not exists exclude_from_cash_float boolean not null default false;

create index if not exists idx_transactions_exclude_cash_float
  on public.transactions (apartment_id, exclude_from_cash_float)
  where exclude_from_cash_float = true;

comment on column public.transactions.exclude_from_cash_float is
  'True when this bank Petty Cash / float line should not appear in cash float buckets (e.g. before tracking started).';

-- Opening desk cash when bill/float tracking started (can be negative = already spent vs buckets).
alter table public.apartment_bank_accounts
  add column if not exists cash_float_opening_balance numeric(12, 2),
  add column if not exists cash_float_opening_date date;

comment on column public.apartment_bank_accounts.cash_float_opening_balance is
  'Desk cash on hand as of cash_float_opening_date. Left = opening + bucket unused + receipts − banked float.';
comment on column public.apartment_bank_accounts.cash_float_opening_date is
  'Date the cash float opening balance applies (usually start of bill tracking).';

-- Bank credit that took cash off the desk (float / wallet), beyond linked cash receipts.
alter table public.transactions
  add column if not exists cash_desk_deposit numeric not null default 0;

comment on column public.transactions.cash_desk_deposit is
  'Amount of this bank credit drawn from desk cash wallet (in addition to any linked cash receipt docs).';

comment on column public.finance_documents.attachment_urls is
  'JSON array of private R2 attachment objects: { key, contentType, originalName, bytes, uploadedAt }. Access via short-lived presigned GET URLs only.';
