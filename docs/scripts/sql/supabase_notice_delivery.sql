-- Notice delivery channels — portal/app alerts, email & SMS outbox

alter table public.society_notices
  add column if not exists delivery_channels jsonb not null
    default '{"portal":true,"email":false,"sms":false}'::jsonb;

alter table public.society_notices
  add column if not exists delivery_summary jsonb;

comment on column public.society_notices.delivery_channels is
  'Keys: portal (notice board + in-app alerts), email, sms';

-- In-app notifications for linked portal users
create table if not exists public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  notice_id uuid references public.society_notices(id) on delete cascade,
  title text not null,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_notifications_user
  on public.user_notifications (user_id, read_at nulls first, created_at desc);

-- SMS queue (processed by Edge Function / provider)
create table if not exists public.sms_outbox (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  recipient_phone text not null,
  body text not null,
  template_key text,
  related_entity_type text,
  related_entity_id uuid,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'SENT', 'FAILED', 'CANCELLED')),
  error_message text,
  sent_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_sms_outbox_apartment on public.sms_outbox (apartment_id, created_at desc);
create index if not exists idx_sms_outbox_pending on public.sms_outbox (status) where status = 'PENDING';

alter table public.user_notifications enable row level security;
alter table public.sms_outbox enable row level security;

drop policy if exists "user_notifications read own" on public.user_notifications;
drop policy if exists "user_notifications insert staff" on public.user_notifications;
drop policy if exists "user_notifications update own" on public.user_notifications;

create policy "user_notifications read own"
on public.user_notifications for select
using (user_id = auth.uid());

create policy "user_notifications insert staff"
on public.user_notifications for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = user_notifications.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager')
  )
);

create policy "user_notifications update own"
on public.user_notifications for update
using (user_id = auth.uid());

drop policy if exists "sms_outbox read" on public.sms_outbox;
drop policy if exists "sms_outbox insert" on public.sms_outbox;
drop policy if exists "sms_outbox update" on public.sms_outbox;

create policy "sms_outbox read"
on public.sms_outbox for select
using (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = sms_outbox.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager', 'accounts_manager')
  )
);

create policy "sms_outbox insert"
on public.sms_outbox for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = sms_outbox.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager', 'accounts_manager')
  )
);

create policy "sms_outbox update"
on public.sms_outbox for update
using (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = sms_outbox.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager', 'accounts_manager')
  )
);
