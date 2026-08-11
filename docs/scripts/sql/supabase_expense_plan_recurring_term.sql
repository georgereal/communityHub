-- Recurring expense plan: fixed term + total/manual period amounts
-- Run in Supabase SQL Editor after supabase_expense_plan_and_bills_entry.sql

alter table public.expense_plan_recurring
  add column if not exists term_count int
    check (term_count is null or term_count >= 1);

alter table public.expense_plan_recurring
  add column if not exists amount_mode text not null default 'per_period'
    check (amount_mode in ('per_period', 'total_split', 'manual'));

alter table public.expense_plan_recurring
  add column if not exists total_amount numeric
    check (total_amount is null or total_amount >= 0);

alter table public.expense_plan_recurring
  add column if not exists period_amounts jsonb;

comment on column public.expense_plan_recurring.term_count is
  'Number of occurrences in the term (null = ongoing until end_date or forever).';
comment on column public.expense_plan_recurring.amount_mode is
  'per_period = same amount each time; total_split = total_amount ÷ term; manual = period_amounts[].';
comment on column public.expense_plan_recurring.total_amount is
  'Total across the term when amount_mode is total_split (or informational for manual).';
comment on column public.expense_plan_recurring.period_amounts is
  'JSON array of per-occurrence amounts (manual / total_split). Index 0 = first occurrence.';
