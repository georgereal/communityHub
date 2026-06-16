-- Phase 4.5 — Amenity booking

create table if not exists public.amenities (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  name text not null,
  slot_duration_minutes int not null default 60,
  max_hours_per_month int,
  fee_amount numeric(12, 2) default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.amenity_bookings (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  amenity_id uuid not null references public.amenities(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'CONFIRMED' check (status in ('CONFIRMED', 'CANCELLED')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_amenity_bookings_apartment on public.amenity_bookings (apartment_id, starts_at);

alter table public.amenities enable row level security;
alter table public.amenity_bookings enable row level security;

drop policy if exists "amenities read" on public.amenities;
drop policy if exists "amenities insert" on public.amenities;
drop policy if exists "amenities update" on public.amenities;
drop policy if exists "amenities write" on public.amenities;

create policy "amenities read"
on public.amenities for select
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = amenities.apartment_id
  )
);

create policy "amenities insert"
on public.amenities for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = amenities.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager')
  )
);

create policy "amenities update"
on public.amenities for update
using (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = amenities.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager')
  )
);

drop policy if exists "amenity_bookings read" on public.amenity_bookings;
drop policy if exists "amenity_bookings insert" on public.amenity_bookings;
drop policy if exists "amenity_bookings update" on public.amenity_bookings;
drop policy if exists "amenity_bookings write" on public.amenity_bookings;

create policy "amenity_bookings read"
on public.amenity_bookings for select
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = amenity_bookings.apartment_id
  )
);

create policy "amenity_bookings insert"
on public.amenity_bookings for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = amenity_bookings.apartment_id
  )
);

create policy "amenity_bookings update"
on public.amenity_bookings for update
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = amenity_bookings.apartment_id
  )
);
