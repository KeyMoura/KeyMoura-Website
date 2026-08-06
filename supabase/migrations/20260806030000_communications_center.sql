-- ============================================================================
-- Communications centre: delivery history, safe resend, notification dedup,
-- launch-readiness acknowledgements and historical discrepancy review
-- ============================================================================
--
-- Strictly additive. No table is dropped, no column is removed, no constraint is
-- narrowed, and every existing row stays legal:
--
--   * `notifications` gains one nullable column and one *partial* unique index
--     (`where event_key is not null`), so all ten existing rows keep null, never
--     collide, and need no backfill.
--   * `email_deliveries` gains seven nullable-or-defaulted columns. All 24
--     existing rows satisfy them on the defaults.
--   * Three new tables, each with explicit grants — the pass-5a lesson: this
--     database's default privileges for a new public table carry no SELECT,
--     INSERT, UPDATE or DELETE for any PostgREST role, and table privileges are
--     checked *before* RLS, so a table shipped without grants is unreadable even
--     by `service_role`, whose BYPASSRLS bypasses policies but not grants.
--   * New `email_templates` rows are inserted `on conflict (key) do nothing`, so
--     re-running cannot overwrite wording an owner has since edited.
--
-- Nothing here reads, writes or references orders KM-0001 or KM-0002. The
-- discrepancy table records a *review*; it never touches the order it reviews.

-- ---------------------------------------------------------------------------
-- 1. Notification deduplication
-- ---------------------------------------------------------------------------
--
-- `createNotification` inserted unconditionally. Stripe replays were already
-- caught upstream by `stripe_webhook_events`, so no duplicate had been observed
-- in production — but every non-Stripe path (a retried fetch, two tabs, a slow
-- response clicked twice) could produce two identical rows in a staff member's
-- bell. The key makes that unrepresentable rather than unlikely.

alter table public.notifications
  add column if not exists event_key text;

-- Scoped to the recipient, not global. The same logical event legitimately
-- produces one row per staff member who should hear about it; collapsing those
-- would deliver the alert to whoever happened to be resolved first and to
-- nobody else.
create unique index if not exists notifications_user_event_key_idx
  on public.notifications (user_id, event_key)
  where event_key is not null;

comment on column public.notifications.event_key is
  'Durable identifier for the logical event, from notificationEventKey(). Null on rows written before pass 12; nulls do not collide.';

-- ---------------------------------------------------------------------------
-- 2. Email delivery history
-- ---------------------------------------------------------------------------
--
-- `email_deliveries` recorded one row per event key and never changed it again:
-- no attempt count, no delivered timestamp, no link between a resend and the
-- message it repeats, and no way to tell a customer email from a staff alert
-- when deciding what a staff surface may display.

-- The status CHECK has to be widened before anything else, because the new
-- sender claims a row as `queued` *before* calling the provider and the
-- original constraint admits only `sent`, `failed` and `skipped`. Without this,
-- every single transactional email would fail with 23514 at the claim, before
-- the provider was ever reached — caught by a live dry-run probe rather than in
-- production, which is the entire reason those probes exist.
--
-- **Widened, never narrowed.** Production holds 25 `sent` and 1 `skipped`, and
-- both stay legal. The ordering below is what makes this safe on a live table:
-- the wider constraint is added *first*, so it validates every stored row while
-- the narrower one is still in force. If any row could not satisfy it the ADD
-- fails and nothing has been dropped. Only then is the old one retired, and the
-- new one takes its canonical name so the schema reads the same afterwards.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.email_deliveries'::regclass
      and conname = 'email_deliveries_status_check'
      and pg_get_constraintdef(oid) like '%queued%'
  ) then
    alter table public.email_deliveries
      add constraint email_deliveries_status_check_v2
      check (status in ('queued', 'sent', 'delivered', 'failed', 'skipped'));

    alter table public.email_deliveries
      drop constraint if exists email_deliveries_status_check;

    alter table public.email_deliveries
      rename constraint email_deliveries_status_check_v2 to email_deliveries_status_check;
  end if;
end $$;

-- The five values, and why there are exactly five:
--
--   queued    — claimed, provider not yet answered. The state the claim writes.
--   sent      — the provider accepted it.
--   delivered — the provider confirmed delivery. **Nothing writes this today**;
--               Resend delivery webhooks are not wired. It is admitted because
--               the claim logic already treats it as "the customer has it", and
--               because wiring that webhook later should be a code change
--               rather than another constraint change on a live table.
--   failed    — the provider refused it.
--   skipped   — this application deliberately did not send. Shown to staff as
--               "Suppressed"; the stored value is unchanged so no row migrates.
--
-- Deliberately **not** added: a separate `sending` state, which would duplicate
-- `queued` for the same window, and a `retried` state, which would leave a row
-- claiming it was retried without saying whether the retry worked. A retry
-- re-claims the row back to `queued` and the count lives in `attempt_count`.

