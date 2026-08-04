-- Production and job tracking for custom manufacturing.
--
-- Additive. Nothing existing is altered: every link to an order, order item,
-- product, or customer is a nullable foreign key with `on delete set null`, so
-- a job survives the deletion of anything it points at and no existing write
-- path gains a new required column.
--
-- Four tables rather than one:
--
--   production_jobs        the job
--   production_job_tasks   manufacturing steps, completion and QC checklists
--   production_job_files   CAD/CAM/drawings/reference/customer-approved assets
--   production_job_events  the operational timeline
--
-- `production_job_tasks` carries a `kind` discriminator instead of being split
-- into three near-identical tables. A manufacturing step, a completion-checklist
-- line and a QC-checklist line differ only in which list they belong to; three
-- tables would mean three sets of policies, indexes and ordering rules that
-- drift apart, and reordering logic written three times.
--
-- `production_job_events` is deliberately separate from `audit_logs`. The audit
-- log is a security record with its own retention and severity concerns; the job
-- timeline is an operational artifact staff read on every visit to a job. Making
-- the timeline a filtered query over `audit_logs` would couple a hot operational
-- read to a table that grows without bound and may be pruned. Consequential
-- actions write both: a job event for the shop floor, an audit event for the
-- security record.
--
-- Jobs are staff-only. Customers never read these rows — internal manufacturing
-- detail, costs of rework, scrap reasons and internal notes all live here. The
-- `customer_visible_notes` column exists so staff can stage text intended for a
-- customer, but it reaches them through the order surfaces, not by granting any
-- customer access to this table.

begin;

-- ---------------------------------------------------------------------------
-- Job numbers
-- ---------------------------------------------------------------------------

-- A sequence rather than `max(job_number) + 1`: two staff creating a job at the
-- same moment must not race for the same number. Numbers may skip on a rolled
-- back insert, which is correct — a job number identifies a job, it does not
-- count them.
create sequence if not exists public.production_job_number_seq as bigint start with 1;

create or replace function public.next_production_job_number()
returns text
language sql
volatile
set search_path = public
as $$
  select 'JOB-' || lpad(nextval('public.production_job_number_seq')::text, 4, '0');
$$;

-- ---------------------------------------------------------------------------
-- production_jobs
-- ---------------------------------------------------------------------------

create table if not exists public.production_jobs (
  id uuid primary key default gen_random_uuid(),
  job_number text not null unique default public.next_production_job_number(),

  title text not null,
  description text,

  status text not null default 'not_started',
  priority text not null default 'normal',

  -- Every link is optional. A job may exist before an order does (stock work),
  -- and must survive the removal of whatever it was raised against.
  order_id uuid references public.orders(id) on delete set null,
  order_item_id uuid references public.order_items(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  customer_id uuid references auth.users(id) on delete set null,

  quantity integer not null default 1,

  due_date date,
  promised_date date,
  assigned_to uuid references auth.users(id) on delete set null,

  estimated_minutes integer,
  actual_minutes integer,

  materials_required text,
  materials_acquired boolean not null default false,
  external_services_required text,

  internal_notes text,
  customer_visible_notes text,

  -- A state that needs explaining stores its explanation next to it, so the
  -- reason cannot be lost by a later transition the way a timeline note can.
  hold_reason text,
  failure_reason text,
  rework_count integer not null default 0,

  started_at timestamptz,
  ready_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint production_jobs_title_check check (length(btrim(title)) > 0),
  constraint production_jobs_quantity_check check (quantity > 0),
  constraint production_jobs_rework_check check (rework_count >= 0),
  constraint production_jobs_estimated_minutes_check
    check (estimated_minutes is null or estimated_minutes >= 0),
  constraint production_jobs_actual_minutes_check
    check (actual_minutes is null or actual_minutes >= 0),
  constraint production_jobs_status_check check (status in (
    'not_started',
    'planning',
    'waiting_on_customer',
    'waiting_on_materials',
    'scheduled',
    'in_progress',
    'quality_check',
    'rework_required',
    'ready_for_pickup',
    'ready_to_ship',
    'completed',
    'on_hold',
    'cancelled'
  )),
  constraint production_jobs_priority_check
    check (priority in ('low', 'normal', 'high', 'urgent'))
);

-- The queue's default read: open work, most urgent first. Partial on the two
-- terminal states because a finished job is never in the queue and the index
-- should not carry the history.
create index if not exists production_jobs_open_queue_idx
  on public.production_jobs (priority, due_date nulls last, created_at)
  where status not in ('completed', 'cancelled');

create index if not exists production_jobs_status_idx on public.production_jobs (status, updated_at desc);
create index if not exists production_jobs_assigned_idx on public.production_jobs (assigned_to, status)
  where assigned_to is not null;
create index if not exists production_jobs_order_idx on public.production_jobs (order_id)
  where order_id is not null;
create index if not exists production_jobs_customer_idx on public.production_jobs (customer_id)
  where customer_id is not null;
create index if not exists production_jobs_product_idx on public.production_jobs (product_id)
  where product_id is not null;
create index if not exists production_jobs_due_idx on public.production_jobs (due_date)
  where due_date is not null and status not in ('completed', 'cancelled');

-- ---------------------------------------------------------------------------
-- production_job_tasks
-- ---------------------------------------------------------------------------

create table if not exists public.production_job_tasks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.production_jobs(id) on delete cascade,

  -- 'step'       ordered manufacturing operations
  -- 'completion' the completion checklist
  -- 'quality'    the quality-control checklist
  kind text not null,

  label text not null,
  detail text,
  position integer not null default 0,

  is_done boolean not null default false,
  done_by uuid references auth.users(id) on delete set null,
  done_at timestamptz,

  created_at timestamptz not null default now(),

  constraint production_job_tasks_kind_check check (kind in ('step', 'completion', 'quality')),
  constraint production_job_tasks_label_check check (length(btrim(label)) > 0),
  constraint production_job_tasks_position_check check (position >= 0),
  -- `is_done` and `done_at` must agree. Without this a row can claim it was
  -- completed while carrying no completion time, and the QC printout would
  -- show a tick with no date beside it.
  constraint production_job_tasks_done_check
    check ((is_done and done_at is not null) or (not is_done and done_at is null))
);

