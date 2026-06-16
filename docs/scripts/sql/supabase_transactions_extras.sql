-- Optional expense fields + receipt storage (run in Supabase SQL Editor)

alter table public.transactions add column if not exists sub_category text;
alter table public.transactions add column if not exists receipt_url text;
alter table public.transactions add column if not exists receipt_urls jsonb not null default '[]'::jsonb;
alter table public.transactions add column if not exists vendor_name text;
alter table public.transactions add column if not exists vendor_invoice text;
alter table public.transactions add column if not exists bank_payment_type text;
alter table public.transactions add column if not exists bank_reference text;
alter table public.transactions add column if not exists bank_proof_urls jsonb not null default '[]'::jsonb;

comment on column public.transactions.sub_category is 'Optional finer-grained expense label';
comment on column public.transactions.receipt_url is 'Legacy single receipt path (first file in receipt_urls)';
comment on column public.transactions.receipt_urls is 'Array of Supabase Storage paths in transaction-receipts bucket';
comment on column public.transactions.vendor_name is 'Vendor or payee for expense transactions';
comment on column public.transactions.vendor_invoice is 'Optional invoice or bill reference from vendor';
comment on column public.transactions.bank_payment_type is 'cheque, upi, or neft when wallet is BANK';
comment on column public.transactions.bank_reference is 'Cheque no, UPI txn id, or NEFT/IMPS reference';
comment on column public.transactions.bank_proof_urls is 'Bank statement / passbook proof paths in transaction-receipts bucket';

-- Backfill receipt_urls from legacy receipt_url
update public.transactions
set receipt_urls = jsonb_build_array(receipt_url)
where receipt_url is not null
  and receipt_url <> ''
  and (receipt_urls is null or receipt_urls = '[]'::jsonb);

-- Storage bucket for receipt images/PDFs
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'transaction-receipts',
  'transaction-receipts',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']
)
on conflict (id) do nothing;

drop policy if exists "transaction receipts read" on storage.objects;
create policy "transaction receipts read"
on storage.objects for select
using (
  bucket_id = 'transaction-receipts'
  and auth.uid() is not null
);

drop policy if exists "transaction receipts insert" on storage.objects;
create policy "transaction receipts insert"
on storage.objects for insert
with check (
  bucket_id = 'transaction-receipts'
  and auth.uid() is not null
);

drop policy if exists "transaction receipts update" on storage.objects;
create policy "transaction receipts update"
on storage.objects for update
using (bucket_id = 'transaction-receipts' and auth.uid() is not null)
with check (bucket_id = 'transaction-receipts' and auth.uid() is not null);

drop policy if exists "transaction receipts delete" on storage.objects;
create policy "transaction receipts delete"
on storage.objects for delete
using (bucket_id = 'transaction-receipts' and auth.uid() is not null);
