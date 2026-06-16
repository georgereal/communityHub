-- Maintenance billing: per-flat invoices + payment allocations from income transactions
-- Run in Supabase SQL Editor. Safe to re-run.

create table if not exists public.maintenance_invoices (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  unit_id uuid not null references public.units(id) on delete cascade,
  period_label text not null,
  due_date date,
  amount numeric(12, 2) not null check (amount > 0),
  amount_paid numeric(12, 2) not null default 0 check (amount_paid >= 0),
  notes text,
  created_at timestamptz not null default now(),
  unique (apartment_id, unit_id, period_label)
);

create index if not exists idx_maintenance_invoices_apartment on public.maintenance_invoices (apartment_id);
create index if not exists idx_maintenance_invoices_unit on public.maintenance_invoices (unit_id);
create index if not exists idx_maintenance_invoices_due on public.maintenance_invoices (apartment_id, due_date);

comment on table public.maintenance_invoices is 'Maintenance dues billed to a flat/unit (e.g. monthly invoice)';
comment on column public.maintenance_invoices.period_label is 'Human label such as Apr 2026 or Q1 2026';
comment on column public.maintenance_invoices.amount_paid is 'Sum of maintenance_payment_allocations; kept in sync via trigger';

create table if not exists public.maintenance_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null,
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  invoice_id uuid not null references public.maintenance_invoices(id) on delete restrict,
  amount numeric(12, 2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  unique (transaction_id, invoice_id)
);

create index if not exists idx_maintenance_allocations_txn on public.maintenance_payment_allocations (transaction_id);
create index if not exists idx_maintenance_allocations_invoice on public.maintenance_payment_allocations (invoice_id);
create index if not exists idx_maintenance_allocations_apartment on public.maintenance_payment_allocations (apartment_id);

comment on table public.maintenance_payment_allocations is 'Links maintenance collection income to flat invoices';

-- Keep invoice.amount_paid in sync with allocations
create or replace function public.refresh_maintenance_invoice_paid(inv_id uuid)
returns void as $$
  update public.maintenance_invoices mi
  set amount_paid = coalesce((
    select sum(a.amount)::numeric(12, 2)
    from public.maintenance_payment_allocations a
    where a.invoice_id = inv_id
  ), 0)
  where mi.id = inv_id;
$$ language sql;

create or replace function public.trg_maintenance_allocation_sync()
returns trigger as $$
begin
  if tg_op = 'DELETE' then
    perform public.refresh_maintenance_invoice_paid(old.invoice_id);
    return old;
  end if;
  perform public.refresh_maintenance_invoice_paid(new.invoice_id);
  if tg_op = 'UPDATE' and old.invoice_id <> new.invoice_id then
    perform public.refresh_maintenance_invoice_paid(old.invoice_id);
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists maintenance_allocation_sync on public.maintenance_payment_allocations;
create trigger maintenance_allocation_sync
after insert or update or delete on public.maintenance_payment_allocations
for each row execute function public.trg_maintenance_allocation_sync();

alter table public.maintenance_invoices enable row level security;
alter table public.maintenance_payment_allocations enable row level security;

-- maintenance_invoices policies
drop policy if exists "maintenance_invoices read" on public.maintenance_invoices;
create policy "maintenance_invoices read"
on public.maintenance_invoices for select
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = maintenance_invoices.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "maintenance_invoices insert" on public.maintenance_invoices;
create policy "maintenance_invoices insert"
on public.maintenance_invoices for insert
with check (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = maintenance_invoices.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "maintenance_invoices update" on public.maintenance_invoices;
create policy "maintenance_invoices update"
on public.maintenance_invoices for update
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = maintenance_invoices.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
)
with check (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = maintenance_invoices.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "maintenance_invoices delete" on public.maintenance_invoices;
create policy "maintenance_invoices delete"
on public.maintenance_invoices for delete
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = maintenance_invoices.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

-- maintenance_payment_allocations policies
drop policy if exists "maintenance_allocations read" on public.maintenance_payment_allocations;
create policy "maintenance_allocations read"
on public.maintenance_payment_allocations for select
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = maintenance_payment_allocations.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "maintenance_allocations insert" on public.maintenance_payment_allocations;
create policy "maintenance_allocations insert"
on public.maintenance_payment_allocations for insert
with check (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = maintenance_payment_allocations.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "maintenance_allocations update" on public.maintenance_payment_allocations;
create policy "maintenance_allocations update"
on public.maintenance_payment_allocations for update
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = maintenance_payment_allocations.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
)
with check (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = maintenance_payment_allocations.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);

drop policy if exists "maintenance_allocations delete" on public.maintenance_payment_allocations;
create policy "maintenance_allocations delete"
on public.maintenance_payment_allocations for delete
using (
  auth.uid() is not null
  and (
    exists (
      select 1 from public.user_apartments ua
      where ua.user_id = auth.uid() and ua.apartment_id = maintenance_payment_allocations.apartment_id
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  )
);
