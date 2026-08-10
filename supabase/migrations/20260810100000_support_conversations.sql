-- Support conversations — one canonical model for talking to a customer about
-- anything that is not already an order thread.
--
-- WHY THIS EXISTS
--
-- KeyMoura had exactly one place a customer could ask a question: `/contact`,
-- which sent one email through its own `new Resend(...)` client and stored
-- nothing. No record, no status, no owner, no history — every question anyone
-- has ever asked exists only in a mailbox. There is no support system to extend.
--
-- WHAT IS DELIBERATELY *NOT* BUILT HERE
--
-- `order_messages` is not touched, widened, or migrated. It is the conversation
-- on an order and stays exactly that; a support conversation *links* to an order
-- through `related_order_id` rather than swallowing its thread. Merging the two
-- would have meant making `order_messages.order_id` nullable and rewriting the
-- RLS policies of a live table, to gain a thread that still had nowhere to put a
-- subject, a category, a status or an owner.
--
-- ADDITIVE ONLY. Two new tables, one sequence, one view, four permissions. No
-- existing table is altered, no existing row is written, and nothing that reads
-- today reads differently.

begin;

-- ---------------------------------------------------------------------------
-- 1. Readable references
-- ---------------------------------------------------------------------------
--
-- `SUP-0001`, from a sequence and a BEFORE INSERT trigger — the same mechanism
-- `KM-0004` already uses. This is the concurrency-safe part: two simultaneous
-- submissions take two `nextval`s, and nothing anywhere reads a maximum and adds
-- one. A uuid stays the real identifier and is what URLs carry; the reference is
-- what a person reads out on a phone.

create sequence if not exists public.keymoura_support_number_seq start 1;

-- ---------------------------------------------------------------------------
-- 2. Conversations
-- ---------------------------------------------------------------------------

create table if not exists public.support_conversations (
  id uuid primary key default gen_random_uuid(),

  -- Assigned by trigger, never by the application. `not null` is enforced by the
  -- trigger filling it in before the constraint is checked.
  reference text not null unique,

  subject text not null,
  category text not null default 'general',
  status text not null default 'open',
  priority text not null default 'normal',

  -- The requester. Exactly one of these two, enforced below.
  --
  -- SET NULL rather than CASCADE: a customer exercising account deletion must
  -- not silently erase the record of a refund dispute. `requester_label` and
  -- `requester_email` are snapshotted at creation so the conversation stays
  -- attributable and answerable after the account is gone — the same trade-off
  -- `audit_logs.actor_label` and `user_staff_notes.author_label` already make.
  customer_id uuid references public.profiles (id) on delete set null,
  guest_email text,
  guest_name text,
  requester_label text not null,
  requester_email text,

  -- Optional context. SET NULL so removing an order cannot destroy the
  -- conversation about it.
  --
  -- NOTE ON OWNERSHIP: nothing in this schema can prove the requester owns this
  -- order — that is decided by the routes, which require `customer_id` equality
  -- for an account and a valid guest session cookie for a guest. The column is
  -- a link, not a claim.
  related_order_id uuid references public.orders (id) on delete set null,

  -- The staff member who owns it. SET NULL when they leave; `assigned_to_label`
  -- keeps the row readable.
  assigned_to uuid references public.profiles (id) on delete set null,
  assigned_to_label text,
  assigned_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  last_customer_message_at timestamptz,
  last_staff_message_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,

  -- Where it came from. One value today; a column rather than an assumption, so
  -- a second entry point does not require a migration to be distinguishable.
  source text not null default 'web',

  -- Collapses a double-submitted form into one conversation. Same mechanism as
  -- `order_messages.client_token`.
  client_token text,

  constraint support_conversations_subject_not_blank check (btrim(subject) <> ''),
  constraint support_conversations_subject_length check (char_length(subject) <= 140),

  constraint support_conversations_category_known check (
    category in ('general','order','custom_project','production','shipping','return','account','other')
  ),
  constraint support_conversations_status_known check (
    status in ('open','waiting_on_staff','waiting_on_customer','resolved','closed')
  ),
  constraint support_conversations_priority_known check (
    priority in ('low','normal','high','urgent')
  ),

  -- An account conversation or a guest conversation, never both and never
  -- neither. "Neither" would be a conversation nobody can be replied to.
  constraint support_conversations_one_requester check (
    (customer_id is not null and guest_email is null)
    or (customer_id is null and guest_email is not null)
  ),
  constraint support_conversations_requester_label_not_blank check (btrim(requester_label) <> ''),
  constraint support_conversations_guest_email_shape check (
    guest_email is null or guest_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),

  -- The status and its timestamp are one fact, so they cannot disagree. This is
  -- what stops the meaningless combinations: a row cannot be `open` while
  -- carrying a `resolved_at`, and cannot be `closed` with no record of when.
  constraint support_conversations_resolved_consistent check (
    (status = 'resolved') = (resolved_at is not null)
  ),
  constraint support_conversations_closed_consistent check (
    (status = 'closed') = (closed_at is not null)
  ),

  -- Assignment is a pair: a conversation is owned by somebody at a time, or by
  -- nobody. "Assigned, we do not know when" is not a state worth being able to
  -- represent.
  constraint support_conversations_assignment_complete check (
    (assigned_to is null and assigned_at is null)
    or (assigned_to is not null and assigned_at is not null)
  )
);

