-- Access requests — first-time sign-in users request society access; admins approve in Setup.
-- Run after supabase_rbac_v2.sql and supabase_notice_delivery.sql

create table if not exists public.access_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  requested_role_key text not null default 'resident_viewer',
  status text not null default 'PENDING'
    check (status in ('PENDING', 'APPROVED', 'DENIED')),
  message text,
  requester_email text,
  requester_name text,
  admin_note text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_access_requests_pending_unique
  on public.access_requests (user_id, apartment_id)
  where status = 'PENDING';

create index if not exists idx_access_requests_apartment_status
  on public.access_requests (apartment_id, status, created_at desc);

create index if not exists idx_access_requests_user
  on public.access_requests (user_id, status, created_at desc);

alter table public.access_requests enable row level security;

drop policy if exists "access_requests read own" on public.access_requests;
drop policy if exists "access_requests insert own" on public.access_requests;
drop policy if exists "access_requests admin read" on public.access_requests;
drop policy if exists "access_requests admin update" on public.access_requests;

create policy "access_requests read own"
on public.access_requests for select
using (user_id = auth.uid());

create policy "access_requests insert own"
on public.access_requests for insert
with check (
  user_id = auth.uid()
  and status = 'PENDING'
);

create policy "access_requests admin read"
on public.access_requests for select
using (
  public.has_system_role('system_admin')
  or exists (
    select 1 from public.user_role_assignments ura
    where ura.user_id = auth.uid()
      and ura.apartment_id = access_requests.apartment_id
      and ura.scope = 'apartment'
      and ura.role_key in ('apartment_admin', 'accounts_manager', 'property_manager')
  )
  or exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = access_requests.apartment_id
      and coalesce(p.role, '') in ('admin', 'property_manager', 'accounts_manager')
  )
);

create policy "access_requests admin update"
on public.access_requests for update
using (
  public.has_system_role('system_admin')
  or exists (
    select 1 from public.user_role_assignments ura
    where ura.user_id = auth.uid()
      and ura.apartment_id = access_requests.apartment_id
      and ura.scope = 'apartment'
      and ura.role_key in ('apartment_admin', 'accounts_manager', 'property_manager')
  )
  or exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = access_requests.apartment_id
      and coalesce(p.role, '') in ('admin', 'property_manager', 'accounts_manager')
  )
);

-- Let signed-in users pick a society when requesting access (names only; excludes system row).
drop policy if exists "apartments access request picker" on public.apartments;
create policy "apartments access request picker"
on public.apartments for select
using (
  auth.uid() is not null
  and coalesce(name, '') <> '__SYSTEM__'
);

alter table public.user_notifications
  add column if not exists access_request_id uuid references public.access_requests(id) on delete set null;

create index if not exists idx_user_notifications_access_request
  on public.user_notifications (access_request_id)
  where access_request_id is not null;

create or replace function public.notify_access_request_submitted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  apt_name text;
  requester_label text;
  reviewer_id uuid;
  notified int := 0;
begin
  if new.status is distinct from 'PENDING' then
    return new;
  end if;

  select name into apt_name from public.apartments where id = new.apartment_id;
  requester_label := coalesce(new.requester_name, new.requester_email, 'A user');

  for reviewer_id in
    select distinct ura.user_id
    from public.user_role_assignments ura
    where ura.apartment_id = new.apartment_id
      and ura.scope = 'apartment'
      and ura.role_key in ('apartment_admin', 'accounts_manager', 'property_manager')
  loop
    insert into public.user_notifications (
      id, apartment_id, user_id, title, body, access_request_id
    ) values (
      gen_random_uuid(),
      new.apartment_id,
      reviewer_id,
      'Access request pending',
      requester_label || ' requested access to ' || coalesce(apt_name, 'your society'),
      new.id
    );
    notified := notified + 1;
  end loop;

  if notified = 0 then
    for reviewer_id in
      select distinct ua.user_id
      from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.apartment_id = new.apartment_id
        and coalesce(p.role, '') in ('admin', 'property_manager', 'accounts_manager')
    loop
      insert into public.user_notifications (
        id, apartment_id, user_id, title, body, access_request_id
      ) values (
        gen_random_uuid(),
        new.apartment_id,
        reviewer_id,
        'Access request pending',
        requester_label || ' requested access to ' || coalesce(apt_name, 'your society'),
        new.id
      );
    end loop;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_access_request_notify on public.access_requests;
create trigger trg_access_request_notify
  after insert on public.access_requests
  for each row execute function public.notify_access_request_submitted();

comment on table public.access_requests is
  'Users without society access submit requests; apartment admins approve and grant user_apartments + roles.';
