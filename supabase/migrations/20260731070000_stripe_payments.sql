begin;

alter table public.orders
  add column if not exists stripe_checkout_session_id text,
  add column if not exists stripe_payment_intent_id text,
  add column if not exists paid_at timestamptz;

create unique index if not exists orders_stripe_checkout_session_idx on public.orders(stripe_checkout_session_id) where stripe_checkout_session_id is not null;
create unique index if not exists orders_stripe_payment_intent_idx on public.orders(stripe_payment_intent_id) where stripe_payment_intent_id is not null;

create table if not exists public.stripe_webhook_events (
  stripe_event_id text primary key,
  event_type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
alter table public.stripe_webhook_events enable row level security;
revoke all on public.stripe_webhook_events from anon, authenticated;
grant select, insert, update, delete on public.stripe_webhook_events to service_role;

notify pgrst, 'reload schema';
commit;
