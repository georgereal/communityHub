-- Phase 4.7 — Staff attendance & payroll

create table if not exists public.staff_attendance (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  staff_id uuid not null references public.staff_members(id) on delete cascade,
  work_date date not null,
  status text not null check (status in ('PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE')),
  unique (staff_id, work_date)
);

create table if not exists public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  period_label text not null,
  total_amount numeric(12, 2),
  transaction_id uuid references public.transactions(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_staff_attendance_staff on public.staff_attendance (staff_id, work_date desc);

alter table public.staff_attendance enable row level security;
alter table public.payroll_runs enable row level security;

drop policy if exists "staff_attendance read" on public.staff_attendance;
drop policy if exists "staff_attendance insert" on public.staff_attendance;
drop policy if exists "staff_attendance update" on public.staff_attendance;
drop policy if exists "staff_attendance write" on public.staff_attendance;

create policy "staff_attendance read"
on public.staff_attendance for select
using (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = staff_attendance.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager', 'property_manager')
  )
);

create policy "staff_attendance insert"
on public.staff_attendance for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = staff_attendance.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
  )
);

create policy "staff_attendance update"
on public.staff_attendance for update
using (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = staff_attendance.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
  )
);

drop policy if exists "payroll_runs read" on public.payroll_runs;
drop policy if exists "payroll_runs insert" on public.payroll_runs;
drop policy if exists "payroll_runs write" on public.payroll_runs;

create policy "payroll_runs read"
on public.payroll_runs for select
using (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = payroll_runs.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
  )
);

create policy "payroll_runs insert"
on public.payroll_runs for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = payroll_runs.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
  )
);