comment on table public.support_conversations is
  'One customer support conversation. Reachable by its owning account or, for a guest conversation, only through the guest order session that created it. Internal notes live in support_messages with visibility = internal and are never customer-visible.';
comment on column public.support_conversations.related_order_id is
  'A link, not a proof of ownership. The routes decide whether the requester may associate this order; email equality is never accepted as proof.';
comment on column public.support_conversations.requester_email is
  'Snapshot of the address we reply to, taken at creation. Kept so a conversation stays answerable after an account is deleted.';

-- The inbox's default ordering, indexed as it is actually queried: unresolved
-- first, then priority, then freshest activity.
create index if not exists support_conversations_attention_idx
  on public.support_conversations (priority, last_message_at desc)
  where status in ('open','waiting_on_staff','waiting_on_customer');

create index if not exists support_conversations_status_idx
  on public.support_conversations (status, last_message_at desc);

create index if not exists support_conversations_customer_idx
  on public.support_conversations (customer_id, last_message_at desc)
  where customer_id is not null;

create index if not exists support_conversations_order_idx
  on public.support_conversations (related_order_id, last_message_at desc)
  where related_order_id is not null;

create index if not exists support_conversations_assignee_idx
  on public.support_conversations (assigned_to, last_message_at desc)
  where assigned_to is not null;

create index if not exists support_conversations_unassigned_idx
  on public.support_conversations (last_message_at desc)
  where assigned_to is null and status in ('open','waiting_on_staff','waiting_on_customer');

-- A guest may hold at most one open conversation per submission burst; the token
-- is what collapses a double-submitted form. Partial, because most rows have no
-- token and a null is not a duplicate of another null.
create unique index if not exists support_conversations_client_token_idx
  on public.support_conversations (client_token)
  where client_token is not null;

-- ---------------------------------------------------------------------------
-- 3. Messages
-- ---------------------------------------------------------------------------
--
-- Customer replies, staff replies, system records and internal notes, in one
-- table, distinguished by two columns.
--
-- One table rather than two because the thread a staff member reads is
-- chronological and interleaved: an internal note explaining *why* the next
-- reply says what it says belongs immediately before that reply, and two tables
-- would mean merging them by timestamp in the application on every read — which
-- is also the version where the merge is written twice and one copy forgets to
-- filter.
--
-- The safety comes from `visibility` being a column every customer-facing query
-- filters on **in the query**, plus a CHECK that a customer can never author an
-- internal row.

