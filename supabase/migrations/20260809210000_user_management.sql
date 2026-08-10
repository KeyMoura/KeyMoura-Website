-- User management — staff notes, and one server-authoritative user directory.
--
-- WHY THIS EXISTS
--
-- KeyMoura already has a complete identity model: `profiles` is the canonical
-- application user record (its `id` *is* `auth.users.id`), `user_roles` holds
-- exactly one role per user, `roles`/`permissions`/`role_permissions`/
-- `user_permissions` are the RBAC, and `user_bans`/`user_restrictions` already
-- express suspension and restriction. None of that is duplicated here.
--
-- Two things are genuinely missing, and this migration adds exactly those:
--
--   1. There is nowhere to write an internal note about a customer.
--   2. A staff directory cannot be filtered or sorted on the server, because
--      the facts it sorts by live in five tables and one of them is `auth`.
--
-- ADDITIVE ONLY. One new table, one new view. No existing table is altered, no
-- existing row is written, and nothing that reads today reads differently.

-- ---------------------------------------------------------------------------
-- 1. Staff notes
-- ---------------------------------------------------------------------------
--
-- Append-only with an archive flag, rather than editable rows. A note saying
-- "customer disputes that this was ever agreed" that can be quietly reworded
-- afterwards is worth less than no note at all, and the same reasoning already
-- governs `audit_logs`.

create table if not exists public.user_staff_notes (
  id uuid primary key default gen_random_uuid(),

  -- The subject. CASCADE because a note about a deleted account has no subject
  -- left; `account_delete` must stay possible, and orphaned notes about a person
  -- who exercised deletion are the wrong thing to keep.
  user_id uuid not null references public.profiles (id) on delete cascade,

  -- The author. SET NULL, not CASCADE: a staff member leaving must not silently
  -- delete the history they wrote. `author_label` is captured at write time so
  -- the note stays attributable after the id is gone — the same trade-off
  -- `audit_logs.actor_label` already makes.
  author_id uuid references public.profiles (id) on delete set null,
  author_label text not null,

  body text not null,
  category text not null default 'general',

  -- Optional context. SET NULL so removing an order cannot destroy the note.
  order_id uuid references public.orders (id) on delete set null,

  archived_at timestamptz,
  archived_by uuid references public.profiles (id) on delete set null,
  archived_by_label text,

  created_at timestamptz not null default now(),

  constraint user_staff_notes_body_not_blank check (btrim(body) <> ''),
  constraint user_staff_notes_body_length check (char_length(body) <= 4000),
  constraint user_staff_notes_category_known check (
    category in ('general', 'preference', 'manufacturing', 'billing', 'shipping', 'warning')
  ),
  -- An archived note has both facts or neither, so "archived" can never be a
  -- state with nobody attached to it.
  constraint user_staff_notes_archive_complete check (
    (archived_at is null and archived_by_label is null)
    or (archived_at is not null and archived_by_label is not null)
  )
);

comment on table public.user_staff_notes is
  'Internal staff-only notes about a user. Append-only: rows may be archived but never edited or deleted. Never customer-visible.';
comment on column public.user_staff_notes.body is
  'Free text. Staff-only. Must not carry payment card data, credentials, or sensitive personal data — see docs/COMMERCE_LEDGER.md.';

create index if not exists user_staff_notes_user_idx
  on public.user_staff_notes (user_id, created_at desc);

create index if not exists user_staff_notes_open_idx
  on public.user_staff_notes (user_id, created_at desc)
  where archived_at is null;

create index if not exists user_staff_notes_order_idx
  on public.user_staff_notes (order_id)
  where order_id is not null;

