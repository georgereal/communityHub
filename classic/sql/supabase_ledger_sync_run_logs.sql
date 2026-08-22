-- Sync run audit — journal tables + line-by-line logs
-- Safe to run in one shot in Supabase SQL editor.
-- Prerequisite: supabase_ledger_spreadsheet_sync.sql (ledger_sync_settings table)

-- ── 1. Sync run journal (rollback + summary) ─────────────────────────────

create table if not exists public.ledger_sync_runs (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'OK', 'WARN', 'FAILED', 'ROLLED_BACK')),
  imported int not null default 0,
  updated int not null default 0,
  deleted int not null default 0,
  skipped int not null default 0,
  pushed int not null default 0,
  message text,
  bounds_snapshot jsonb,
  rolled_back_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  source text not null default 'browser'
    check (source in ('browser', 'cron', 'manual_api'))
);

create index if not exists idx_ledger_sync_runs_apartment
  on public.ledger_sync_runs (apartment_id, completed_at desc nulls last);

-- source column for installs that already had ledger_sync_runs without it
alter table public.ledger_sync_runs
  add column if not exists source text not null default 'browser';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ledger_sync_runs_source_check'
  ) then
    alter table public.ledger_sync_runs
      add constraint ledger_sync_runs_source_check
      check (source in ('browser', 'cron', 'manual_api'));
  end if;
exception when others then
  null;
end $$;

create table if not exists public.ledger_sync_run_changes (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.ledger_sync_runs(id) on delete cascade,
  seq int not null,
  action text not null check (action in ('insert', 'update', 'delete', 'push_mark')),
  transaction_id uuid not null,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_ledger_sync_run_changes_run
  on public.ledger_sync_run_changes (run_id, seq);

alter table public.ledger_sync_runs enable row level security;
alter table public.ledger_sync_run_changes enable row level security;

drop policy if exists "ledger_sync_runs read" on public.ledger_sync_runs;
create policy "ledger_sync_runs read"
on public.ledger_sync_runs for select
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = ledger_sync_runs.apartment_id
  )
);

drop policy if exists "ledger_sync_runs write" on public.ledger_sync_runs;
create policy "ledger_sync_runs write"
on public.ledger_sync_runs for all
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = ledger_sync_runs.apartment_id
  )
);

drop policy if exists "ledger_sync_run_changes read" on public.ledger_sync_run_changes;
create policy "ledger_sync_run_changes read"
on public.ledger_sync_run_changes for select
using (
  exists (
    select 1 from public.ledger_sync_runs r
    join public.user_apartments ua on ua.apartment_id = r.apartment_id
    where r.id = ledger_sync_run_changes.run_id and ua.user_id = auth.uid()
  )
);

drop policy if exists "ledger_sync_run_changes write" on public.ledger_sync_run_changes;
create policy "ledger_sync_run_changes write"
on public.ledger_sync_run_changes for all
using (
  exists (
    select 1 from public.ledger_sync_runs r
    join public.user_apartments ua on ua.apartment_id = r.apartment_id
    where r.id = ledger_sync_run_changes.run_id and ua.user_id = auth.uid()
  )
);

alter table public.ledger_sync_settings
  add column if not exists last_sync_run_id uuid references public.ledger_sync_runs(id) on delete set null;

-- ── 2. Line-by-line audit logs ───────────────────────────────────────────

create table if not exists public.ledger_sync_run_logs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.ledger_sync_runs(id) on delete cascade,
  seq int not null,
  logged_at timestamptz not null default now(),
  level text not null default 'info'
    check (level in ('info', 'skip', 'parse', 'db', 'warn', 'error')),
  message text not null,
  detail jsonb
);

create index if not exists idx_ledger_sync_run_logs_run
  on public.ledger_sync_run_logs (run_id, seq);

alter table public.ledger_sync_run_logs enable row level security;

drop policy if exists "ledger_sync_run_logs read" on public.ledger_sync_run_logs;
create policy "ledger_sync_run_logs read"
on public.ledger_sync_run_logs for select
using (
  exists (
    select 1 from public.ledger_sync_runs r
    join public.user_apartments ua on ua.apartment_id = r.apartment_id
    where r.id = ledger_sync_run_logs.run_id and ua.user_id = auth.uid()
  )
);

drop policy if exists "ledger_sync_run_logs write" on public.ledger_sync_run_logs;
create policy "ledger_sync_run_logs write"
on public.ledger_sync_run_logs for all
using (
  exists (
    select 1 from public.ledger_sync_runs r
    join public.user_apartments ua on ua.apartment_id = r.apartment_id
    where r.id = ledger_sync_run_logs.run_id and ua.user_id = auth.uid()
  )
);

comment on table public.ledger_sync_runs is
  'One row per spreadsheet sync run (browser, Vercel cron, or manual API).';
comment on table public.ledger_sync_run_logs is
  'Row-by-row sync trace lines for audit (browser sync, Vercel cron, manual API).';
