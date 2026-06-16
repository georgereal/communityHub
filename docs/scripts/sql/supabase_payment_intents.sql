-- Phase 3.2 — Online payment intents (gateway webhook handled via Edge Function later)

create table if not exists public.apartment_payment_config (
  apartment_id uuid primary key references public.apartments(id) on delete cascade,
  gateway text check (gateway in ('RAZORPAY', 'CASHFREE')),
  test_mode boolean not null default true,
  key_id text,
  updated_at timestamptz not null default now()
);

create table if not exists public.payment_intents (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  invoice_id uuid not null references public.maintenance_invoices(id) on delete cascade,
  gateway text not null check (gateway in ('RAZORPAY', 'CASHFREE', 'TEST')),
  gateway_order_id text,
  amount numeric(12, 2) not null,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'PAID', 'FAILED', 'EXPIRED')),
  metadata jsonb,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists idx_payment_intents_invoice on public.payment_intents (invoice_id);
create index if not exists idx_payment_intents_apartment on public.payment_intents (apartment_id, created_at desc);

alter table public.apartment_payment_config enable row level security;
alter table public.payment_intents enable row level security;

drop policy if exists "payment_config read" on public.apartment_payment_config;
drop policy if exists "payment_config write" on public.apartment_payment_config;

create policy "payment_config read"
on public.apartment_payment_config for select
using (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = apartment_payment_config.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
  )
);

create policy "payment_config write"
on public.apartment_payment_config for all
using (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = apartment_payment_config.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
  )
);

drop policy if exists "payment_intents read" on public.payment_intents;
drop policy if exists "payment_intents insert" on public.payment_intents;
drop policy if exists "payment_intents update" on public.payment_intents;
drop policy if exists "payment_intents write" on public.payment_intents;

create policy "payment_intents read"
on public.payment_intents for select
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = payment_intents.apartment_id
  )
);

create policy "payment_intents insert"
on public.payment_intents for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = payment_intents.apartment_id
  )
);

create policy "payment_intents update"
on public.payment_intents for update
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = payment_intents.apartment_id
  )
);