-- Append-only, enforced in the database rather than by convention.
--
-- The application is not the only thing that can hold a service-role key, so
-- "the route never issues an UPDATE" is a statement about today's code, not a
-- property of the data. Archiving is the single permitted mutation.
create or replace function public.user_staff_notes_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'user_staff_notes is append-only; archive the note instead of deleting it'
      using errcode = '42501';
  end if;

  if new.id is distinct from old.id
     or new.user_id is distinct from old.user_id
     or new.author_id is distinct from old.author_id
     or new.author_label is distinct from old.author_label
     or new.body is distinct from old.body
     or new.category is distinct from old.category
     or new.order_id is distinct from old.order_id
     or new.created_at is distinct from old.created_at then
    raise exception 'user_staff_notes is append-only; only archived_at, archived_by and archived_by_label may change'
      using errcode = '42501';
  end if;

  -- Un-archiving would make the archive flag a toggle rather than a record.
  if old.archived_at is not null and new.archived_at is null then
    raise exception 'a staff note cannot be un-archived'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists user_staff_notes_no_rewrite on public.user_staff_notes;
create trigger user_staff_notes_no_rewrite
  before update or delete on public.user_staff_notes
  for each row execute function public.user_staff_notes_append_only();

-- RLS with no policies: the table is unreachable from any browser session.
--
-- Every read and write goes through a server route that has already checked a
-- staff permission. Postgres checks grants before RLS, so the revokes below are
-- the real gate and RLS is the second lock behind it.
alter table public.user_staff_notes enable row level security;

revoke all on public.user_staff_notes from public;
revoke all on public.user_staff_notes from anon;
revoke all on public.user_staff_notes from authenticated;
grant select, insert, update on public.user_staff_notes to service_role;
-- Deliberately no DELETE, to anyone. The trigger refuses it; the missing grant
-- means it is refused before the trigger is even reached.

