-- Unified residents optional fields
-- Run in Supabase SQL Editor after supabase_rbac_v2.sql

alter table public.residents
  add column if not exists is_primary boolean not null default false;

comment on column public.residents.is_primary is 'Primary contact for billing/notices on this flat';
