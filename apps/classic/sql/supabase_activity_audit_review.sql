-- Activity audit review workflow — office manager entries require office bearer approval
-- Run after supabase_activity_audit_log.sql

alter table public.activity_audit_log
  add column if not exists review_status text not null default 'APPROVED'
    check (review_status in ('PENDING', 'APPROVED', 'REJECTED'));

alter table public.activity_audit_log
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null;

alter table public.activity_audit_log
  add column if not exists reviewed_at timestamptz;

alter table public.activity_audit_log
  add column if not exists review_notes text;

create index if not exists idx_activity_audit_review_pending
  on public.activity_audit_log (apartment_id, review_status, created_at desc)
  where review_status = 'PENDING';

comment on column public.activity_audit_log.review_status is
  'PENDING = submitted by office manager, awaiting association office bearer review; APPROVED = visible in official log; REJECTED = declined by reviewer';

-- Office bearers (admin) and accounts managers may approve or reject pending entries
drop policy if exists "activity_audit_log review update" on public.activity_audit_log;
create policy "activity_audit_log review update"
on public.activity_audit_log for update
using (
  auth.uid() is not null
  and review_status = 'PENDING'
  and (
    exists (
      select 1 from public.user_apartments ua
      join public.profiles p on p.id = ua.user_id
      where ua.user_id = auth.uid()
        and ua.apartment_id = activity_audit_log.apartment_id
        and coalesce(p.role, 'resident_viewer') in ('admin', 'accounts_manager')
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
)
with check (
  review_status in ('APPROVED', 'REJECTED')
);
