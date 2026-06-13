-- Phase 2.2 — Bank statement import and reconciliation

create table if not exists public.bank_statement_imports (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  bank_account_id uuid references public.apartment_bank_accounts(id) on delete set null,
  file_name text,
  period_start date,
  period_end date,
  imported_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_bank_statement_imports_apartment
  on public.bank_statement_imports (apartment_id, created_at desc);

create table if not exists public.bank_statement_lines (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.bank_statement_imports(id) on delete cascade,
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  line_date date not null,
  description text,
  debit numeric(12, 2) not null default 0,
  credit numeric(12, 2) not null default 0,
  balance numeric(12, 2),
  match_status text not null default 'UNMATCHED'
    check (match_status in ('UNMATCHED', 'MATCHED', 'IGNORED')),
  transaction_id uuid references public.transactions(id) on delete set null,
  matched_at timestamptz,
  matched_by uuid references auth.users(id) on delete set null
);

create index if not exists idx_bank_statement_lines_import
  on public.bank_statement_lines (import_id);

create index if not exists idx_bank_statement_lines_apartment
  on public.bank_statement_lines (apartment_id, match_status);

create index if not exists idx_bank_statement_lines_txn
  on public.bank_statement_lines (transaction_id)
  where transaction_id is not null;

alter table public.bank_statement_imports enable row level security;
alter table public.bank_statement_lines enable row level security;

drop policy if exists "bank_statement_imports read" on public.bank_statement_imports;
create policy "bank_statement_imports read"
on public.bank_statement_imports for select
using (public.effective_apartment_permission(apartment_id, 'accounts.view'));

drop policy if exists "bank_statement_imports write" on public.bank_statement_imports;
create policy "bank_statement_imports insert"
on public.bank_statement_imports for insert
with check (public.effective_apartment_permission(apartment_id, 'accounts.edit'));

create policy "bank_statement_imports delete"
on public.bank_statement_imports for delete
using (public.effective_apartment_permission(apartment_id, 'accounts.edit'));

drop policy if exists "bank_statement_lines read" on public.bank_statement_lines;
create policy "bank_statement_lines read"
on public.bank_statement_lines for select
using (public.effective_apartment_permission(apartment_id, 'accounts.view'));

drop policy if exists "bank_statement_lines write" on public.bank_statement_lines;
create policy "bank_statement_lines insert"
on public.bank_statement_lines for insert
with check (public.effective_apartment_permission(apartment_id, 'accounts.edit'));

create policy "bank_statement_lines update"
on public.bank_statement_lines for update
using (public.effective_apartment_permission(apartment_id, 'accounts.edit'))
with check (public.effective_apartment_permission(apartment_id, 'accounts.edit'));

create policy "bank_statement_lines delete"
on public.bank_statement_lines for delete
using (public.effective_apartment_permission(apartment_id, 'accounts.edit'));
