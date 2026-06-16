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