create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),

  -- CASCADE for schema correctness; in practice unreachable, because the
  -- append-only trigger below refuses DELETE and no grant permits it.
  conversation_id uuid not null references public.support_conversations (id) on delete cascade,

  author_type text not null,
  -- SET NULL, not CASCADE: a staff member leaving must not delete the replies
  -- they sent a customer. `author_label` keeps the row attributable.
  author_user_id uuid references public.profiles (id) on delete set null,
  author_label text not null,

  visibility text not null default 'customer',
  body text not null,

  created_at timestamptz not null default now(),
  client_token text,

  constraint support_messages_author_type_known check (
    author_type in ('customer','staff','system')
  ),
  constraint support_messages_visibility_known check (
    visibility in ('customer','internal')
  ),
  -- The load-bearing one. A customer cannot author a staff-only note, whatever
  -- a route or a request body claims.
  constraint support_messages_customer_never_internal check (
    author_type <> 'customer' or visibility = 'customer'
  ),
  constraint support_messages_body_not_blank check (btrim(body) <> ''),
  constraint support_messages_body_length check (char_length(body) <= 5000),
  constraint support_messages_author_label_not_blank check (btrim(author_label) <> '')
);

comment on table public.support_messages is
  'Immutable conversation history. A row with visibility = internal is staff-only and must never reach a customer surface or an email. Append-only: no UPDATE, no DELETE, enforced by trigger and by withheld grants.';
comment on column public.support_messages.visibility is
  'customer = the requester may read it. internal = staff only, never emailed, never returned by a customer API.';

create index if not exists support_messages_conversation_idx
  on public.support_messages (conversation_id, created_at, id);

-- The customer-visible thread, indexed as the customer route reads it.
create index if not exists support_messages_customer_visible_idx
  on public.support_messages (conversation_id, created_at, id)
  where visibility = 'customer';

create unique index if not exists support_messages_client_token_idx
  on public.support_messages (conversation_id, client_token)
  where client_token is not null;

-- ---------------------------------------------------------------------------
-- 4. Reference assignment
-- ---------------------------------------------------------------------------

