-- Expense vendor + sub-category reference tables (run in Supabase SQL Editor)
-- Standalone RLS: works without supabase_rls_operational.sql

create table if not exists public.expense_vendors (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  name text not null,
  contact_phone text,
  contact_email text,
  notes text,
  use_count int not null default 1,
  last_used_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (apartment_id, name)
);

create index if not exists idx_expense_vendors_apartment on public.expense_vendors (apartment_id);
create index if not exists idx_expense_vendors_last_used on public.expense_vendors (apartment_id, last_used_at desc);

create table if not exists public.expense_sub_categories (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  category text not null,
  name text not null,
  use_count int not null default 1,
  last_used_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (apartment_id, category, name)
);

create index if not exists idx_expense_sub_categories_apartment on public.expense_sub_categories (apartment_id, category);

comment on table public.expense_vendors is 'Autocomplete cache of vendors/payees per apartment';
comment on table public.expense_sub_categories is 'Autocomplete cache of sub-categories per expense category';

-- Backfill vendors from existing expense transactions
insert into public.expense_vendors (apartment_id, name, use_count, last_used_at)
select apartment_id, trim(vendor_name), count(*)::int, max(date)
from public.transactions
where type = 'OUT'
  and vendor_name is not null
  and trim(vendor_name) <> ''
group by apartment_id, trim(vendor_name)
on conflict (apartment_id, name) do update
set use_count = public.expense_vendors.use_count + excluded.use_count,
    last_used_at = greatest(public.expense_vendors.last_used_at, excluded.last_used_at);

-- Backfill sub-categories from existing expense transactions
insert into public.expense_sub_categories (apartment_id, category, name, use_count, last_used_at)
select apartment_id, cat, trim(sub_category), count(*)::int, max(date)
from public.transactions
where type = 'OUT'
  and sub_category is not null
  and trim(sub_category) <> ''
group by apartment_id, cat, trim(sub_category)
on conflict (apartment_id, category, name) do update
set use_count = public.expense_sub_categories.use_count + excluded.use_count,
    last_used_at = greatest(public.expense_sub_categories.last_used_at, excluded.last_used_at);

alter table public.expense_vendors enable row level security;
alter table public.expense_sub_categories enable row level security;

-- expense_vendors policies
drop policy if exists "expense_vendors read" on public.expense_vendors;
create policy "expense_vendors read"
on public.expense_vendors for select
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = expense_vendors.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "expense_vendors write" on public.expense_vendors;
create policy "expense_vendors insert"
on public.expense_vendors for insert
with check (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = expense_vendors.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

create policy "expense_vendors update"
on public.expense_vendors for update
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = expense_vendors.apartment_id
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
      where ua.user_id = auth.uid() and ua.apartment_id = expense_vendors.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

-- expense_sub_categories policies
drop policy if exists "expense_sub_categories read" on public.expense_sub_categories;
create policy "expense_sub_categories read"
on public.expense_sub_categories for select
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = expense_sub_categories.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "expense_sub_categories write" on public.expense_sub_categories;
create policy "expense_sub_categories insert"
on public.expense_sub_categories for insert
with check (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = expense_sub_categories.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

create policy "expense_sub_categories update"
on public.expense_sub_categories for update
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = expense_sub_categories.apartment_id
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
      where ua.user_id = auth.uid() and ua.apartment_id = expense_sub_categories.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);
