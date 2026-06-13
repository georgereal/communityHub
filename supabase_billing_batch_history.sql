-- Billing batch history extensions
-- Run in Supabase SQL Editor after supabase_maintenance_billing_v2.sql

alter table public.maintenance_billing_batches
  add column if not exists created_by uuid references auth.users(id) on delete set null;

alter table public.maintenance_billing_batches
  add column if not exists total_amount numeric(12, 2);

alter table public.maintenance_billing_batches
  add column if not exists skipped_count int not null default 0;

create table if not exists public.maintenance_billing_batch_skips (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.maintenance_billing_batches(id) on delete cascade,
  apartment_id uuid not null,
  unit_id uuid not null references public.units(id) on delete cascade,
  reason text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_maintenance_billing_batch_skips_batch
  on public.maintenance_billing_batch_skips (batch_id);

alter table public.maintenance_billing_batch_skips enable row level security;

drop policy if exists "maintenance_billing_batch_skips read" on public.maintenance_billing_batch_skips;
create policy "maintenance_billing_batch_skips read"
on public.maintenance_billing_batch_skips for select
using (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_billing_batch_skips.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);

drop policy if exists "maintenance_billing_batch_skips insert" on public.maintenance_billing_batch_skips;
create policy "maintenance_billing_batch_skips insert"
on public.maintenance_billing_batch_skips for insert
with check (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_billing_batch_skips.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);

drop policy if exists "maintenance_billing_batch_skips delete" on public.maintenance_billing_batch_skips;
create policy "maintenance_billing_batch_skips delete"
on public.maintenance_billing_batch_skips for delete
using (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_billing_batch_skips.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);
