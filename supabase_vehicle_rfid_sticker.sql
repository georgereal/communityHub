-- Vehicle registry metadata: parking sticker + RFID (for Excel reconcile import/export)
-- Run in Supabase SQL Editor. Safe to re-run.

alter table public.vehicles add column if not exists parking_sticker text;
alter table public.vehicles add column if not exists rfid_tag text;
alter table public.vehicles add column if not exists rfid_number text;
alter table public.vehicles add column if not exists registry_updated_on text;
alter table public.vehicles add column if not exists registry_updated_by text;

comment on column public.vehicles.parking_sticker is 'Parking sticker issued (yes/no/id) from registry import';
comment on column public.vehicles.rfid_tag is 'RFID tag status from registry import';
comment on column public.vehicles.rfid_number is 'RFID hardware id from registry import';
comment on column public.vehicles.registry_updated_on is 'Last registry update date (spreadsheet format, e.g. DD/MM/YY)';
comment on column public.vehicles.registry_updated_by is 'User who last updated registry row';
