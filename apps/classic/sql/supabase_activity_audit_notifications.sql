-- In-app notifications for activity audit review workflow
-- Run after supabase_activity_audit_log.sql and supabase_notice_delivery.sql

alter table public.user_notifications
  add column if not exists activity_audit_log_id uuid references public.activity_audit_log(id) on delete cascade;

create index if not exists idx_user_notifications_audit
  on public.user_notifications (activity_audit_log_id)
  where activity_audit_log_id is not null;

-- Allow accounts managers to queue in-app alerts (approve/reject notifications)
drop policy if exists "user_notifications insert staff" on public.user_notifications;
create policy "user_notifications insert staff"
on public.user_notifications for insert
with check (
  exists (
    select 1 from public.user_apartments ua
    join public.profiles p on p.id = ua.user_id
    where ua.user_id = auth.uid()
      and ua.apartment_id = user_notifications.apartment_id
      and coalesce(p.role, 'resident_viewer') in ('admin', 'property_manager', 'accounts_manager')
  )
);
