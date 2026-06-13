-- Extra pool billing calc types: PER_EXTRA_CAR_ALLOCATION / PER_EXTRA_BIKE_ALLOCATION
-- Run in Supabase SQL Editor (safe to re-run)

-- 1. Drop any calc_type check on maintenance_charge_heads (name varies by install)
do $$
declare
  r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'maintenance_charge_heads'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%calc_type%'
  loop
    execute format('alter table public.maintenance_charge_heads drop constraint %I', r.conname);
  end loop;
end $$;

-- 2. Migrate legacy type names before re-adding the check
update public.maintenance_charge_heads
set calc_type = 'PER_EXTRA_CAR_ALLOCATION'
where calc_type in ('PER_EH_ALLOCATION', 'per_extra_car_allocation');

update public.maintenance_charge_heads
set calc_type = 'PER_EXTRA_BIKE_ALLOCATION'
where calc_type in ('PER_BH_ALLOCATION', 'per_extra_bike_allocation');

update public.maintenance_invoice_lines
set calc_type = 'PER_EXTRA_CAR_ALLOCATION'
where calc_type in ('PER_EH_ALLOCATION', 'per_extra_car_allocation');

update public.maintenance_invoice_lines
set calc_type = 'PER_EXTRA_BIKE_ALLOCATION'
where calc_type in ('PER_BH_ALLOCATION', 'per_extra_bike_allocation');

-- 3. Re-create check with full allowed list
alter table public.maintenance_charge_heads
  drop constraint if exists maintenance_charge_heads_calc_type_check;

alter table public.maintenance_charge_heads
  add constraint maintenance_charge_heads_calc_type_check
  check (calc_type in (
    'FLAT',
    'PER_SQFT',
    'PRO_RATA_AREA',
    'MANUAL',
    'PER_CAR_SLOT',
    'PER_BIKE_SLOT',
    'PER_PARKING_SLOT',
    'PER_EXTRA_CAR_ALLOCATION',
    'PER_EXTRA_BIKE_ALLOCATION'
  ));

comment on column public.maintenance_charge_heads.calc_type is
  'FLAT=fixed/flat; PER_SQFT=rate×sqft; PRO_RATA_AREA=split total by sqft; MANUAL=per-flat variable; '
  'PER_CAR_SLOT/PER_BIKE_SLOT/PER_PARKING_SLOT=base slot limits; '
  'PER_EXTRA_CAR_ALLOCATION/PER_EXTRA_BIKE_ALLOCATION=rate×active extra vehicles on EH/BH pool at billing time';
