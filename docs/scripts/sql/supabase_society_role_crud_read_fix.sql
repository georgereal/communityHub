-- Allow any society member to READ role CRUD / module matrices.
-- Previously SELECT required rbac.view/edit, so Office Bearers could not load
-- their own Finance delete restrictions and the UI fell back to accounts.edit.
-- Write policies remain rbac.edit / admin only.

drop policy if exists "society_role_crud_access read" on public.society_role_crud_access;
create policy "society_role_crud_access read"
on public.society_role_crud_access for select
using (public.can_access_apartment(apartment_id));

drop policy if exists "society_role_module_access read" on public.society_role_module_access;
create policy "society_role_module_access read"
on public.society_role_module_access for select
using (public.can_access_apartment(apartment_id));
