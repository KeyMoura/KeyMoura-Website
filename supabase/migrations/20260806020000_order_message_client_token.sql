-- ============================================================================
-- One customer message per send, enforced by the database
-- ============================================================================
--
-- `POST /api/orders/[id]/messages` had no duplicate protection. The send button
-- carried no pending state, so two clicks produced two `order_messages` rows —
-- and because the email's event key was derived from the row id of the message
-- that had just been inserted, the second click computed a *different* key and
-- the customer received two emails.
--
-- A pending button fixes the common case. It does not fix a retried request, a
-- flaky connection that resends, or two tabs. The token does: the browser mints
-- one per composed message, and a second arrival with the same token is
-- recognised as the same send rather than a new one.
--
-- Additive in the strict sense: one nullable column and one partial unique
-- index. Every existing row keeps `null` and is unaffected — `null` values do
-- not collide in a unique index, so historic messages need no backfill and the
-- index does not have to be built over them.

alter table public.order_messages
  add column if not exists client_token text;

-- Scoped to the order, not global: two different orders may legitimately carry
-- the same token from the same browser session, and collapsing those would drop
-- a real message.
create unique index if not exists order_messages_client_token_idx
  on public.order_messages (order_id, client_token)
  where client_token is not null;

comment on column public.order_messages.client_token is
  'Per-send token minted by the client. Deduplicates a retried or double-clicked send; null on rows written before pass 11.';
