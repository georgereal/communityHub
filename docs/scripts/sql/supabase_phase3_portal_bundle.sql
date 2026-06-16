-- Run this ONCE in Supabase SQL Editor to create all Phase 3 portal tables
-- Safe to re-run (idempotent policies)

-- Phase 3.1 — Resident portal user links (standalone RLS)

create table if not exists public.resident_user_links (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  resident_id uuid not null references public.residents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (apartment_id, user_id, resident_id)
);

create index if not exists idx_resident_user_links_user on public.resident_user_links (user_id);
create index if not exists idx_resident_user_links_resident on public.resident_user_links (resident_id);

alter table public.resident_user_links enable row level security;

drop policy if exists "resident_user_links read" on public.resident_user_links;
drop policy if exists "resident_user_links insert" on public.resident_user_links;
drop policy if exists "resident_user_links update" on public.resident_user_links;
drop policy if exists "resident_user_links delete" on public.resident_user_links;
drop policy if exists "resident_user_links write" on public.resident_user_links;

create policy "resident_user_links read"
on public.resident_user_links for select
using (
  auth.uid() is not null
  and (
    user_id = auth.uid()
    or exists (
      select 1 from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.user_id = auth.uid()
        and ua.apartment_id = resident_user_links.apartment_id
        and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager', 'accounts_manager')
    )
  )
);

create policy "resident_user_links insert"
on public.resident_user_links for insert
with check (
  auth.uid() is not null
  and (
    user_id = auth.uid()
    or exists (
      select 1 from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.user_id = auth.uid()
        and ua.apartment_id = resident_user_links.apartment_id
        and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager')
    )
  )
);

create policy "resident_user_links delete"
on public.resident_user_links for delete
using (
  auth.uid() is not null
  and (
    user_id = auth.uid()
    or exists (
      select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

-- Phase 3.1b — Portal invites (email invitation → auto-link on signup)

create table if not exists public.resident_portal_invites (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  resident_id uuid not null references public.residents(id) on delete cascade,
  email text not null,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'ACCEPTED', 'REVOKED')),
  invited_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (apartment_id, resident_id, email)
);

create index if not exists idx_resident_portal_invites_email
  on public.resident_portal_invites (apartment_id, lower(email), status);

alter table public.resident_portal_invites enable row level security;

drop policy if exists "resident_portal_invites read" on public.resident_portal_invites;
drop policy if exists "resident_portal_invites insert" on public.resident_portal_invites;
drop policy if exists "resident_portal_invites update" on public.resident_portal_invites;
drop policy if exists "resident_portal_invites delete" on public.resident_portal_invites;

create policy "resident_portal_invites read"
on public.resident_portal_invites for select
using (
  auth.uid() is not null
  and (
    lower(email) = lower(coalesce((select email from public.profiles where id = auth.uid()), ''))
    or exists (
      select 1 from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.user_id = auth.uid()
        and ua.apartment_id = resident_portal_invites.apartment_id
        and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager', 'accounts_manager')
    )
  )
);

create policy "resident_portal_invites insert"
on public.resident_portal_invites for insert
with check (
  auth.uid() is not null
  and exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = resident_portal_invites.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager')
  )
);

create policy "resident_portal_invites update"
on public.resident_portal_invites for update
using (
  auth.uid() is not null
  and (
    lower(email) = lower(coalesce((select email from public.profiles where id = auth.uid()), ''))
    or exists (
      select 1 from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.user_id = auth.uid()
        and ua.apartment_id = resident_portal_invites.apartment_id
        and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager')
    )
  )
);

create policy "resident_portal_invites delete"
on public.resident_portal_invites for delete
using (
  auth.uid() is not null
  and exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = resident_portal_invites.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager')
  )
);

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

-- Phase 3.3 — Society notices & circulars

create table if not exists public.society_notices (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  title text not null,
  body text not null,
  priority text not null default 'NORMAL' check (priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  audience text not null default 'ALL' check (audience in ('ALL', 'BLOCKS', 'UNITS')),
  block_filters text[],
  unit_ids uuid[],
  published_at timestamptz,
  expires_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.notice_read_log (
  notice_id uuid not null references public.society_notices(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (notice_id, user_id)
);

create index if not exists idx_society_notices_apartment on public.society_notices (apartment_id, published_at desc);

alter table public.society_notices enable row level security;
alter table public.notice_read_log enable row level security;

drop policy if exists "society_notices read" on public.society_notices;
drop policy if exists "society_notices insert" on public.society_notices;
drop policy if exists "society_notices update" on public.society_notices;
drop policy if exists "society_notices delete" on public.society_notices;
drop policy if exists "society_notices write" on public.society_notices;

create policy "society_notices read"
on public.society_notices for select
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = society_notices.apartment_id
  )
);

create policy "society_notices insert"
on public.society_notices for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = society_notices.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager')
  )
);

create policy "society_notices update"
on public.society_notices for update
using (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = society_notices.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager')
  )
);

create policy "society_notices delete"
on public.society_notices for delete
using (
  exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  )
);

drop policy if exists "notice_read_log read" on public.notice_read_log;
drop policy if exists "notice_read_log insert" on public.notice_read_log;
drop policy if exists "notice_read_log update" on public.notice_read_log;
drop policy if exists "notice_read_log all" on public.notice_read_log;

create policy "notice_read_log read"
on public.notice_read_log for select
using (user_id = auth.uid());

create policy "notice_read_log insert"
on public.notice_read_log for insert
with check (user_id = auth.uid());

create policy "notice_read_log update"
on public.notice_read_log for update
using (user_id = auth.uid());