alter table public.email_deliveries
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists attempt_count integer not null default 1,
  add column if not exists delivered_at timestamptz,
  add column if not exists failure_category text,
  -- A resend is a *new row* pointing at the original, never an edit of it. The
  -- original delivery is evidence of what was sent and when; rewriting it to
  -- say "sent again" destroys the only record that the first attempt happened.
  add column if not exists resend_of_id uuid references public.email_deliveries (id) on delete set null,
  add column if not exists resent_by uuid references auth.users (id) on delete set null,
  add column if not exists audience text;

-- Deliberately permissive: `status` already carries free text written by an
-- older code path, and narrowing it now could refuse an existing row. These two
-- CHECKs constrain only the *new* columns, and both admit null so every
-- pre-existing row passes without a backfill.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'email_deliveries_failure_category_check') then
    alter table public.email_deliveries
      add constraint email_deliveries_failure_category_check
      check (failure_category is null or failure_category in (
        'not_configured', 'disabled', 'invalid_recipient', 'provider_rejected',
        'provider_unavailable', 'rate_limited', 'unknown'
      ));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'email_deliveries_audience_check') then
    alter table public.email_deliveries
      add constraint email_deliveries_audience_check
      check (audience is null or audience in ('customer', 'staff'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'email_deliveries_attempt_count_check') then
    alter table public.email_deliveries
      add constraint email_deliveries_attempt_count_check
      check (attempt_count >= 1);
  end if;
end $$;

create index if not exists email_deliveries_created_at_idx
  on public.email_deliveries (created_at desc);
create index if not exists email_deliveries_status_created_idx
  on public.email_deliveries (status, created_at desc);
create index if not exists email_deliveries_template_created_idx
  on public.email_deliveries (template_key, created_at desc);
create index if not exists email_deliveries_resend_of_idx
  on public.email_deliveries (resend_of_id)
  where resend_of_id is not null;

comment on column public.email_deliveries.resend_of_id is
  'The delivery this row repeats. The original is immutable; a resend is a new row.';
comment on column public.email_deliveries.failure_category is
  'A safe classification of why a send failed. The provider string is kept separately in error_message and is never shown raw to staff.';

-- ---------------------------------------------------------------------------
-- 3. Launch-readiness acknowledgements
-- ---------------------------------------------------------------------------
--
-- An acknowledgement records a *decision about a warning*. It changes nothing
-- else: no financial column, no order, no setting. That separation is the point
-- — acknowledging "KM-0001 has no payment row" must never be able to create
-- one.

create table if not exists public.launch_readiness_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  check_id text not null,
  -- What the check said when it was acknowledged. An acknowledgement of
  -- "3 products missing a cover image" should not silence the check once it
  -- says 11; the fingerprint is what lets the reader know it changed.
  fingerprint text not null,
  severity text not null check (severity in ('blocker', 'warning', 'info')),
  note text,
  acknowledged_by uuid references auth.users (id) on delete set null,
  acknowledged_at timestamptz not null default now(),
  cleared_at timestamptz,
  cleared_by uuid references auth.users (id) on delete set null
);

-- One live acknowledgement per check. History is kept: clearing sets
-- `cleared_at` rather than deleting, and the partial index only constrains rows
-- that are still in force.
create unique index if not exists launch_readiness_ack_live_idx
  on public.launch_readiness_acknowledgements (check_id)
  where cleared_at is null;

create index if not exists launch_readiness_ack_recent_idx
  on public.launch_readiness_acknowledgements (acknowledged_at desc);

alter table public.launch_readiness_acknowledgements enable row level security;

create policy "staff read launch readiness acknowledgements"
  on public.launch_readiness_acknowledgements
  for select to authenticated
  using ((select public.is_staff_user()));

-- ---------------------------------------------------------------------------
-- 4. Historical payment discrepancy review
-- ---------------------------------------------------------------------------
--
-- KM-0001 records $25.00 collected with no payment row; KM-0002 records $1.00
-- with no payment row. Both predate the atomic payment accounting added in
-- pass 7. This table records what a person *concluded* about such a row. It
-- deliberately holds no money column and no repair action: a missing payment
-- row does not prove no payment was taken, and inventing one to make a report
-- go green would put a fabricated financial record in the ledger.

