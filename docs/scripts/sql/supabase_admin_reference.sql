-- Admin reference data: society bank account + staff directory
-- Run in Supabase SQL Editor (standalone RLS)

create table if not exists public.apartment_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null unique,
  bank_name text not null,
  branch text,
  account_holder text,
  account_number text,
  ifsc text,
  upi_id text,
  notes text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_apartment_bank_accounts_apartment on public.apartment_bank_accounts (apartment_id);

comment on table public.apartment_bank_accounts is 'Primary society bank account details for payments and reconciliation';

create table if not exists public.staff_members (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  full_name text not null,
  role_title text not null,
  phone text,
  email text,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_staff_members_apartment on public.staff_members (apartment_id);
create index if not exists idx_staff_members_active on public.staff_members (apartment_id, active);

comment on table public.staff_members is 'Non-resident staff directory (guards, housekeeping, managers, etc.)';

-- Delete policies for expense reference tables (admin cleanup)
drop policy if exists "expense_vendors delete" on public.expense_vendors;
create policy "expense_vendors delete"
on public.expense_vendors for delete
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

drop policy if exists "expense_sub_categories delete" on public.expense_sub_categories;
create policy "expense_sub_categories delete"
on public.expense_sub_categories for delete
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

alter table public.apartment_bank_accounts enable row level security;
alter table public.staff_members enable row level security;

-- apartment_bank_accounts policies
drop policy if exists "apartment_bank_accounts read" on public.apartment_bank_accounts;
create policy "apartment_bank_accounts read"
on public.apartment_bank_accounts for select
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = apartment_bank_accounts.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "apartment_bank_accounts write" on public.apartment_bank_accounts;
create policy "apartment_bank_accounts insert"
on public.apartment_bank_accounts for insert
with check (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = apartment_bank_accounts.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

create policy "apartment_bank_accounts update"
on public.apartment_bank_accounts for update
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = apartment_bank_accounts.apartment_id
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
      where ua.user_id = auth.uid() and ua.apartment_id = apartment_bank_accounts.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

create policy "apartment_bank_accounts delete"
on public.apartment_bank_accounts for delete
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = apartment_bank_accounts.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

-- staff_members policies
drop policy if exists "staff_members read" on public.staff_members;
create policy "staff_members read"
on public.staff_members for select
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = staff_members.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "staff_members write" on public.staff_members;
create policy "staff_members insert"
on public.staff_members for insert
with check (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = staff_members.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

create policy "staff_members update"
on public.staff_members for update
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = staff_members.apartment_id
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
      where ua.user_id = auth.uid() and ua.apartment_id = staff_members.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

create policy "staff_members delete"
on public.staff_members for delete
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = staff_members.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);
