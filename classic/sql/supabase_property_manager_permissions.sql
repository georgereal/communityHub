-- Property Manager (Office Manager): operational access only (no society admin / setup screens).
-- Run in Supabase SQL Editor after supabase_rbac_v2.sql (or re-run supabase_society_admin_role.sql).

delete from public.role_permissions
where role_key = 'property_manager'
  and permission_key in (
    'setup.view', 'setup.edit',
    'rbac.view', 'rbac.edit',
    'accounts.view', 'accounts.edit'
  );

insert into public.role_permissions (role_key, permission_key) values
  ('property_manager', 'vehicle_registry.view'),
  ('property_manager', 'vehicle_registry.edit'),
  ('property_manager', 'apartment_mgmt.view'),
  ('property_manager', 'apartment_mgmt.edit'),
  ('property_manager', 'portal.view'),
  ('property_manager', 'security.view'),
  ('property_manager', 'accounts.bills_entry')
on conflict do nothing;

-- Align v1 profile.role fallback with v2 property_manager (no setup/rbac)
create or replace function public.v1_role_has_perm(role text, perm text)
returns boolean
language sql
immutable
as $$
  select case coalesce(role, 'resident_viewer')
    when 'admin' then true
    when 'property_manager' then perm in (
      'vehicle_registry.view', 'vehicle_registry.edit',
      'apartment_mgmt.view', 'apartment_mgmt.edit'
    )
    when 'accounts_manager' then perm in (
      'accounts.view', 'accounts.edit', 'apartment_mgmt.view'
    )
    when 'security' then perm in (
      'vehicle_registry.view', 'vehicle_registry.edit'
    )
    when 'resident_viewer' then perm in (
      'vehicle_registry.view', 'accounts.view', 'apartment_mgmt.view'
    )
    else false
  end;
$$;
