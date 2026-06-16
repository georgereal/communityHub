-- Late payment & penalty rules for maintenance invoices
-- Run in Supabase SQL Editor after supabase_maintenance_billing_v2.sql

create table if not exists public.maintenance_penalty_rules (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  name text not null,
  rule_type text not null check (rule_type in (
    'FLAT',
    'PERCENT_OF_DUE',
    'PERCENT_PER_DAY',
    'PERCENT_PER_MONTH',
    'FLAT_AFTER_GRACE'
  )),
  rate numeric(12, 6) not null default 0 check (rate >= 0),
  flat_amount numeric(12, 2) not null default 0 check (flat_amount >= 0),
  grace_days int not null default 0 check (grace_days >= 0),
  max_amount numeric(12, 2) check (max_amount is null or max_amount >= 0),
  min_amount numeric(12, 2) check (min_amount is null or min_amount >= 0),
  target text not null default 'PRIOR_OVERDUE' check (target in ('PRIOR_OVERDUE', 'CURRENT_INVOICE')),
  is_active boolean not null default true,
  sort_order int not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  unique (apartment_id, name)
);

create index if not exists idx_maintenance_penalty_rules_apartment
  on public.maintenance_penalty_rules (apartment_id, is_active, sort_order);

comment on table public.maintenance_penalty_rules is 'Reusable late-fee / penalty rules applied at invoice generation or on overdue invoices';
comment on column public.maintenance_penalty_rules.rule_type is 'FLAT=fixed; PERCENT_OF_DUE=% of balance; PERCENT_PER_DAY=daily %×days; PERCENT_PER_MONTH=monthly %×months; FLAT_AFTER_GRACE=flat after grace_days';
comment on column public.maintenance_penalty_rules.target is 'PRIOR_OVERDUE=balance on older open invoices; CURRENT_INVOICE=amount on invoice being raised';

alter table public.maintenance_invoice_lines
  add column if not exists penalty_rule_id uuid references public.maintenance_penalty_rules(id) on delete set null;

create index if not exists idx_maintenance_invoice_lines_penalty
  on public.maintenance_invoice_lines (penalty_rule_id)
  where penalty_rule_id is not null;

alter table public.maintenance_penalty_rules enable row level security;

drop policy if exists "maintenance_penalty_rules read" on public.maintenance_penalty_rules;
create policy "maintenance_penalty_rules read"
on public.maintenance_penalty_rules for select
using (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_penalty_rules.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);

drop policy if exists "maintenance_penalty_rules insert" on public.maintenance_penalty_rules;
create policy "maintenance_penalty_rules insert"
on public.maintenance_penalty_rules for insert
with check (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_penalty_rules.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);

drop policy if exists "maintenance_penalty_rules update" on public.maintenance_penalty_rules;
create policy "maintenance_penalty_rules update"
on public.maintenance_penalty_rules for update
using (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_penalty_rules.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);

drop policy if exists "maintenance_penalty_rules delete" on public.maintenance_penalty_rules;
create policy "maintenance_penalty_rules delete"
on public.maintenance_penalty_rules for delete
using (
  auth.uid() is not null
  and (
    exists (select 1 from public.user_apartments ua where ua.user_id = auth.uid() and ua.apartment_id = maintenance_penalty_rules.apartment_id)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  )
);
