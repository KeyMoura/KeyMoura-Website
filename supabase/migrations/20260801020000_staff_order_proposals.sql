begin;

alter table public.orders
  add column if not exists initiated_by_staff boolean not null default false,
  add column if not exists proposal_sent_at timestamptz,
  add column if not exists proposal_decided_at timestamptz,
  add column if not exists proposal_decline_reason text;

create index if not exists orders_pending_staff_proposals_idx
  on public.orders(customer_id, proposal_sent_at desc)
  where initiated_by_staff and status = 'requested';

notify pgrst, 'reload schema';
commit;