-- Invoker rights, deliberately. The function needs nothing the inserting role
-- does not already have (`service_role` holds `usage` on the sequence, granted
-- below), and a definer-rights trigger function is a privilege boundary to
-- justify rather than a default to reach for.
create or replace function public.assign_support_reference()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.reference is null or btrim(new.reference) = '' then
    new.reference := 'SUP-' || lpad(nextval('public.keymoura_support_number_seq')::text, 4, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists support_conversations_assign_reference on public.support_conversations;
create trigger support_conversations_assign_reference
  before insert on public.support_conversations
  for each row execute function public.assign_support_reference();

-- ---------------------------------------------------------------------------
-- 5. History is append-only, enforced in the database
-- ---------------------------------------------------------------------------
--
-- The application is not the only thing that can hold a service-role key, so
-- "the route never issues an UPDATE" is a statement about today's code rather
-- than a property of the data. A customer-visible message that can be quietly
-- reworded afterwards is worth less than no record at all — the same reasoning
-- that already governs `audit_logs` and `user_staff_notes`.

create or replace function public.support_messages_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'support_messages is append-only; conversation history cannot be deleted'
      using errcode = '42501';
  end if;
  raise exception 'support_messages is append-only; a message cannot be edited once sent'
    using errcode = '42501';
end;
$$;

drop trigger if exists support_messages_no_rewrite on public.support_messages;
create trigger support_messages_no_rewrite
  before update or delete on public.support_messages
  for each row execute function public.support_messages_append_only();

-- The conversation row itself *is* mutable — status, priority, assignment and
-- the activity timestamps are the whole point of it. What must not change is who
-- opened it and when.
create or replace function public.support_conversations_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.reference is distinct from old.reference
     or new.customer_id is distinct from old.customer_id
     or new.guest_email is distinct from old.guest_email
     or new.created_at is distinct from old.created_at then
    raise exception 'a support conversation''s identity and requester cannot be changed'
      using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists support_conversations_identity_guard on public.support_conversations;
create trigger support_conversations_identity_guard
  before update on public.support_conversations
  for each row execute function public.support_conversations_guard();

-- ---------------------------------------------------------------------------
-- 6. The staff inbox view
-- ---------------------------------------------------------------------------
--
-- One row per conversation, carrying everything `/staff/support` filters, sorts
-- and searches on, so none of it happens in a browser.
--
-- `security_invoker = true`, unlike `staff_user_directory`. That view had to be
-- definer because it reads `auth.users`, which `service_role` holds no grant on.
-- This one reads only `public` tables that `service_role` can already select, so
-- invoker rights are both sufficient and the safer default — the view cannot
-- grant its readers anything they do not already have.
--
-- No message body appears here. A list shows what a conversation *is*, not what
-- it says, and an inbox that carried bodies would be a screen full of customers'
-- words that is filtered, paginated and screenshotted.

create or replace view public.staff_support_queue
with (security_invoker = true)
as
select
  c.id,
  c.reference,
  c.subject,
  c.category,
  c.status,
  c.priority,
  c.customer_id,
  c.guest_email,
  c.guest_name,
  c.requester_label,
  c.requester_email,
  c.related_order_id,
  c.assigned_to,
  c.assigned_to_label,
  c.assigned_at,
  c.created_at,
  c.updated_at,
  c.last_message_at,
  c.last_customer_message_at,
  c.last_staff_message_at,
  c.resolved_at,
  c.closed_at,
  c.source,

  (c.customer_id is null) as is_guest,

  o.order_number as related_order_number,
  o.status as related_order_status,

  p.display_name as customer_display_name,
  p.username as customer_username,
  p.avatar_url as customer_avatar_url,

  -- Counted separately, because "three replies" and "three internal notes" are
  -- different facts and a combined number would answer neither question.
  (
    select count(*) from public.support_messages m
    where m.conversation_id = c.id and m.visibility = 'customer'
  )::int as message_count,
  (
    select count(*) from public.support_messages m
    where m.conversation_id = c.id and m.visibility = 'internal'
  )::int as note_count,

  -- Sort keys, computed here so the ordering is decided in Postgres and the
  -- route only names columns. `src/lib/support/domain.ts` mirrors both, and a
  -- test asserts the two agree.
  case c.status
    when 'open' then 0
    when 'waiting_on_staff' then 1
    when 'waiting_on_customer' then 2
    when 'resolved' then 3
    else 4
  end as status_rank,
  case c.priority
    when 'urgent' then 0
    when 'high' then 1
    when 'normal' then 2
    else 3
  end as priority_rank,
  (c.status in ('open','waiting_on_staff','waiting_on_customer')) as is_unresolved

from public.support_conversations c
left join public.profiles p on p.id = c.customer_id
left join public.orders o on o.id = c.related_order_id;

comment on view public.staff_support_queue is
  'One row per support conversation for /staff/support. Security invoker, granted to service_role only. Carries no message body: a list shows what a conversation is, not what it says.';

-- ---------------------------------------------------------------------------
-- 7. Grants and RLS
-- ---------------------------------------------------------------------------
--
-- RLS is enabled with no policies, and the grants are the real gate. Postgres
-- checks grants before RLS, so a table with no grant to `anon` or
-- `authenticated` is unreachable from any browser session whatever the policies
-- say — and this project has shipped the opposite mistake twice (pass 7's
-- production grants, pass 20's audit log), where a correct policy was never
-- reached because the grant was missing.
--
-- Every read and write goes through a server route that has already checked
-- either a support permission or the requester's own ownership.

alter table public.support_conversations enable row level security;
alter table public.support_messages enable row level security;

revoke all on public.support_conversations from public;
revoke all on public.support_conversations from anon;
revoke all on public.support_conversations from authenticated;
grant select, insert, update on public.support_conversations to service_role;
-- Deliberately no DELETE, to anyone.

revoke all on public.support_messages from public;
revoke all on public.support_messages from anon;
revoke all on public.support_messages from authenticated;
grant select, insert on public.support_messages to service_role;
-- Deliberately no UPDATE and no DELETE. The trigger refuses both; the missing
-- grants mean they are refused before the trigger is even reached.

revoke all on public.staff_support_queue from public;
revoke all on public.staff_support_queue from anon;
revoke all on public.staff_support_queue from authenticated;
grant select on public.staff_support_queue to service_role;

revoke all on sequence public.keymoura_support_number_seq from public;
revoke all on sequence public.keymoura_support_number_seq from anon;
revoke all on sequence public.keymoura_support_number_seq from authenticated;
grant usage, select on sequence public.keymoura_support_number_seq to service_role;

-- ---------------------------------------------------------------------------
-- 8. Permissions
-- ---------------------------------------------------------------------------
--
-- Four, split by what each actually lets somebody do. Reading a customer's
-- support history, writing to that customer in KeyMoura's name, deciding a
-- conversation's state, and deciding whose job it is are four different powers,
-- and the middle one is the only one that puts words in front of a customer.

insert into public.permissions (key, name, description) values
  ('support.view',   'View support',        'Read the support inbox, conversations, and internal notes.'),
  ('support.reply',  'Reply to customers',  'Send a customer-visible reply and add internal notes.'),
  ('support.manage', 'Manage support',      'Change status, priority and category, link an order, resolve and reopen.'),
  ('support.assign', 'Assign support',      'Assign a conversation to a staff member, or take it.')
on conflict (key) do update set name = excluded.name, description = excluded.description;

-- Granted to `admin`, and to the `support` role — which exists, is `is_staff`,
-- is ranked 40, and currently has **zero holders**, so this changes nobody's
-- access today. It is deliberately *not* granted to `moderator`: moderation is
-- about community content, and a moderator having customer order correspondence
-- by default is a wider grant than that role was created for.
insert into public.role_permissions (role_key, permission_key)
select role_key, permission_key
from (values
  ('admin','support.view'), ('admin','support.reply'),
  ('admin','support.manage'), ('admin','support.assign'),
  ('support','support.view'), ('support','support.reply'),
  ('support','support.manage'), ('support','support.assign')
) as grants(role_key, permission_key)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 9. Email templates
-- ---------------------------------------------------------------------------
--
-- Seeded here so `sendCommerceEmail` — the one sender — has a row to render.
-- There is no second sender and no second template store; `/api/contact`
-- constructed its own Resend client and is replaced by this pass.
--
-- `{{detail}}` carries a **customer-visible message body and nothing else**. The
-- internal-note path never calls the sender at all, which is what
-- `tests/support-system.test.ts` asserts — a variable name is not a safety
-- mechanism, and "the caller will pass the right thing" is not a guarantee.

insert into public.email_templates (key, name, subject, heading, body, button_label) values
  ('support_received',
   'Support request received',
   'We have your message — {{support_reference}}',
   'Thanks, we have your message',
   E'We have logged your request as {{support_reference}} and someone will reply as soon as they can.'
   || E'\n\nYou wrote: {{support_subject}}'
   || E'\n\nThere is nothing else you need to do.',
   'View your request'),
  ('support_staff_reply',
   'Support reply from KeyMoura',
   'Re: {{support_subject}} ({{support_reference}})',
   'A reply from KeyMoura',
   E'{{detail}}',
   'Read and reply'),
  ('support_resolved',
   'Support request resolved',
   'Resolved — {{support_reference}}',
   'We think this one is sorted',
   E'We have marked {{support_reference}} — {{support_subject}} — as resolved.'
   || E'\n\nIf that is not right, reply and it reopens straight away.',
   'View your request'),
  ('support_staff_new',
   'New support request (staff alert)',
   '[Support] {{support_reference}} — {{support_subject}}',
   'New support request',
   E'{{customer_name}} opened {{support_reference}}.\n\nSubject: {{support_subject}}',
   'Open in staff')
on conflict (key) do nothing;

notify pgrst, 'reload schema';

commit;