create table if not exists public.payment_discrepancy_reviews (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  -- Which reconciliation finding this review answers, so a review of the
  -- payment-total mismatch does not silence a later refund-total mismatch.
  discrepancy_kind text not null check (discrepancy_kind in (
    'payment_total_mismatch', 'refund_total_mismatch', 'other'
  )),
  -- What was true when the reviewer looked. Kept so a review can be recognised
  -- as stale rather than silently trusted after the numbers move.
  observed_recorded_cents integer not null,
  observed_evidence_cents integer not null,
  classification text not null check (classification in (
    'test', 'manual', 'legacy', 'unknown'
  )),
  status text not null default 'reviewed' check (status in ('reviewed', 'unresolved')),
  -- Internal. Never rendered on a customer surface and never sent in an email.
  explanation text not null,
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz not null default now(),
  superseded_at timestamptz
);

-- One live review per order per kind; superseding keeps the old one.
create unique index if not exists payment_discrepancy_live_idx
  on public.payment_discrepancy_reviews (order_id, discrepancy_kind)
  where superseded_at is null;

create index if not exists payment_discrepancy_order_idx
  on public.payment_discrepancy_reviews (order_id, reviewed_at desc);

alter table public.payment_discrepancy_reviews enable row level security;

create policy "staff read payment discrepancy reviews"
  on public.payment_discrepancy_reviews
  for select to authenticated
  using ((select public.is_staff_user()));

-- ---------------------------------------------------------------------------
-- 5. Integration health observations
-- ---------------------------------------------------------------------------
--
-- The health page distinguishes *verified* from *assumed*. An environment
-- variable being present proves configuration, not health; only something that
-- actually happened proves health. This table is where "it actually happened"
-- is recorded, by the code paths that do the real work.

create table if not exists public.integration_health_events (
  id bigint generated always as identity primary key,
  integration_key text not null,
  outcome text not null check (outcome in ('success', 'failure')),
  -- A short, safe summary. Never a provider payload, never a secret, never a
  -- Postgres `details` field — that is the one that echoes row values back.
  summary text,
  observed_at timestamptz not null default now()
);

create index if not exists integration_health_recent_idx
  on public.integration_health_events (integration_key, observed_at desc);

alter table public.integration_health_events enable row level security;

create policy "staff read integration health events"
  on public.integration_health_events
  for select to authenticated
  using ((select public.is_staff_user()));

-- ---------------------------------------------------------------------------
-- 5b. Reading the migration ledger from the application
-- ---------------------------------------------------------------------------
--
-- The health page compares recorded migrations against the files in the
-- repository, because ledger drift has been repaired three times in this
-- project and is invisible until the next migration behaves unexpectedly.
--
-- It cannot read `supabase_migrations.schema_migrations` directly: that schema
-- is not in PostgREST's exposed list, so a client query against it fails
-- regardless of grants. A narrow `security definer` function is the honest way
-- across that boundary — it returns version strings and nothing else, it is
-- `stable`, and it is executable by `service_role` alone.

create or replace function public.migration_ledger_versions()
returns table (version text)
language sql
security definer
-- Pinned, so the function cannot be redirected by a caller's search_path.
set search_path = public, pg_temp
stable
as $$
  select m.version::text
  from supabase_migrations.schema_migrations m
  order by m.version
$$;

comment on function public.migration_ledger_versions() is
  'Recorded migration versions, for the integration-health ledger check. Returns versions only; no statements, no rollback SQL, no identifiers.';

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------
--
-- Explicit for every new table and sequence. `anon` and `authenticated` are
-- revoked first, which also removes the TRUNCATE they inherit from the default
-- ACL — TRUNCATE is not filtered by RLS, so no policy closes it. The read
-- policies above exist so a future staff surface can read through PostgREST if
-- it ever needs to; today every reader is a server route holding service role,
-- and that route checks a permission first.

revoke all on table public.launch_readiness_acknowledgements from anon, authenticated, public;
revoke all on table public.payment_discrepancy_reviews from anon, authenticated, public;
revoke all on table public.integration_health_events from anon, authenticated, public;

grant select on table public.launch_readiness_acknowledgements to authenticated;
grant select on table public.payment_discrepancy_reviews to authenticated;
grant select on table public.integration_health_events to authenticated;

-- No DELETE anywhere. An acknowledgement is cleared, a review is superseded and
-- an observation is history; none of the three is ever removed by the
-- application, so the privilege that would let it is not granted.
grant select, insert, update on table public.launch_readiness_acknowledgements to service_role;
grant select, insert, update on table public.payment_discrepancy_reviews to service_role;
grant select, insert on table public.integration_health_events to service_role;

-- `generated always as identity` creates a sequence, and pass 5a's second
-- outage was a sequence with no grants sitting behind the first.
grant usage, select on sequence public.integration_health_events_id_seq to service_role;
revoke all on sequence public.integration_health_events_id_seq from anon, authenticated, public;

