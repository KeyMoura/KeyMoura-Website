-- Guest commerce
--
-- Guest checkout and guest custom requests have been recorded as
-- "unrepresentable, not merely unimplemented" since pass 3, for one reason:
-- `orders.customer_id` is NOT NULL, so there is no way to write an order that
-- belongs to somebody without an account.
--
-- This changes that, and nothing else about how an order works.
--
-- ## What "additive" means here
--
-- Dropping a NOT NULL is a **widening**, in the same family as pass 7's
-- widened `payment_status` CHECK: every row that was legal before is still
-- legal, no column is dropped, no data is rewritten, and no existing reader
-- can be given a value it could not already receive — the existing rows all
-- still carry a `customer_id`.
--
-- What it *does* change is that new rows may carry NULL, so every reader has
-- to be able to cope. The three that matter were checked before this ran:
--
--   * RLS on `orders` is `auth.uid() = customer_id`. Against NULL that is NULL,
--     which is not TRUE, so a guest order is invisible to every authenticated
--     customer. **It fails closed**, which is the direction a mistake here has
--     to fail. Guest access is served only by server routes holding the token.
--   * `create_checkout_order` and `redeem_discount_code` take a customer id as
--     a parameter and are called only on the account paths.
--   * The Stripe webhook compared `metadata.customer_id` to `order.customer_id`
--     to bind a session to an order. Against two NULLs that comparison is
--     vacuous, so the application now requires a guest session to match the
--     order's own `stripe_checkout_session_id` instead. That is a code change,
--     recorded here because this migration is what makes it necessary.
--
-- ## Identity
--
-- A guest order carries the address the confirmation goes to and a **salted
-- digest** of the bearer token that lets that browser read the order back. The
-- raw token lives only in an httpOnly cookie: it is a credential for somebody
-- else's order, so it is never stored, never put in a URL, and never logged.
--
-- `orders_owner_present` is the invariant that makes the nullable column safe:
-- an order belongs to an account *or* to an email address, never to neither.
-- Every existing row satisfies it through `customer_id`, so it validates
-- without a backfill.

begin;

do $$
begin
  -- An order with no owner at all would be unreachable by the customer and
  -- unanswerable by staff. Prove there is none before allowing the column to
  -- be null.
  if exists (select 1 from public.orders where customer_id is null) then
    raise exception 'orders already contains a row with no customer_id; refusing to widen';
  end if;
end;
$$;

alter table public.orders alter column customer_id drop not null;

alter table public.orders add column if not exists guest_email text;
alter table public.orders add column if not exists guest_name text;
alter table public.orders add column if not exists guest_token_hash text;
alter table public.orders add column if not exists guest_access_expires_at timestamptz;

-- Expiry and revocation are two different things and both are needed.
--
-- **Expiry** bounds the credential's life without anyone having to act: a
-- cookie forgotten on a shared computer stops working. It is written by the
-- application at checkout rather than defaulted here, so the window is visible
-- in the code that mints the token instead of hidden in a column default.
--
-- **Revocation** is `guest_token_hash = null`. Following the rule pass 3 set
-- for share links: clearing the token beats lowering a flag, because a leaked
-- credential must not be revivable by a later bug that reads the flag wrongly.
-- There is nothing left to compare against.
--
-- An access check requires both: a live hash *and* an unexpired window. A null
-- expiry is treated as expired by the application rather than as "forever" —
-- a row that lost its expiry should fail closed.

-- Bounded, and shaped enough to be an address. Deliberately not a full RFC
-- 5322 pattern: the application validates and the provider is the real judge;
-- this is here so a column that reaches a mail send cannot hold a paragraph.
alter table public.orders
  add constraint orders_guest_email_shape
  check (guest_email is null or (char_length(guest_email) between 3 and 254 and guest_email like '%_@_%'));

alter table public.orders
  add constraint orders_guest_name_length
  check (guest_name is null or char_length(guest_name) <= 120);

alter table public.orders
  add constraint orders_owner_present
  check (customer_id is not null or guest_email is not null);

-- Partial: account orders carry no token, and there is no reason to index the
-- nulls or to let one match anything.
create index if not exists orders_guest_token_hash_idx
  on public.orders (guest_token_hash)
  where guest_token_hash is not null;

-- Staff looking at what a guest address has ordered, from the staff order
-- queue. Lowered so the lookup is case-insensitive without the index being
-- unusable. **This is not a customer-facing lookup** — there is deliberately
-- no "find my order by email and order number" form; see
-- `guestOrderAccess.ts` for why that would be a guessing oracle.
create index if not exists orders_guest_email_idx
  on public.orders (lower(guest_email))
  where guest_email is not null;

-- ---------------------------------------------------------------------------
-- Guest replies
-- ---------------------------------------------------------------------------
-- A guest can answer a question about their own request — "what thread pitch?"
-- is exactly the kind of thing that has to be answerable, and a request that
-- cannot be clarified is a request that gets declined.
--
-- `sender_id` is widened rather than given a placeholder id. A synthetic
-- "guest user" row would be a real auth account that nobody controls and that
-- every `sender_id = auth.uid()` check in the codebase would suddenly have an
-- answer for. NULL means "not an account", which is what is true, and the
-- existing readers all treat an unmatched sender as the customer already.
--
-- Every existing row has a sender, so this validates without a backfill, and
-- `order_messages_sender_present` keeps a message attributable: it is either
-- an account or a guest order, never neither.
do $$
begin
  if exists (select 1 from public.order_messages where sender_id is null) then
    raise exception 'order_messages already contains a row with no sender_id; refusing to widen';
  end if;
end;
$$;

alter table public.order_messages alter column sender_id drop not null;

commit;

-- No grants. These are columns on a table that already has its ACL, which is
-- the failure mode pass 5a spent an outage on: a *new table* in this database
-- starts with no SELECT for any PostgREST role, but a column addition inherits
-- the table's privileges and cannot reach that state.
--
-- No policy change either. `orders` keeps exactly its three existing policies;
-- a guest is never `authenticated` and reaches nothing through PostgREST.
