-- Payment reminder log for overdue invoices
-- Run in Supabase SQL Editor after supabase_maintenance_billing.sql

create table if not exists public.maintenance_reminder_log (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  invoice_id uuid not null references public.maintenance_invoices(id) on delete cascade,
  channel text not null check (channel in ('EMAIL', 'PDF', 'MANUAL')),
  reminder_type text not null default 'OVERDUE' check (reminder_type in ('OVERDUE', 'DUE_SOON')),
  days_overdue int,
  sent_to_email text,
  sent_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_maintenance_reminder_log_invoice
  on public.maintenance_reminder_log (invoice_id, created_at desc);

create index if not exists idx_maintenance_reminder_log_apartment
  on public.maintenance_reminder_log (apartment_id, created_at desc);

alter table public.maintenance_reminder_log enable row level security;

drop policy if exists "maintenance_reminder_log read" on public.maintenance_reminder_log;
create policy "maintenance_reminder_log read"
on public.maintenance_reminder_log for select
using (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_reminder_log.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);

drop policy if exists "maintenance_reminder_log insert" on public.maintenance_reminder_log;
create policy "maintenance_reminder_log insert"
on public.maintenance_reminder_log for insert
with check (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_reminder_log.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);