create index if not exists production_job_tasks_job_idx
  on public.production_job_tasks (job_id, kind, position, created_at);

-- ---------------------------------------------------------------------------
-- production_job_files
-- ---------------------------------------------------------------------------

create table if not exists public.production_job_files (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.production_jobs(id) on delete cascade,

  kind text not null default 'other',
  label text not null,
  storage_path text,
  external_url text,

  -- Off by default. A CAD file is internal until somebody decides otherwise.
  is_customer_visible boolean not null default false,

  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint production_job_files_kind_check
    check (kind in ('cad', 'cam', 'drawing', 'reference', 'customer_approved', 'other')),
  constraint production_job_files_label_check check (length(btrim(label)) > 0),
  -- A file row that points at nothing is not a file.
  constraint production_job_files_target_check
    check (storage_path is not null or external_url is not null)
);

create index if not exists production_job_files_job_idx
  on public.production_job_files (job_id, kind, created_at);

-- ---------------------------------------------------------------------------
-- production_job_events
-- ---------------------------------------------------------------------------

create table if not exists public.production_job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.production_jobs(id) on delete cascade,

  actor_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  from_status text,
  to_status text,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint production_job_events_type_check check (length(btrim(event_type)) > 0)
);

create index if not exists production_job_events_job_idx
  on public.production_job_events (job_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create or replace function public.touch_production_job()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists production_jobs_touch on public.production_jobs;
create trigger production_jobs_touch
  before update on public.production_jobs
  for each row execute function public.touch_production_job();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
--
-- Staff only, on all four tables. There is no customer-facing policy because
-- there is no customer-facing read: manufacturing detail, scrap reasons, rework
-- history and internal notes are not customer information. Anything a customer
-- should see about progress is surfaced through the order.

alter table public.production_jobs enable row level security;
alter table public.production_job_tasks enable row level security;
alter table public.production_job_files enable row level security;
alter table public.production_job_events enable row level security;

drop policy if exists "staff manage production jobs" on public.production_jobs;
create policy "staff manage production jobs" on public.production_jobs
  for all to authenticated
  using ((select public.is_staff_user())) with check ((select public.is_staff_user()));

drop policy if exists "staff manage production job tasks" on public.production_job_tasks;
create policy "staff manage production job tasks" on public.production_job_tasks
  for all to authenticated
  using ((select public.is_staff_user())) with check ((select public.is_staff_user()));

drop policy if exists "staff manage production job files" on public.production_job_files;
create policy "staff manage production job files" on public.production_job_files
  for all to authenticated
  using ((select public.is_staff_user())) with check ((select public.is_staff_user()));

-- The timeline is append-only from the application's point of view. Staff may
-- read and insert; there is deliberately no update or delete policy, so an
-- authenticated staff session cannot rewrite a job's history through PostgREST.
drop policy if exists "staff read production job events" on public.production_job_events;
create policy "staff read production job events" on public.production_job_events
  for select to authenticated
  using ((select public.is_staff_user()));

drop policy if exists "staff append production job events" on public.production_job_events;
create policy "staff append production job events" on public.production_job_events
  for insert to authenticated
  with check ((select public.is_staff_user()));

notify pgrst, 'reload schema';

commit;
