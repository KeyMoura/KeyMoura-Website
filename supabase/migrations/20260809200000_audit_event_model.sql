-- Audit log: one canonical event model, append-only, readable by staff.
--
-- KeyMoura already had `audit_logs`, `logAuditEvent()` and a taxonomy of
-- `staff.` / `admin.` / `moderation.` event types. This migration does not
-- introduce a second logging system; it finishes the one that exists.
--
-- Three defects are fixed here, each verified against production before the
-- change was written:
--
-- 1. **Nobody could read the log.** `authenticated` held no SELECT grant, so
--    every browser read returned `42501: permission denied for table
--    audit_logs`. Forty-six real events had accumulated that no staff member
--    could ever see. RLS was never reached — grants are checked first.
--
-- 2. **History was editable.** The `staff manage` policy was `FOR ALL`, so a
--    staff session could UPDATE or DELETE past entries. An audit log a suspect
--    can rewrite is not an audit log. It is now SELECT-only in policy, has no
--    UPDATE/DELETE grant, and is additionally protected by a trigger that
--    refuses both regardless of role — including `service_role`, because the
--    threat model includes the application's own key.
--
-- 3. **Events could not say what changed.** There was no before/after, no
--    entity label and no way to filter by the order or job a change touched.
--
-- Everything here is additive to the existing table. No column is dropped, no
-- row is rewritten, and the 46 existing events keep their meaning.

-- ---------------------------------------------------------------------------
-- 1. The event model
-- ---------------------------------------------------------------------------

alter table public.audit_logs
  -- When the change happened, as distinct from when the row was inserted. They
  -- are the same for staff actions. They are not the same for a provider event
  -- replayed hours later, which is the case this column exists for.
  add column if not exists occurred_at timestamptz not null default now(),

  -- Who acted, in kind. A change made by Stripe is not a change made by a
  -- person, and the log must not imply otherwise. See the check constraint.
  add column if not exists actor_kind text not null default 'staff',

  -- A readable name captured at write time. Deliberately a snapshot: renaming
  -- an account later must not silently rewrite who did what last March.
  add column if not exists actor_label text,

  -- Which surface produced the event: 'staff_ui', 'api', 'webhook', 'trigger',
  -- 'job'. Useful when the same action can arrive by more than one path.
  add column if not exists source text,

  -- What was affected. `entity_label` is the human reference — KM-0012,
  -- PJ-0008, "Shift Knob" — so the log reads without resolving uuids.
  add column if not exists entity_type text,
  add column if not exists entity_id text,
  add column if not exists entity_label text,

  -- Relationship columns, for filtering by the order/job/product a change
  -- touched even when that is not the entity itself. A production job's status
  -- change carries the order it belongs to, so "everything that happened to
  -- KM-0012" is one indexed query rather than a join across four tables.
  --
  -- Deliberately **not** foreign keys. Audit history has to outlive the rows it
  -- describes: deleting a product must not cascade, null out, or block on its
  -- own audit trail. The id is kept as a value, and the label above is what
  -- makes the row readable once the referenced row is gone.
  add column if not exists related_order_id uuid,
  add column if not exists related_production_job_id uuid,
  add column if not exists related_product_id uuid,

  -- The field-level diff: {"status": {"before": "...", "after": "..."}}.
  -- Only allowlisted, non-sensitive fields that actually changed. Never a whole
  -- row — see `docs/COMMERCE_LEDGER.md` for why a JSONB column is not an
  -- invitation to snapshot everything.
  add column if not exists changes jsonb not null default '{}'::jsonb,

  -- One sentence, already readable. Rendering never depends on it.
  add column if not exists summary text,

  -- Ties several events from one request together.
  add column if not exists correlation_id text;

-- Existing rows happened when they were recorded.
update public.audit_logs set occurred_at = created_at where occurred_at <> created_at;