-- ---------------------------------------------------------------------------
-- 2. The staff user directory
-- ---------------------------------------------------------------------------
--
-- One row per application user, carrying everything `/staff/users` sorts,
-- filters and searches on. It exists for the same reason `staff_order_queue`
-- does: the alternative is selecting every profile into the browser and
-- deciding there, which does not scale and ships every customer's record to
-- every staff client regardless of what the list shows.
--
-- SECURITY MODEL — read this before changing the grants.
--
-- This view is **security definer** (Postgres's default for views), unlike
-- `staff_order_queue`, which is `security_invoker = true`. That difference is
-- deliberate and is the whole reason the grants below are so narrow.
--
--   * The directory must be searchable by email, and email lives in
--     `auth.users`, not in `profiles`.
--   * `service_role` holds **no** grant on `auth.users` or `auth.identities` —
--     verified against production, only `postgres` does. So an invoker-rights
--     view over `auth` would fail for the one caller that needs it.
--
-- So the view runs with its owner's rights and is granted to `service_role`
-- alone. `anon` and `authenticated` are revoked explicitly: a row here carries
-- another person's email, sign-in time and lifetime spend, and navigation
-- visibility is not authorization.
--
-- The `auth` columns are named one at a time, never `u.*`. Selected: email,
-- email_confirmed_at, last_sign_in_at, banned_until, deleted_at. Everything
-- else in that table is either a secret (`encrypted_password`, the four token
-- columns, `reauthentication_token`) or is not staff's business
-- (`phone`, `raw_user_meta_data`, `is_super_admin`). Adding `u.*` here would
-- put password hashes one JSON response away from a browser.

create or replace view public.staff_user_directory as
select
  p.id,
  p.username,
  p.display_name,
  p.avatar_url,
  p.is_verified,
  p.donation_rank,
  p.is_op,
  p.karma,
  p.created_at,
  p.last_seen_at,

  -- auth facts, named individually. See the note above.
  u.email,
  (u.email_confirmed_at is not null) as email_confirmed,
  u.last_sign_in_at,
  (u.deleted_at is not null) as auth_deleted,
  (u.banned_until is not null and u.banned_until > now()) as auth_banned,

  coalesce(ur.role, 'member') as role_key,
  coalesce(r.name, initcap(coalesce(ur.role, 'member'))) as role_name,
  coalesce(r.rank, 0) as role_rank,
  coalesce(r.is_staff, false) as is_staff,

  -- Account status, derived from the moderation tables that already decide it.
  -- A separate status column would be a second answer to a question `user_bans`
  -- and `user_restrictions` already answer, and the two would drift.
  case
    when exists (
      select 1 from public.user_bans b where b.user_id = p.id and b.active
    ) then 'suspended'
    when exists (
      select 1 from public.user_restrictions x
      where x.user_id = p.id
        and x.active
        and (x.expires_at is null or x.expires_at > now())
    ) then 'restricted'
    else 'active'
  end as account_status,

  -- Provider *names* only. Never `identity_data`, which carries the claims the
  -- provider returned, and never a token.
  coalesce(
    (
      select array_agg(distinct i.provider order by i.provider)
      from auth.identities i
      where i.user_id = p.id
    ),
    array[]::text[]
  ) as providers,

  -- Commerce, over ACCOUNT-OWNED orders only.
  --
  -- `orders.customer_id = p.id` and nothing else. A guest order whose
  -- `guest_email` happens to equal this user's email is *not* counted, because
  -- email equality is not proof of ownership — it is a claim anybody who can
  -- type can make. Guest orders are surfaced separately and labelled as
  -- unclaimed; they never reach these numbers.
  coalesce(o.order_count, 0) as order_count,
  coalesce(o.completed_order_count, 0) as completed_order_count,
  coalesce(o.open_order_count, 0) as open_order_count,
  coalesce(o.cancelled_order_count, 0) as cancelled_order_count,
  coalesce(o.paid_order_count, 0) as paid_order_count,

  -- Spend is money actually received, not money quoted.
  --
  -- `amount_paid_cents` is zero on an unpaid quote, an abandoned checkout and a
  -- cancelled-before-payment order, so all three contribute nothing without
  -- needing to be excluded by name. `net_spend_cents` subtracts refunds and is
  -- floored at zero so an over-refund cannot render as negative lifetime spend.
  coalesce(o.paid_cents, 0) as paid_cents,
  coalesce(o.refunded_cents, 0) as refunded_cents,
  greatest(0, coalesce(o.paid_cents, 0) - coalesce(o.refunded_cents, 0)) as net_spend_cents,
  o.last_order_at,

  -- Production still open, reached through the user's orders *or* linked
  -- directly. `production_jobs.customer_id` already exists, so both paths are
  -- counted once via OR rather than summed from two queries.
  (
    select count(*)
    from public.production_jobs j
    where j.status not in ('completed', 'cancelled')
      and (
        j.customer_id = p.id
        or exists (
          select 1 from public.orders jo
          where jo.id = j.order_id and jo.customer_id = p.id
        )
      )
  )::int as open_production_count

from public.profiles p
left join auth.users u on u.id = p.id
left join public.user_roles ur on ur.user_id = p.id
left join public.roles r on r.key = ur.role
left join lateral (
  select
    count(*)::int as order_count,
    count(*) filter (where o2.status = 'completed')::int as completed_order_count,
    count(*) filter (
      where o2.status not in ('completed', 'cancelled', 'declined')
    )::int as open_order_count,
    count(*) filter (where o2.status = 'cancelled')::int as cancelled_order_count,
    count(*) filter (where o2.amount_paid_cents > 0)::int as paid_order_count,
    coalesce(sum(o2.amount_paid_cents), 0)::bigint as paid_cents,
    coalesce(sum(o2.amount_refunded_cents), 0)::bigint as refunded_cents,
    max(o2.created_at) as last_order_at
  from public.orders o2
  where o2.customer_id = p.id
) o on true;

comment on view public.staff_user_directory is
  'One row per application user for /staff/users. Security definer and granted to service_role only, because it reads auth.users which service_role cannot select directly. Counts account-owned orders only; guest orders are never included.';

-- GRANTS — least privilege, and load-bearing. See the security model above.
revoke all on public.staff_user_directory from public;
revoke all on public.staff_user_directory from anon;
revoke all on public.staff_user_directory from authenticated;
grant select on public.staff_user_directory to service_role;
