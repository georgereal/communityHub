-- Society Administrator role + Office Bearer (apartment_admin) without Roles edit
-- Mirrors dentalPractice: SYSTEM_ADMIN / ADMIN / CLINIC_MANAGER
--
-- Tiers:
--   system_admin   — platform (all apartments), bypasses permission checks
--   society_admin  — full society admin including Roles + Society Profile (people & access)
--   apartment_admin — Association Office Bearer: ops admin (bank/vendors/staff), NO rbac.edit
--                     (no Administration → Roles or Society Profile)
--
-- Safe to re-run.

-- 0) Ensure permission keys exist (may not have been seeded on older DBs)
insert into public.permissions (key, module, description) values
  ('vehicle_registry.view', 'vehicle_registry', 'View vehicle registry'),
  ('vehicle_registry.edit', 'vehicle_registry', 'Edit vehicle registry'),
  ('accounts.view', 'accounts', 'View accounts / ledger'),
  ('accounts.edit', 'accounts', 'Edit accounts / ledger'),
  ('accounts.bills_entry', 'accounts', 'Add and upload bills & receipts only'),
  ('setup.view', 'setup', 'View society setup'),
  ('setup.edit', 'setup', 'Edit society setup'),
  ('rbac.view', 'rbac', 'View roles & access'),
  ('rbac.edit', 'rbac', 'Edit roles & access matrix'),
  ('apartment_mgmt.view', 'apartment_mgmt', 'View property & operations'),
  ('apartment_mgmt.edit', 'apartment_mgmt', 'Edit property & operations'),
  ('portal.view', 'portal', 'Access resident portal'),
  ('security.view', 'security', 'Access security gate portal'),
  ('system.apartments.manage', 'system', 'Manage apartments (platform)'),
  ('system.users.manage', 'system', 'Manage users (platform)')
on conflict (key) do nothing;

-- 1) Role row
insert into public.roles (key, scope, label, description)
values (
  'society_admin',
  'apartment',
  'Society Administrator',
  'Full administrator for a society, including Roles & access matrix'
)
on conflict (key) do update set
  scope = excluded.scope,
  label = excluded.label,
  description = excluded.description;

update public.roles
set
  label = 'Association Office Bearer',
  description = 'Operational society admin (no Roles matrix edit) — like Clinic Manager'
where key = 'apartment_admin';

update public.roles
set
  label = 'System Administrator',
  description = 'Platform-wide admin across all societies'
where key = 'system_admin';

-- 2) Society admin — full society permission set (only keys that exist)
insert into public.role_permissions (role_key, permission_key)
select 'society_admin', p.key
from public.permissions p
where p.key in (
  'vehicle_registry.view', 'vehicle_registry.edit',
  'accounts.view', 'accounts.edit', 'accounts.bills_entry',
  'setup.view', 'setup.edit',
  'rbac.view', 'rbac.edit',
  'apartment_mgmt.view', 'apartment_mgmt.edit',
  'portal.view', 'security.view'
)
on conflict do nothing;

-- Also copy any extra apartment_admin perms that may have been added later
insert into public.role_permissions (role_key, permission_key)
select 'society_admin', rp.permission_key
from public.role_permissions rp
where rp.role_key = 'apartment_admin'
on conflict do nothing;

-- Platform-only keys on society_admin only if present
insert into public.role_permissions (role_key, permission_key)
select 'society_admin', p.key
from public.permissions p
where p.key in ('system.apartments.manage', 'system.users.manage')
on conflict do nothing;

-- 3) Office Bearer keeps ops; no Roles / Society Profile (rbac.view|edit)
delete from public.role_permissions
where role_key = 'apartment_admin'
  and permission_key in ('rbac.edit', 'rbac.view');

insert into public.role_permissions (role_key, permission_key)
select 'apartment_admin', p.key
from public.permissions p
where p.key in (
  'accounts.bills_entry',
  'portal.view',
  'security.view'
)
on conflict do nothing;

-- 3b) Office Manager — ops on registry/units only; never setup / Roles / full accounts
delete from public.role_permissions
where role_key = 'property_manager'
  and permission_key in (
    'setup.view', 'setup.edit',
    'rbac.view', 'rbac.edit',
    'accounts.view', 'accounts.edit'
  );

insert into public.role_permissions (role_key, permission_key)
select 'property_manager', p.key
from public.permissions p
where p.key in (
  'vehicle_registry.view', 'vehicle_registry.edit',
  'apartment_mgmt.view', 'apartment_mgmt.edit',
  'portal.view', 'security.view',
  'accounts.bills_entry'
)
on conflict do nothing;

-- 4) Optional: promote existing Office Bearers to society_admin (uncomment if desired)
--
-- insert into public.user_role_assignments (user_id, role_key, scope, apartment_id)
-- select ura.user_id, 'society_admin', ura.scope, ura.apartment_id
-- from public.user_role_assignments ura
-- where ura.role_key = 'apartment_admin' and ura.scope = 'apartment'
-- on conflict do nothing;

-- 5) system_admin still gets every permission key
insert into public.role_permissions (role_key, permission_key)
select 'system_admin', p.key from public.permissions p
on conflict do nothing;