-- The 46 pre-existing rows were all written by the staff path.
update public.audit_logs set actor_kind = 'system' where actor_user_id is null and actor_kind = 'staff';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'audit_logs_actor_kind_check') then
    alter table public.audit_logs
      add constraint audit_logs_actor_kind_check
      check (actor_kind in ('staff', 'system', 'provider', 'scheduled', 'customer'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Indexes for the queries the audit page actually runs
-- ---------------------------------------------------------------------------

create index if not exists audit_logs_occurred_at_idx
  on public.audit_logs (occurred_at desc, id desc);

create index if not exists audit_logs_actor_occurred_idx
  on public.audit_logs (actor_user_id, occurred_at desc);

create index if not exists audit_logs_event_type_occurred_idx
  on public.audit_logs (event_type, occurred_at desc);

create index if not exists audit_logs_entity_idx
  on public.audit_logs (entity_type, entity_id, occurred_at desc);

-- Partial: most events relate to none of these, and an index over mostly-null
-- columns is mostly wasted pages.
create index if not exists audit_logs_related_order_idx
  on public.audit_logs (related_order_id, occurred_at desc) where related_order_id is not null;

create index if not exists audit_logs_related_job_idx
  on public.audit_logs (related_production_job_id, occurred_at desc) where related_production_job_id is not null;

create index if not exists audit_logs_related_product_idx
  on public.audit_logs (related_product_id, occurred_at desc) where related_product_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Append-only, enforced by the database
-- ---------------------------------------------------------------------------
--
-- Grants and policies express the intent; this trigger is what makes it true.
-- It fires for every role, so a mistaken route, a compromised service key, or a
-- staff member with SQL access all hit the same wall.
--
-- The one permitted UPDATE is the FK-driven `on delete set null` that fires
-- when an auth user is deleted. Blocking that would make deleting an account
-- fail outright, so it is allowed — and narrowly: the actor id may go to NULL
-- and nothing else may differ.

-- The "only the actor was nulled" test compares the two rows with
-- `actor_user_id` forced to the same value on both sides, rather than listing
-- every column — a list would silently stop protecting any column added later.
create or replace function public.audit_logs_append_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  old_blanked public.audit_logs%rowtype;
  new_blanked public.audit_logs%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'audit_logs is append-only: history cannot be deleted'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'UPDATE' then
    old_blanked := old;
    new_blanked := new;
    old_blanked.actor_user_id := null;
    new_blanked.actor_user_id := null;

    -- Permitted: the FK `on delete set null` firing when an account is removed.
    if new.actor_user_id is null and old_blanked is not distinct from new_blanked then
      return new;
    end if;

    raise exception 'audit_logs is append-only: history cannot be modified'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end $$;

revoke all on function public.audit_logs_append_only() from public, anon, authenticated;

drop trigger if exists audit_logs_no_update on public.audit_logs;
create trigger audit_logs_no_update
  before update on public.audit_logs
  for each row execute function public.audit_logs_append_only();

drop trigger if exists audit_logs_no_delete on public.audit_logs;
create trigger audit_logs_no_delete
  before delete on public.audit_logs
  for each row execute function public.audit_logs_append_only();

-- TRUNCATE ignores row triggers and every policy, so it needs its own guard.
create or replace function public.audit_logs_no_truncate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'audit_logs is append-only: history cannot be truncated'
    using errcode = 'insufficient_privilege';
end $$;

revoke all on function public.audit_logs_no_truncate() from public, anon, authenticated;

drop trigger if exists audit_logs_no_truncate on public.audit_logs;
create trigger audit_logs_no_truncate
  before truncate on public.audit_logs
  for each statement execute function public.audit_logs_no_truncate();

-- ---------------------------------------------------------------------------
-- 4. Grants and RLS
-- ---------------------------------------------------------------------------
--
-- The grant is the fix for the defect that made this page useless: staff could
-- not read their own audit log. SELECT is granted to `authenticated` and then
-- narrowed by RLS to admitted staff. Customers and anon get nothing at all.

revoke all on table public.audit_logs from anon;
revoke all on table public.audit_logs from authenticated;

grant select on table public.audit_logs to authenticated;

-- Writing stays on the trusted path only: the service role, and the SECURITY
-- DEFINER trigger below.
grant select, insert on table public.audit_logs to service_role;
revoke update, delete, truncate on table public.audit_logs from service_role;

alter table public.audit_logs enable row level security;

-- The old policies were `FOR ALL`. Read-only replaces them.
drop policy if exists "staff manage" on public.audit_logs;
drop policy if exists "account_admission_required" on public.audit_logs;
drop policy if exists "audit_logs_staff_read" on public.audit_logs;

create policy "audit_logs_staff_read" on public.audit_logs
  for select to authenticated
  using (public.is_account_admitted() and public.is_staff_user());

-- ---------------------------------------------------------------------------
-- 5. Catalog changes, audited in the same transaction as the change
-- ---------------------------------------------------------------------------
--
-- Products are written straight from the browser by the staff catalog editor —
-- there is no server route to instrument. A trigger is therefore not a
-- shortcut here, it is the only correct answer: it runs inside the same
-- transaction as the write, catches every path including any added later, and
-- cannot be forgotten by a new caller.
--
-- The column allowlist is the point. A product row carries long marketing copy
-- and a large `detail_content` document; copying whole rows into an audit table
-- on every save is how audit logs become the largest table in the database and
-- start holding things nobody meant to keep. Only these columns are compared,
-- and long text is recorded as a length rather than a body.

create or replace function public.audit_product_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  audited_columns constant text[] := array[
    'name', 'slug', 'sku', 'category_id', 'category',
    'starting_price_cents', 'is_published', 'archived_at',
    'inventory_policy', 'low_stock_threshold', 'continue_selling_when_out_of_stock',
    'purchase_mode', 'made_to_order', 'is_custom', 'availability_status',
    'lead_time_text', 'material', 'finish', 'tax_code',
    'requires_shipping', 'pickup_eligible', 'fulfillment_required', 'is_returnable',
    'image_url', 'model_url', 'sort_order',
    'short_description', 'description', 'detail_content'
  ];
  -- Bodies of these are never copied; only the fact and size of the change.
  summarized_columns constant text[] := array['short_description', 'description', 'detail_content'];
  -- Built from TG_OP rather than declared with a CASE over NEW/OLD: on a DELETE
  -- `NEW` is an unassigned record, and merely referencing `new.id` to build a
  -- parameter raises "record new is not assigned yet" before any branch runs.
  old_row jsonb := '{}'::jsonb;
  new_row jsonb := '{}'::jsonb;
  changed jsonb := '{}'::jsonb;
  col text;
  before_value jsonb;
  after_value jsonb;
  changed_fields text[] := array[]::text[];
  resolved_action text;
  actor uuid := auth.uid();
  actor_name text;
  actor_role_name text;
  subject_id uuid;
  subject_label text;
begin
  if tg_op <> 'INSERT' then old_row := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then new_row := to_jsonb(new); end if;

  subject_id := coalesce(new_row ->> 'id', old_row ->> 'id')::uuid;
  subject_label := coalesce(new_row ->> 'name', old_row ->> 'name');

  -- A deletion's diff is not "every column became null". What matters is which
  -- product left the catalog and what it was, so a compact identity snapshot is
  -- recorded instead of twenty-nine null transitions.
  if tg_op = 'DELETE' then
    changed := jsonb_build_object(
      'name', jsonb_build_object('before', old_row -> 'name', 'after', 'null'::jsonb),
      'slug', jsonb_build_object('before', old_row -> 'slug', 'after', 'null'::jsonb),
      'starting_price_cents',
        jsonb_build_object('before', old_row -> 'starting_price_cents', 'after', 'null'::jsonb),
      'is_published', jsonb_build_object('before', old_row -> 'is_published', 'after', 'null'::jsonb)
    );
    changed_fields := array['name', 'slug', 'starting_price_cents', 'is_published'];
  end if;

  foreach col in array (case when tg_op = 'DELETE' then array[]::text[] else audited_columns end) loop
    -- A missing key and a JSON null are the same absence. Without this
    -- normalization every column left unset on a create reads as a change from
    -- SQL NULL to JSON null, and `product.created` records twenty-nine
    -- "null → null" transitions that mean nothing.
    before_value := coalesce(old_row -> col, 'null'::jsonb);
    after_value := coalesce(new_row -> col, 'null'::jsonb);
    if before_value is not distinct from after_value then
      continue;
    end if;

    changed_fields := changed_fields || col;

    if col = any (summarized_columns) then
      -- "changed, and here is how big it now is" — never the prose itself.
      changed := changed || jsonb_build_object(col, jsonb_build_object(
        'before', case when before_value is null or before_value = 'null'::jsonb
                       then null else to_jsonb(length(before_value::text)) end,
        'after',  case when after_value is null or after_value = 'null'::jsonb
                       then null else to_jsonb(length(after_value::text)) end,
        'summarized', to_jsonb(true)
      ));
    else
      changed := changed || jsonb_build_object(col, jsonb_build_object(
        'before', coalesce(before_value, 'null'::jsonb),
        'after',  coalesce(after_value, 'null'::jsonb)
      ));
    end if;
  end loop;

  -- An UPDATE that touched only `updated_at` is not an event.
  if tg_op = 'UPDATE' and changed = '{}'::jsonb then
    return null;
  end if;

  -- One save, one event. The action names the most consequential concern in the
  -- change; `changes` still carries every allowlisted field that moved, so
  -- nothing is hidden by the choice of name.
  resolved_action := case
    when tg_op = 'INSERT' then 'product.created'
    when tg_op = 'DELETE' then 'product.deleted'
    when changed ? 'archived_at' and new_row ->> 'archived_at' is not null then 'product.archived'
    when changed ? 'archived_at' then 'product.restored'
    when changed ? 'is_published' and (new_row ->> 'is_published')::boolean then 'product.published'
    when changed ? 'is_published' then 'product.unpublished'
    when changed ? 'starting_price_cents' then 'product.price_changed'
    else 'product.updated'
  end;

  if actor is not null then
    select coalesce(p.display_name, p.username), r.role
      into actor_name, actor_role_name
      from public.profiles p
      left join public.user_roles r on r.user_id = p.id
     where p.id = actor;
  end if;

  insert into public.audit_logs (
    actor_user_id, actor_role, actor_kind, actor_label,
    source, event_type,
    target_table, target_id,
    entity_type, entity_id, entity_label,
    related_product_id,
    changes, metadata
  ) values (
    actor,
    coalesce(actor_role_name, case when actor is null then 'system' else 'staff' end),
    case when actor is null then 'system' else 'staff' end,
    coalesce(actor_name, case when actor is null then 'System' else 'Unknown staff' end),
    'trigger',
    resolved_action,
    'products',
    subject_id::text,
    'product',
    subject_id::text,
    subject_label,
    subject_id,
    changed,
    jsonb_build_object('changed_fields', to_jsonb(changed_fields))
  );

  return null;
end $$;

revoke all on function public.audit_product_change() from public, anon, authenticated;

drop trigger if exists products_audit on public.products;
create trigger products_audit
  after insert or update or delete on public.products
  for each row execute function public.audit_product_change();

-- ---------------------------------------------------------------------------
-- 6. Categories, on the same terms
-- ---------------------------------------------------------------------------
--
-- The category routes already write audit events from the server, so this
-- trigger would double-log. It is deliberately **not** created. Categories are
-- audited in `src/app/api/staff/catalog/categories/`, which has the friendly
-- labels and the actor the trigger would have to re-derive.

comment on table public.audit_logs is
  'Append-only staff/system audit trail. Insert only via service_role or a SECURITY DEFINER trigger; readable by admitted staff; UPDATE/DELETE/TRUNCATE refused by trigger.';
