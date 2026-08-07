-- Access request kind: resident vs office (role chosen by admin on approval, not by requester)
-- Run after supabase_access_requests.sql. Safe to re-run.

alter table public.access_requests
  add column if not exists request_kind text not null default 'resident';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'access_requests_request_kind_check'
      and conrelid = 'public.access_requests'::regclass
  ) then
    alter table public.access_requests
      add constraint access_requests_request_kind_check
      check (request_kind in ('resident', 'office'));
  end if;
end $$;

comment on column public.access_requests.request_kind is
  'resident = portal access; office = staff access — society admin assigns role on approval';

-- Backfill: old office-role self-requests become office kind
update public.access_requests
set request_kind = 'office'
where request_kind = 'resident'
  and requested_role_key is not null
  and requested_role_key not in ('resident_viewer', 'office_pending');
