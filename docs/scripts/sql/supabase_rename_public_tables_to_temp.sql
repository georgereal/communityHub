-- =============================================================================
-- Rename all public tables → {name}_temp (break-glass probe for New vs Supabase)
-- =============================================================================
-- Purpose:
--   After New (Mongo) cutover, rename Postgres tables so any leftover
--   PostgREST / supabase.from('…') / RPC that still expects the old name fails
--   loudly. Use that to find remaining Classic/Supabase dependencies.
--
-- Scope:
--   - public BASE TABLES only (not views, not auth/storage schemas)
--   - skips names that already end with _temp
--   - skips names that would exceed Postgres' 63-char identifier limit
--
-- Auth:
--   auth.* (users, sessions) is NOT touched — Supabase Auth keeps working.
--   By default we KEEP a small public identity set so JWT → apartment checks
--   still resolve. Empty keep_tables to rename those too (login/RBAC will break).
--
-- Run in: Supabase SQL Editor (service role / postgres). Prefer a staging project.
-- ALWAYS run Section A (preview) first. Keep Section C (rollback) handy.
--
-- Related: docs/ARCHITECTURE_NEW.md · npm run migrate:*-mongo
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) PREVIEW — what would be renamed
-- -----------------------------------------------------------------------------
with keep as (
  select unnest(array[
    -- Identity / membership still used by packages/server serverAuth (edit freely)
    'apartments',
    'profiles',
    'user_apartments',
    'permissions',
    'roles',
    'role_permissions',
    'user_role_assignments',
    'society_role_permissions',
    'society_user_permission_overrides',
    'apartment_module_settings',
    'apartment_page_access'
  ]::text[]) as name
),
candidates as (
  select c.relname as table_name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'  -- ordinary table
    and c.relname not like '%\_temp' escape '\'
    and not exists (select 1 from keep k where k.name = c.relname)
)
select
  table_name as current_name,
  (table_name || '_temp') as new_name,
  case
    when char_length(table_name || '_temp') > 63 then 'SKIP — name too long'
    else 'RENAME'
  end as action
from candidates
order by 1;

-- -----------------------------------------------------------------------------
-- B) APPLY — rename public.* → public.*_temp
-- -----------------------------------------------------------------------------
-- Uncomment the DO block below after reviewing the preview.
-- Set keep_tables := array[]::text[] to rename identity tables as well.

/*
do $$
declare
  keep_tables text[] := array[
    'apartments',
    'profiles',
    'user_apartments',
    'permissions',
    'roles',
    'role_permissions',
    'user_role_assignments',
    'society_role_permissions',
    'society_user_permission_overrides',
    'apartment_module_settings',
    'apartment_page_access'
  ];
  r record;
  new_name text;
  renamed int := 0;
  skipped int := 0;
begin
  for r in
    select c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname not like '%\_temp' escape '\'
      and not (c.relname = any (keep_tables))
    order by c.relname
  loop
    new_name := r.table_name || '_temp';
    if char_length(new_name) > 63 then
      raise warning 'skip %.% — renamed identifier would exceed 63 chars (%)',
        'public', r.table_name, new_name;
      skipped := skipped + 1;
      continue;
    end if;
    execute format('alter table public.%I rename to %I', r.table_name, new_name);
    raise notice 'renamed public.% → public.%', r.table_name, new_name;
    renamed := renamed + 1;
  end loop;

  raise notice 'done: renamed %, skipped %', renamed, skipped;
end $$;
*/

-- -----------------------------------------------------------------------------
-- C) ROLLBACK — rename public.*_temp → public.* (strip trailing _temp)
-- -----------------------------------------------------------------------------
-- Only restores names that currently end in _temp and whose restored name
-- does not already exist.

/*
do $$
declare
  r record;
  old_name text;
  restored int := 0;
  skipped int := 0;
begin
  for r in
    select c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname like '%\_temp' escape '\'
    order by c.relname
  loop
    old_name := left(r.table_name, greatest(char_length(r.table_name) - 5, 0));
    if old_name = '' or old_name = r.table_name then
      raise warning 'skip public.% — could not derive original name', r.table_name;
      skipped := skipped + 1;
      continue;
    end if;
    if to_regclass(format('public.%I', old_name)) is not null then
      raise warning 'skip public.% → % — target already exists', r.table_name, old_name;
      skipped := skipped + 1;
      continue;
    end if;
    execute format('alter table public.%I rename to %I', r.table_name, old_name);
    raise notice 'restored public.% → public.%', r.table_name, old_name;
    restored := restored + 1;
  end loop;

  raise notice 'done: restored %, skipped %', restored, skipped;
end $$;
*/

-- -----------------------------------------------------------------------------
-- D) OPTIONAL — also list public views (not renamed by this script)
-- -----------------------------------------------------------------------------
-- Views keep working after base-table rename (Postgres rewrites the def).
-- If you also want to hide views from PostgREST, drop or rename them separately.
select schemaname, viewname
from pg_catalog.pg_views
where schemaname = 'public'
order by 1, 2;
