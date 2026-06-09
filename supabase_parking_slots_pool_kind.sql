-- Community pool slot kinds: car (EH-*) and bike (BH-*)
-- Run in Supabase SQL Editor. Safe to re-run.

alter table public.parking_slots add column if not exists pool_kind text;

update public.parking_slots
set pool_kind = 'bike'
where pool_kind is null
  and name ~* '^BH-?[0-9]+$';

update public.parking_slots
set pool_kind = 'car'
where pool_kind is null
  and name ~* '^EH-?[0-9]+$';

update public.parking_slots
set pool_kind = 'car'
where pool_kind is null;

alter table public.parking_slots alter column pool_kind set default 'car';

comment on column public.parking_slots.pool_kind is 'car = EH community car pool, bike = BH community bike pool';
