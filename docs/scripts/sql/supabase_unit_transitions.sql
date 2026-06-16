-- Phase 4.2 — Move-in / move-out checklist

create table if not exists public.unit_transitions (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  transition_type text not null check (transition_type in ('MOVE_IN', 'MOVE_OUT')),
  status text not null default 'IN_PROGRESS'
    check (status in ('IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  checklist jsonb not null default '{}'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_unit_transitions_apartment on public.unit_transitions (apartment_id, created_at desc);

alter table public.unit_transitions enable row level security;

drop policy if exists "unit_transitions read" on public.unit_transitions;
drop policy if exists "unit_transitions insert" on public.unit_transitions;
drop policy if exists "unit_transitions update" on public.unit_transitions;
drop policy if exists "unit_transitions write" on public.unit_transitions;

create policy "unit_transitions read"
on public.unit_transitions for select
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = unit_transitions.apartment_id
  )
);

create policy "unit_transitions insert"
on public.unit_transitions for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = unit_transitions.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager')
  )
);

create policy "unit_transitions update"
on public.unit_transitions for update
using (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = unit_transitions.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager')
  )
);
