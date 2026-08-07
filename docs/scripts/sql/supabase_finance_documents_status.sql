-- Bookkeeping status for finance_documents: unpaid → paid → linked (void = cancelled).
-- Replaces vague "open". Run in Supabase SQL Editor after supabase_finance_documents.sql.

-- Drop old check (name may vary); recreate with new values.
alter table public.finance_documents
  drop constraint if exists finance_documents_status_check;

alter table public.finance_documents
  add constraint finance_documents_status_check
  check (status in ('unpaid', 'paid', 'linked', 'void', 'open'));

-- Migrate legacy open → unpaid or paid from payment notes.
update public.finance_documents
set status = 'paid',
    updated_at = now()
where status = 'open'
  and (
    notes ~* '^Cheque:\s*.+'
    or notes ~* 'Payment:\s*Cash'
  );

update public.finance_documents
set status = 'unpaid',
    updated_at = now()
where status = 'open';

-- Linked / void unchanged. Drop transitional 'open' from allowed set.
alter table public.finance_documents
  drop constraint if exists finance_documents_status_check;

alter table public.finance_documents
  add constraint finance_documents_status_check
  check (status in ('unpaid', 'paid', 'linked', 'void'));

alter table public.finance_documents
  alter column status set default 'unpaid';
