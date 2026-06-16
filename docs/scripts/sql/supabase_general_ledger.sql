-- Phase 6.2 — Simplified double-entry general ledger

create table if not exists public.chart_of_accounts (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  code text not null,
  name text not null,
  account_type text not null
    check (account_type in ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE')),
  is_active boolean not null default true,
  unique (apartment_id, code)
);

create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  entry_date date not null,
  description text not null,
  source_type text,
  source_id uuid,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  entry_id uuid not null references public.journal_entries(id) on delete cascade,
  account_id uuid not null references public.chart_of_accounts(id) on delete restrict,
  debit numeric(12, 2) not null default 0 check (debit >= 0),
  credit numeric(12, 2) not null default 0 check (credit >= 0),
  check (debit > 0 or credit > 0)
);

create index if not exists idx_journal_entries_apartment on public.journal_entries (apartment_id, entry_date desc);
create index if not exists idx_journal_lines_entry on public.journal_lines (entry_id);

alter table public.chart_of_accounts enable row level security;
alter table public.journal_entries enable row level security;
alter table public.journal_lines enable row level security;

drop policy if exists "chart_of_accounts read" on public.chart_of_accounts;
drop policy if exists "chart_of_accounts insert" on public.chart_of_accounts;
drop policy if exists "chart_of_accounts update" on public.chart_of_accounts;
drop policy if exists "chart_of_accounts write" on public.chart_of_accounts;

create policy "chart_of_accounts read"
on public.chart_of_accounts for select
using (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = chart_of_accounts.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
  )
);

create policy "chart_of_accounts insert"
on public.chart_of_accounts for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = chart_of_accounts.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
  )
);

create policy "chart_of_accounts update"
on public.chart_of_accounts for update
using (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = chart_of_accounts.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
  )
);

drop policy if exists "journal_entries read" on public.journal_entries;
drop policy if exists "journal_entries insert" on public.journal_entries;
drop policy if exists "journal_entries write" on public.journal_entries;

create policy "journal_entries read"
on public.journal_entries for select
using (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = journal_entries.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
  )
);

create policy "journal_entries insert"
on public.journal_entries for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = journal_entries.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
  )
);

drop policy if exists "journal_lines read" on public.journal_lines;
drop policy if exists "journal_lines insert" on public.journal_lines;
drop policy if exists "journal_lines write" on public.journal_lines;

create policy "journal_lines read"
on public.journal_lines for select
using (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = journal_lines.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
  )
);

create policy "journal_lines insert"
on public.journal_lines for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = journal_lines.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
  )
);