-- A `security definer` function defaults to EXECUTE for PUBLIC. Revoked first,
-- then granted narrowly — the pattern every other function in this repository
-- follows, and the reason none of them appears in the Supabase advisor's
-- "executable by anon/authenticated" warning.
revoke all on function public.migration_ledger_versions() from public, anon, authenticated;
grant execute on function public.migration_ledger_versions() to service_role;

-- ---------------------------------------------------------------------------
-- 7. New transactional email templates
-- ---------------------------------------------------------------------------
--
-- `on conflict (key) do nothing`, so re-running this migration cannot overwrite
-- wording an owner has since edited at /staff/emails. Bodies use only the
-- variables `sendCommerceEmail` interpolates, and none of them carries an
-- internal note, a Stripe identifier or a private address.

insert into public.email_templates (key, name, subject, heading, body, button_label) values
  ('order_received', 'Order received',
   'We have your order {{order_label}}',
   'Thank you for your order',
   E'Hi {{customer_name}},\n\nWe have your order for {{product_name}}. {{detail}}\n\nYou can follow its progress from your order page at any time.',
   'View order'),

  ('staff_new_order', 'Staff: new order',
   'New order {{order_label}}',
   'A new order came in',
   E'{{order_label}} — {{product_name}} — {{price}}.\n\n{{detail}}',
   'Open in staff'),

  ('payment_failed', 'Payment failed',
   'Your payment for {{order_label}} did not go through',
   'That payment did not complete',
   E'Hi {{customer_name}},\n\nYour payment for {{product_name}} was not completed, so nothing has been charged. {{detail}}\n\nYou can try again from your order page whenever you are ready.',
   'Try again'),

  ('staff_payment_failed', 'Staff: payment failed',
   'Payment failed on {{order_label}}',
   'A customer payment failed',
   E'{{order_label}} — {{product_name}}. The payment was refused and the order is still unpaid. {{detail}}',
   'Open in staff'),

  ('quote_updated', 'Quote updated',
   'An updated quote for {{order_label}}',
   'Your quote has been updated',
   E'Hi {{customer_name}},\n\nWe have revised the quote for {{product_name}}. The updated total is {{price}}. {{detail}}\n\nReview it on your order page when you are ready.',
   'Review quote'),

  ('cancellation_withdrawn', 'Cancellation withdrawn',
   'Cancellation withdrawn for {{order_label}}',
   'Your cancellation request was withdrawn',
   E'Hi {{customer_name}},\n\nThe cancellation request for {{product_name}} has been withdrawn and your order is continuing as normal. {{detail}}',
   'View order'),

  ('staff_cancellation_request', 'Staff: cancellation requested',
   'Cancellation requested on {{order_label}}',
   'A customer asked to cancel',
   E'{{order_label}} — {{product_name}}. A cancellation request is waiting for a decision. {{detail}}',
   'Review request'),

  ('staff_return_request', 'Staff: return requested',
   'Return requested on {{order_label}}',
   'A customer opened a return',
   E'{{order_label}} — {{product_name}}. A return request is waiting for a decision. {{detail}}',
   'Review return'),

  ('refund_partial_completed', 'Partial refund completed',
   'A partial refund for {{order_label}}',
   'Your partial refund is complete',
   E'Hi {{customer_name}},\n\nWe have refunded {{price}} for {{product_name}}. {{detail}}\n\nThe rest of the order is unaffected. Refunds usually reach your account within a few business days.',
   'View order'),

  ('production_started', 'Production started',
   'We have started work on {{order_label}}',
   'Work has started',
   E'Hi {{customer_name}},\n\nWe have started making {{product_name}}. {{detail}}\n\nWe will let you know when it is finished.',
   'View order'),

  ('production_waiting_on_customer', 'Production waiting on customer',
   'We need something from you for {{order_label}}',
   'We are waiting on you',
   E'Hi {{customer_name}},\n\nWork on {{product_name}} is paused until we hear back from you. {{detail}}\n\nReply from your order page and we will pick it straight back up.',
   'Reply on your order'),

  ('production_completed', 'Production completed',
   'Your {{product_name}} is finished',
   'It is finished',
   E'Hi {{customer_name}},\n\n{{product_name}} is finished and moving to dispatch. {{detail}}\n\nWe will be in touch as soon as it is on its way.',
   'View order'),

  ('staff_integration_failure', 'Staff: integration failure',
   'KeyMoura needs attention: {{status}}',
   'Something needs attention',
   E'{{status}}\n\n{{detail}}\n\nOpen the integration health page for the full picture.',
   'Open integration health')
on conflict (key) do nothing;
