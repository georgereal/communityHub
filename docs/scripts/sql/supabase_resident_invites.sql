-- Phase 3.1b — Portal invites (email invitation → auto-link on signup)

create table if not exists public.resident_portal_invites (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  resident_id uuid not null references public.residents(id) on delete cascade,
  email text not null,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'ACCEPTED', 'REVOKED')),
  invited_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (apartment_id, resident_id, email)
);

create index if not exists idx_resident_portal_invites_email
  on public.resident_portal_invites (apartment_id, lower(email), status);

alter table public.resident_portal_invites enable row level security;

drop policy if exists "resident_portal_invites read" on public.resident_portal_invites;
drop policy if exists "resident_portal_invites insert" on public.resident_portal_invites;
drop policy if exists "resident_portal_invites update" on public.resident_portal_invites;
drop policy if exists "resident_portal_invites delete" on public.resident_portal_invites;

create policy "resident_portal_invites read"
on public.resident_portal_invites for select
using (
  auth.uid() is not null
  and (
    lower(email) = lower(coalesce((select email from public.profiles where id = auth.uid()), ''))
    or exists (
      select 1 from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.user_id = auth.uid()
        and ua.apartment_id = resident_portal_invites.apartment_id
        and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager', 'accounts_manager')
    )
  )
);

create policy "resident_portal_invites insert"
on public.resident_portal_invites for insert
with check (
  auth.uid() is not null
  and exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = resident_portal_invites.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager')
  )
);

create policy "resident_portal_invites update"
on public.resident_portal_invites for update
using (
  auth.uid() is not null
  and (
    lower(email) = lower(coalesce((select email from public.profiles where id = auth.uid()), ''))
    or exists (
      select 1 from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.user_id = auth.uid()
        and ua.apartment_id = resident_portal_invites.apartment_id
        and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager')
    )
  )
);

create policy "resident_portal_invites delete"
on public.resident_portal_invites for delete
using (
  auth.uid() is not null
  and exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = resident_portal_invites.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager')
  )
);
