-- Phase 3.1 — Resident portal user links (standalone RLS)

create table if not exists public.resident_user_links (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  resident_id uuid not null references public.residents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (apartment_id, user_id, resident_id)
);

create index if not exists idx_resident_user_links_user on public.resident_user_links (user_id);
create index if not exists idx_resident_user_links_resident on public.resident_user_links (resident_id);

alter table public.resident_user_links enable row level security;

drop policy if exists "resident_user_links read" on public.resident_user_links;
drop policy if exists "resident_user_links insert" on public.resident_user_links;
drop policy if exists "resident_user_links update" on public.resident_user_links;
drop policy if exists "resident_user_links delete" on public.resident_user_links;
drop policy if exists "resident_user_links write" on public.resident_user_links;

create policy "resident_user_links read"
on public.resident_user_links for select
using (
  auth.uid() is not null
  and (
    user_id = auth.uid()
    or exists (
      select 1 from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.user_id = auth.uid()
        and ua.apartment_id = resident_user_links.apartment_id
        and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager', 'accounts_manager')
    )
  )
);

create policy "resident_user_links insert"
on public.resident_user_links for insert
with check (
  auth.uid() is not null
  and (
    user_id = auth.uid()
    or exists (
      select 1 from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.user_id = auth.uid()
        and ua.apartment_id = resident_user_links.apartment_id
        and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager')
    )
  )
);

create policy "resident_user_links delete"
on public.resident_user_links for delete
using (
  auth.uid() is not null
  and (
    user_id = auth.uid()
    or exists (
      select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
    )
  )
);
