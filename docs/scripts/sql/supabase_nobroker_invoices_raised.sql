-- NoBroker invoices raised (monthly billing export) — run in Supabase SQL Editor.
-- Stores current-period charge heads for finance report stacked charts.
-- Separate from maintenance_invoices and from NoBroker payment dumps.
-- `raw` keeps the full Excel row so new/unknown columns are never dropped.

create table if not exists public.nobroker_invoices_raised (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  billing_month date not null,
  unit_id_external text,
  unit_number text,
  invoice_number text not null,
  start_period_date date,
  end_period_date date,
  invoice_date date,
  due_date date,
  resident_name text,
  occupancy_status text,
  charges jsonb not null default '{}'::jsonb,
  raw jsonb not null default '{}'::jsonb,
  total_raised numeric not null default 0,
  source_file text,
  imported_at timestamptz not null default now(),
  unique (apartment_id, invoice_number)
);

-- Existing deployments that created the table earlier:
alter table public.nobroker_invoices_raised
  add column if not exists raw jsonb not null default '{}'::jsonb;

create index if not exists idx_nobroker_invoices_raised_apartment_month
  on public.nobroker_invoices_raised (apartment_id, billing_month);

create index if not exists idx_nobroker_invoices_raised_apartment
  on public.nobroker_invoices_raised (apartment_id);

alter table public.nobroker_invoices_raised enable row level security;

drop policy if exists "nobroker_invoices_raised read" on public.nobroker_invoices_raised;
create policy "nobroker_invoices_raised read"
on public.nobroker_invoices_raised for select
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = nobroker_invoices_raised.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "nobroker_invoices_raised insert" on public.nobroker_invoices_raised;
create policy "nobroker_invoices_raised insert"
on public.nobroker_invoices_raised for insert
with check (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = nobroker_invoices_raised.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "nobroker_invoices_raised update" on public.nobroker_invoices_raised;
create policy "nobroker_invoices_raised update"
on public.nobroker_invoices_raised for update
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = nobroker_invoices_raised.apartment_id
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
      where ua.user_id = auth.uid() and ua.apartment_id = nobroker_invoices_raised.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "nobroker_invoices_raised delete" on public.nobroker_invoices_raised;
create policy "nobroker_invoices_raised delete"
on public.nobroker_invoices_raised for delete
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = nobroker_invoices_raised.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);
