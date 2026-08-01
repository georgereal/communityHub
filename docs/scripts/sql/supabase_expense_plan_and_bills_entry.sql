-- Expense plan (one-off + recurring) + staff bills entry permission
-- Run in Supabase SQL Editor after supabase_rbac_v2.sql and supabase_finance_documents.sql

-- ── Permissions & role ──────────────────────────────────────────────────────
insert into public.permissions (key, module, description) values
  ('accounts.bills_entry', 'accounts', 'Add and upload bills & receipts only (no link / delete / float)')
on conflict (key) do nothing;

insert into public.roles (key, scope, label, description) values
  ('office_staff', 'apartment', 'Office Staff', 'Enter bills and receipts; limited finance access')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key) values
  ('office_staff', 'accounts.bills_entry'),
  ('apartment_admin', 'accounts.bills_entry'),
  ('property_manager', 'accounts.bills_entry'),
  ('accounts_manager', 'accounts.bills_entry')
on conflict do nothing;

-- ── Recurring templates ───────────────────────────────────────────────────
create table if not exists public.expense_plan_recurring (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  title text not null,
  amount numeric not null check (amount >= 0),
  cat text,
  sub_category text,
  vendor_name text,
  description text,
  cadence text not null check (cadence in ('monthly', 'quarterly', 'yearly')),
  day_of_month int not null default 1 check (day_of_month between 1 and 28),
  due_day_of_month int check (due_day_of_month is null or due_day_of_month between 1 and 28),
  start_date date not null,
  end_date date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create index if not exists idx_expense_plan_recurring_apt
  on public.expense_plan_recurring (apartment_id, active);

-- ── One-off planned items ─────────────────────────────────────────────────
create table if not exists public.expense_plan_items (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  plan_date date not null,
  due_date date,
  amount numeric not null check (amount >= 0),
  cat text,
  sub_category text,
  vendor_name text,
  description text,
  status text not null default 'planned'
    check (status in ('planned', 'done', 'cancelled')),
  recurring_id uuid references public.expense_plan_recurring(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create index if not exists idx_expense_plan_items_apt_date
  on public.expense_plan_items (apartment_id, plan_date);

create index if not exists idx_expense_plan_items_status
  on public.expense_plan_items (apartment_id, status);

-- Due / complete-by date (additive; safe if tables already exist)
alter table public.expense_plan_items
  add column if not exists due_date date;

alter table public.expense_plan_recurring
  add column if not exists due_day_of_month int check (due_day_of_month is null or due_day_of_month between 1 and 28);

comment on column public.expense_plan_items.due_date is
  'Complete-by / due date for this planned spend (may differ from plan_date).';
comment on column public.expense_plan_recurring.due_day_of_month is
  'Day of month the occurrence is due (defaults to day_of_month when null).';

create index if not exists idx_expense_plan_items_due
  on public.expense_plan_items (apartment_id, due_date);

alter table public.expense_plan_recurring enable row level security;
alter table public.expense_plan_items enable row level security;

drop policy if exists "expense_plan_recurring read" on public.expense_plan_recurring;
create policy "expense_plan_recurring read"
on public.expense_plan_recurring for select
using (
  auth.uid() is not null
  and exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = expense_plan_recurring.apartment_id
  )
);

drop policy if exists "expense_plan_recurring write" on public.expense_plan_recurring;
create policy "expense_plan_recurring write"
on public.expense_plan_recurring for all
using (
  auth.uid() is not null
  and exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = expense_plan_recurring.apartment_id
  )
)
with check (
  auth.uid() is not null
  and exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = expense_plan_recurring.apartment_id
  )
);

drop policy if exists "expense_plan_items read" on public.expense_plan_items;
create policy "expense_plan_items read"
on public.expense_plan_items for select
using (
  auth.uid() is not null
  and exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = expense_plan_items.apartment_id
  )
);

drop policy if exists "expense_plan_items write" on public.expense_plan_items;
create policy "expense_plan_items write"
on public.expense_plan_items for all
using (
  auth.uid() is not null
  and exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = expense_plan_items.apartment_id
  )
)
with check (
  auth.uid() is not null
  and exists (
    select 1 from public.user_apartments ua
    where ua.user_id = auth.uid() and ua.apartment_id = expense_plan_items.apartment_id
  )
);
