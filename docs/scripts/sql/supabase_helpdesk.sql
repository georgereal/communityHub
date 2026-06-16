-- Phase 4.1 — Helpdesk / complaints

create table if not exists public.helpdesk_tickets (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  unit_id uuid references public.units(id) on delete set null,
  category text not null,
  subject text not null,
  description text,
  status text not null default 'OPEN'
    check (status in ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED')),
  priority text not null default 'NORMAL',
  assigned_to uuid references public.staff_members(id) on delete set null,
  sla_due_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists idx_helpdesk_tickets_apartment on public.helpdesk_tickets (apartment_id, created_at desc);
create index if not exists idx_helpdesk_tickets_status on public.helpdesk_tickets (apartment_id, status);

alter table public.helpdesk_tickets enable row level security;

drop policy if exists "helpdesk_tickets read" on public.helpdesk_tickets;
drop policy if exists "helpdesk_tickets insert" on public.helpdesk_tickets;
drop policy if exists "helpdesk_tickets update" on public.helpdesk_tickets;
drop policy if exists "helpdesk_tickets write" on public.helpdesk_tickets;

create policy "helpdesk_tickets read"
on public.helpdesk_tickets for select
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = helpdesk_tickets.apartment_id
  )
);

create policy "helpdesk_tickets insert"
on public.helpdesk_tickets for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = helpdesk_tickets.apartment_id
  )
);

create policy "helpdesk_tickets update"
on public.helpdesk_tickets for update
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = helpdesk_tickets.apartment_id
  )
);
