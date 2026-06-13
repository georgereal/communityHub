-- Unit directory fields for bulk Excel update
-- Run in Supabase SQL Editor (safe to re-run)

alter table public.units add column if not exists block text;
alter table public.units add column if not exists bhk text;
alter table public.units add column if not exists notes text;
alter table public.units add column if not exists area_sqft numeric(10, 2) check (area_sqft is null or area_sqft >= 0);
alter table public.units add column if not exists occupancy_status text;

-- Normalize constraint if re-running
alter table public.units drop constraint if exists units_occupancy_status_check;
alter table public.units add constraint units_occupancy_status_check
  check (occupancy_status is null or occupancy_status in (
    'OWNER_OCCUPIED',
    'TENANT_OCCUPIED',
    'VACANT',
    'UNDER_RENOVATION',
    'LOCKED',
    'DEVELOPER_HOLD'
  ));

comment on column public.units.block is 'Block/tower label (optional; can be derived from unit number)';
comment on column public.units.bhk is 'Unit type e.g. 2BHK, 3BHK';
comment on column public.units.notes is 'Internal notes for this flat';
comment on column public.units.area_sqft is 'Carpet/super built-up area in sq ft';
comment on column public.units.occupancy_status is 'OWNER_OCCUPIED | TENANT_OCCUPIED | VACANT | UNDER_RENOVATION | LOCKED | DEVELOPER_HOLD';
