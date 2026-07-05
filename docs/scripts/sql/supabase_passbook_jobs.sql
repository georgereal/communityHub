-- Async passbook OCR job tracking for Evolyx workflow runs.

create table if not exists public.passbook_ocr_jobs (
  id uuid primary key default gen_random_uuid(),
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  provider text not null default 'EVOLYX' check (provider in ('EVOLYX')),
  status text not null default 'INITIALIZED'
    check (status in ('INITIALIZED', 'SUBMITTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'IMPORTED')),
  workflow_id text,
  execution_id text,
  request_id text,
  created_by uuid references auth.users(id) on delete set null,
  callback_token text,
  file_count integer not null default 0,
  total_bytes bigint not null default 0,
  file_names jsonb not null default '[]'::jsonb,
  mapped_line_count integer not null default 0,
  import_count integer not null default 0,
  imported_statement_import_id uuid,
  imported_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  last_error_detail text,
  provider_response jsonb,
  mapped_lines jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_passbook_jobs_apartment_created
  on public.passbook_ocr_jobs (apartment_id, created_at desc);

create unique index if not exists idx_passbook_jobs_execution
  on public.passbook_ocr_jobs (execution_id)
  where execution_id is not null;

alter table public.passbook_ocr_jobs enable row level security;

drop policy if exists "passbook_jobs read" on public.passbook_ocr_jobs;
create policy "passbook_jobs read"
on public.passbook_ocr_jobs for select
using (public.effective_apartment_permission(apartment_id, 'accounts.edit'));

drop policy if exists "passbook_jobs write" on public.passbook_ocr_jobs;
create policy "passbook_jobs insert"
on public.passbook_ocr_jobs for insert
with check (public.effective_apartment_permission(apartment_id, 'accounts.edit'));

create policy "passbook_jobs update"
on public.passbook_ocr_jobs for update
using (public.effective_apartment_permission(apartment_id, 'accounts.edit'))
with check (public.effective_apartment_permission(apartment_id, 'accounts.edit'));

create policy "passbook_jobs delete"
on public.passbook_ocr_jobs for delete
using (public.effective_apartment_permission(apartment_id, 'accounts.edit'));

create or replace function public.set_passbook_jobs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.complete_passbook_ocr_job(
  p_job_id uuid,
  p_callback_token text,
  p_status text,
  p_execution_id text,
  p_request_id text,
  p_provider_response jsonb,
  p_last_error text,
  p_last_error_detail text,
  p_mapped_lines jsonb,
  p_mapped_line_count integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.passbook_ocr_jobs;
  v_status text := upper(coalesce(p_status, 'FAILED'));
begin
  if v_status not in ('SUBMITTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'IMPORTED') then
    v_status := 'FAILED';
  end if;

  update public.passbook_ocr_jobs
  set
    status = v_status,
    execution_id = coalesce(p_execution_id, execution_id),
    request_id = coalesce(p_request_id, request_id),
    provider_response = coalesce(p_provider_response, provider_response),
    last_error = p_last_error,
    last_error_detail = p_last_error_detail,
    mapped_lines = coalesce(p_mapped_lines, '[]'::jsonb),
    mapped_line_count = greatest(coalesce(p_mapped_line_count, 0), 0),
    completed_at = case when v_status in ('COMPLETED', 'FAILED', 'IMPORTED') then now() else completed_at end,
    started_at = coalesce(started_at, now()),
    updated_at = now()
  where id = p_job_id
    and callback_token = p_callback_token
  returning * into v_row;

  if not found then
    raise exception 'Passbook OCR job not found or token invalid.';
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'status', v_row.status,
    'execution_id', v_row.execution_id,
    'mapped_line_count', v_row.mapped_line_count
  );
end;
$$;

grant execute on function public.complete_passbook_ocr_job(uuid, text, text, text, text, jsonb, text, text, jsonb, integer) to anon, authenticated;

drop trigger if exists trg_passbook_jobs_updated_at on public.passbook_ocr_jobs;
create trigger trg_passbook_jobs_updated_at
before update on public.passbook_ocr_jobs
for each row execute function public.set_passbook_jobs_updated_at();

comment on table public.passbook_ocr_jobs is
  'Async Evolyx OCR execution tracking for bank passbook imports, including webhook completion state and mapped statement lines.';
