-- Tenant scoping migration + backfill to Elixir Heights
-- Apartment ID: ce6275d5-11cb-4a03-9cf6-3d4a7efb759e

-- 1) Add apartment_id columns (if missing)
alter table public.units add column if not exists apartment_id uuid;
alter table public.vehicles add column if not exists apartment_id uuid;
alter table public.transactions add column if not exists apartment_id uuid;
alter table public.parking_slots add column if not exists apartment_id uuid;
alter table public.society_config add column if not exists apartment_id uuid;

-- 2) Backfill existing rows to Elixir Heights (only where null)
update public.units set apartment_id = 'ce6275d5-11cb-4a03-9cf6-3d4a7efb759e' where apartment_id is null;
update public.vehicles set apartment_id = 'ce6275d5-11cb-4a03-9cf6-3d4a7efb759e' where apartment_id is null;
update public.transactions set apartment_id = 'ce6275d5-11cb-4a03-9cf6-3d4a7efb759e' where apartment_id is null;
update public.parking_slots set apartment_id = 'ce6275d5-11cb-4a03-9cf6-3d4a7efb759e' where apartment_id is null;

-- society_config: ensure exactly one per apartment (move existing singleton to Elixir)
update public.society_config set apartment_id = 'ce6275d5-11cb-4a03-9cf6-3d4a7efb759e' where apartment_id is null;

-- 3) Recommended constraints/indexes (optional but strongly recommended)
create index if not exists idx_units_apartment on public.units(apartment_id);
create index if not exists idx_vehicles_apartment on public.vehicles(apartment_id);
create index if not exists idx_transactions_apartment on public.transactions(apartment_id);
create index if not exists idx_parking_slots_apartment on public.parking_slots(apartment_id);
create index if not exists idx_society_config_apartment on public.society_config(apartment_id);

-- Ensure society_config unique per apartment
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'society_config_apartment_unique'
      and conrelid = 'public.society_config'::regclass
  ) then
    alter table public.society_config add constraint society_config_apartment_unique unique (apartment_id);
  end if;
exception when undefined_table then
  null;
end $$;

