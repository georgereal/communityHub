-- Phase 4.3 — Document vault per flat

create table if not exists public.unit_documents (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  doc_type text not null check (doc_type in ('SALE_DEED', 'RENTAL_AGREEMENT', 'ID', 'NOC', 'OTHER')),
  title text not null,
  file_path text not null,
  expires_at date,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_unit_documents_unit on public.unit_documents (unit_id, created_at desc);

alter table public.unit_documents enable row level security;

drop policy if exists "unit_documents read" on public.unit_documents;
drop policy if exists "unit_documents insert" on public.unit_documents;
drop policy if exists "unit_documents delete" on public.unit_documents;
drop policy if exists "unit_documents write" on public.unit_documents;

create policy "unit_documents read"
on public.unit_documents for select
using (
  exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = unit_documents.apartment_id
  )
);

create policy "unit_documents insert"
on public.unit_documents for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = unit_documents.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager', 'accounts_manager')
  )
);

create policy "unit_documents delete"
on public.unit_documents for delete
using (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = unit_documents.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager')
  )
);
