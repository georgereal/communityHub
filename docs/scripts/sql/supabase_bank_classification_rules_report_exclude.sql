-- Add report-exclusion flag to bank classification rules.
-- Run after supabase_bank_classification_rules.sql

alter table public.bank_classification_rules
  add column if not exists exclude_from_reports boolean not null default false;

comment on column public.bank_classification_rules.exclude_from_reports is
  'When true, transactions posted via this rule are excluded from Financial Reports';
