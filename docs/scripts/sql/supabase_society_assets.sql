-- Phase 4.4 — Society asset register

create table if not exists public.society_assets (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  name text not null,
  asset_type text not null,
  location text,
  vendor_id uuid references public.expense_vendors(id) on delete set null,
  amc_end_date date,
  last_service_date date,
  next_service_due date,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.asset_service_log (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.society_assets(id) on delete cascade,
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  service_date date not null,
  description text,
  expense_transaction_id uuid references public.transactions(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_society_assets_apartment on public.society_assets (apartment_id);
create index if not exists idx_asset_service_log_asset on public.asset_service_log (asset_id);

alter table public.society_assets enable row level security;
alter table public.asset_service_log enable row level security;

drop policy if exists "society_assets read" on public.society_assets;
drop policy if exists "society_assets insert" on public.society_assets;
drop policy if exists "society_assets update" on public.society_assets;
drop policy if exists "society_assets delete" on public.society_assets;
drop policy if exists "society_assets write" on public.society_assets;

create policy "society_assets read"
on public.society_assets for select
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = society_assets.apartment_id
  )
);

create policy "society_assets insert"
on public.society_assets for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = society_assets.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager')
  )
);

create policy "society_assets update"
on public.society_assets for update
using (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = society_assets.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager')
  )
);

create policy "society_assets delete"
on public.society_assets for delete
using (
  exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  )
);

drop policy if exists "asset_service_log read" on public.asset_service_log;
drop policy if exists "asset_service_log insert" on public.asset_service_log;
drop policy if exists "asset_service_log write" on public.asset_service_log;

create policy "asset_service_log read"
on public.asset_service_log for select
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = asset_service_log.apartment_id
  )
);

create policy "asset_service_log insert"
on public.asset_service_log for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = asset_service_log.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager')
  )
);
