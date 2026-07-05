-- Statement line ordering for passbook OCR / manual reconciliation

alter table public.bank_statement_lines
  add column if not exists line_order integer not null default 0,
  add column if not exists source_row_index integer,
  add column if not exists order_source text not null default 'auto'
    check (order_source in ('auto', 'balance_inferred', 'manual')),
  add column if not exists computed_balance numeric(12, 2);

create index if not exists idx_bank_statement_lines_order
  on public.bank_statement_lines (apartment_id, line_date, line_order);

comment on column public.bank_statement_lines.line_order is
  'Display sequence within statement chronology; same-day tie-breaker and drag-drop order.';
comment on column public.bank_statement_lines.source_row_index is
  'Original OCR/import array index at insert time; immutable audit trail.';
comment on column public.bank_statement_lines.order_source is
  'How line_order was determined: auto (source index), balance_inferred, or manual (drag-drop).';
comment on column public.bank_statement_lines.computed_balance is
  'Running balance after this line (opening + credits − debits in chronological order); persisted on import/opening save.';

-- Opening balance for calculated running balance (required for Save opening + import ordering)

alter table public.apartment_bank_accounts
  add column if not exists opening_balance numeric(12, 2),
  add column if not exists opening_balance_date date;

comment on column public.apartment_bank_accounts.opening_balance is
  'Passbook balance on opening_balance_date — base for calculated running balance.';
comment on column public.apartment_bank_accounts.opening_balance_date is
  'Date from which statement imports and calculated balance apply.';
