-- Opening balance for bank reconciliation (per society bank account)

alter table public.apartment_bank_accounts
  add column if not exists opening_balance numeric(12, 2),
  add column if not exists opening_balance_date date;

comment on column public.apartment_bank_accounts.opening_balance is
  'Passbook balance on opening_balance_date — base for calculated running balance.';
comment on column public.apartment_bank_accounts.opening_balance_date is
  'Date from which statement imports and calculated balance apply.';
