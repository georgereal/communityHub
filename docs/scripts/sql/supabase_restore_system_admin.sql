-- Restore platform super-admin (system_admin) for a user by email.
-- Super admin is NOT stored in profiles.role — it lives in user_role_assignments
-- with scope = 'system' and role_key = 'system_admin'.

-- 1) Inspect current state
select u.id, u.email, p.role as profile_role
from auth.users u
left join public.profiles p on p.id = u.id
where lower(u.email) = lower('george.renju@gmail.com');

select ura.*
from public.user_role_assignments ura
join auth.users u on u.id = ura.user_id
where lower(u.email) = lower('george.renju@gmail.com')
order by ura.scope, ura.apartment_id nulls first;

-- 2) Restore system_admin (safe to re-run)
insert into public.user_role_assignments (user_id, role_key, scope, apartment_id)
select p.id, 'system_admin', 'system', null
from public.profiles p
join auth.users u on u.id = p.id
where lower(u.email) = lower('george.renju@gmail.com')
on conflict (user_id, role_key, scope, apartment_id) do nothing;

-- 3) Ensure profile role is admin (society-level fallback for legacy RLS)
update public.profiles p
set role = 'admin'
from auth.users u
where u.id = p.id
  and lower(u.email) = lower('george.renju@gmail.com')
  and coalesce(p.role, '') not in ('admin', 'apartment_admin');

-- 4) Verify
select ura.role_key, ura.scope, ura.apartment_id, a.name as apartment_name
from public.user_role_assignments ura
join auth.users u on u.id = ura.user_id
left join public.apartments a on a.id = ura.apartment_id
where lower(u.email) = lower('george.renju@gmail.com')
order by ura.scope, a.name;
