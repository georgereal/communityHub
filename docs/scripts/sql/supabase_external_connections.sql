-- Per-society external API connections (Evolyx passbook OCR, etc.)
-- API keys are stored in DB; server routes read them using the caller's session (RLS).

create table if not exists public.apartment_external_connections (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  provider text not null check (provider in ('EVOLYX')),
  connection_key text not null,
  display_name text,
  base_url text not null,
  client_id text,
  api_key text,
  api_key_set boolean not null default false,
  workflow_id text,
  config jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  configured_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (apartment_id, provider, connection_key)
);

create index if not exists idx_external_connections_apartment
  on public.apartment_external_connections (apartment_id, provider);

alter table public.apartment_external_connections enable row level security;

drop policy if exists "external_connections read" on public.apartment_external_connections;
create policy "external_connections read"
on public.apartment_external_connections for select
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.user_id = auth.uid()
        and ua.apartment_id = apartment_external_connections.apartment_id
        and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "external_connections write" on public.apartment_external_connections;
create policy "external_connections write"
on public.apartment_external_connections for all
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.user_id = auth.uid()
        and ua.apartment_id = apartment_external_connections.apartment_id
        and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
)
with check (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.user_id = auth.uid()
        and ua.apartment_id = apartment_external_connections.apartment_id
        and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

comment on table public.apartment_external_connections is
  'Society-specific external API credentials (Evolyx OCR, etc.). API keys are never returned to the browser in list queries.';
