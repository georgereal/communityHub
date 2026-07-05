-- Bank statement line classification rules (run in Supabase SQL Editor)
-- Maps description text patterns to income/expense categories per apartment.

create table if not exists public.bank_classification_rules (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  line_type text not null check (line_type in ('IN', 'OUT')),
  description_match text not null,
  category text not null,
  sub_category text,
  vendor_name text,
  priority int not null default 0,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_bank_classification_rules_apartment
  on public.bank_classification_rules (apartment_id, line_type, enabled);

comment on table public.bank_classification_rules is
  'User-defined rules: when a statement line description contains description_match, suggest category/vendor';

alter table public.bank_classification_rules enable row level security;

drop policy if exists "bank_classification_rules read" on public.bank_classification_rules;
create policy "bank_classification_rules read"
on public.bank_classification_rules for select
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = bank_classification_rules.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "bank_classification_rules insert" on public.bank_classification_rules;
create policy "bank_classification_rules insert"
on public.bank_classification_rules for insert
with check (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = bank_classification_rules.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "bank_classification_rules update" on public.bank_classification_rules;
create policy "bank_classification_rules update"
on public.bank_classification_rules for update
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = bank_classification_rules.apartment_id
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
      where ua.user_id = auth.uid() and ua.apartment_id = bank_classification_rules.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "bank_classification_rules delete" on public.bank_classification_rules;
create policy "bank_classification_rules delete"
on public.bank_classification_rules for delete
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = bank_classification_rules.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);
