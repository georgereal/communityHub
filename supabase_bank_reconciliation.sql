-- Phase 2.2 — Bank statement import and reconciliation
-- Standalone: does NOT require supabase_rls_operational.sql or effective_apartment_permission().
-- Read/write limited to admin + accounts_manager on mapped apartments.

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

-- Helper: user is admin or accounts_manager on this apartment
-- (inline — no dependency on RBAC v2 functions)

drop policy if exists "bank_statement_imports read" on public.bank_statement_imports;
create policy "bank_statement_imports read"
on public.bank_statement_imports for select
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.user_id = auth.uid()
        and ua.apartment_id = bank_statement_imports.apartment_id
        and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "bank_statement_imports insert" on public.bank_statement_imports;
create policy "bank_statement_imports insert"
on public.bank_statement_imports for insert
with check (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.user_id = auth.uid()
        and ua.apartment_id = bank_statement_imports.apartment_id
        and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "bank_statement_imports delete" on public.bank_statement_imports;
create policy "bank_statement_imports delete"
on public.bank_statement_imports for delete
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.user_id = auth.uid()
        and ua.apartment_id = bank_statement_imports.apartment_id
        and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "bank_statement_lines read" on public.bank_statement_lines;
create policy "bank_statement_lines read"
on public.bank_statement_lines for select
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.user_id = auth.uid()
        and ua.apartment_id = bank_statement_lines.apartment_id
        and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "bank_statement_lines insert" on public.bank_statement_lines;
create policy "bank_statement_lines insert"
on public.bank_statement_lines for insert
with check (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.user_id = auth.uid()
        and ua.apartment_id = bank_statement_lines.apartment_id
        and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "bank_statement_lines update" on public.bank_statement_lines;
create policy "bank_statement_lines update"
on public.bank_statement_lines for update
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.user_id = auth.uid()
        and ua.apartment_id = bank_statement_lines.apartment_id
        and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
)
with check (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.user_id = auth.uid()
        and ua.apartment_id = bank_statement_lines.apartment_id
        and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "bank_statement_lines delete" on public.bank_statement_lines;
create policy "bank_statement_lines delete"
on public.bank_statement_lines for delete
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.user_id = auth.uid()
        and ua.apartment_id = bank_statement_lines.apartment_id
        and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);
