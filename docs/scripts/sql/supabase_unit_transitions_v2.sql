-- Move-in / move-out v2 — residing flag + transition payload

alter table public.residents
  add column if not exists is_residing boolean not null default true;

comment on column public.residents.is_residing is
  'For OWNER: true when owner occupies the flat. TENANT rows are active while listed.';

alter table public.unit_transitions
  add column if not exists party_kind text check (party_kind is null or party_kind in ('OWNER', 'TENANT'));

alter table public.unit_transitions
  add column if not exists payload jsonb not null default '{}'::jsonb;
