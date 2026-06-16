-- Phase 6.5 — Email outbox (Edge Function / Resend processes queue)

create table if not exists public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  recipient_email text not null,
  subject text not null,
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

create index if not exists idx_email_outbox_apartment on public.email_outbox (apartment_id, created_at desc);
create index if not exists idx_email_outbox_pending on public.email_outbox (status) where status = 'PENDING';

alter table public.email_outbox enable row level security;

drop policy if exists "email_outbox read" on public.email_outbox;
drop policy if exists "email_outbox insert" on public.email_outbox;
drop policy if exists "email_outbox update" on public.email_outbox;
drop policy if exists "email_outbox write" on public.email_outbox;

create policy "email_outbox read"
on public.email_outbox for select
using (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = email_outbox.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager', 'accounts_manager')
  )
);

create policy "email_outbox insert"
on public.email_outbox for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = email_outbox.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager', 'accounts_manager')
  )
);

create policy "email_outbox update"
on public.email_outbox for update
using (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = email_outbox.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager', 'accounts_manager')
  )
);
