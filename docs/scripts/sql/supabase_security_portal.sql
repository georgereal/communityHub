-- Security gate portal permission (RBAC v2 supplement)
-- Run after supabase_rbac_v2.sql

insert into public.permissions (key, module, description) values
  ('security.view', 'security', 'Access security gate portal (visitor log, parcels)')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key) values
  ('apartment_admin', 'security.view'),
  ('property_manager', 'security.view'),
  ('security', 'security.view')
on conflict do nothing;

-- portal.view for residents (if not already seeded elsewhere)
insert into public.permissions (key, module, description) values
  ('portal.view', 'portal', 'Access resident portal')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key) values
  ('resident_viewer', 'portal.view')
on conflict do nothing;
