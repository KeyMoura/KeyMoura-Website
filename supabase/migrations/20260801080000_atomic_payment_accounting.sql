begin;

create or replace function public.record_stripe_order_payment(
  p_order_id uuid,
  p_payment_intent_id text,
  p_amount_cents integer
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_order public.orders%rowtype;
  inserted_payment_id uuid;
  new_paid integer;
  new_net integer;
  fully_paid boolean;
begin
  if p_amount_cents is null or p_amount_cents < 1 or nullif(trim(p_payment_intent_id), '') is null then
    raise exception 'invalid_payment';
  end if;

  select * into selected_order from public.orders where id = p_order_id for update;
  if not found or selected_order.agreed_price_cents is null then
    raise exception 'order_not_payable';
  end if;

  insert into public.order_payments(order_id, stripe_payment_intent_id, amount_cents)
  values (p_order_id, p_payment_intent_id, p_amount_cents)
  on conflict (stripe_payment_intent_id) do nothing
  returning id into inserted_payment_id;

  if inserted_payment_id is null then
    return jsonb_build_object(
      'applied', false,
      'duplicate', true,
      'fully_paid', selected_order.payment_status = 'paid',
      'amount_paid_cents', selected_order.amount_paid_cents,
      'previous_status', selected_order.status
    );
  end if;

  new_paid := coalesce(selected_order.amount_paid_cents, 0) + p_amount_cents;
  new_net := new_paid - coalesce(selected_order.amount_refunded_cents, 0);
  if new_net > selected_order.agreed_price_cents then
    raise exception 'order_amount_mismatch';
  end if;

  fully_paid := new_net >= selected_order.agreed_price_cents;
  update public.orders set
    payment_status = case when fully_paid then 'paid' else 'partial' end,
    amount_paid_cents = new_paid,
    stripe_checkout_session_id = null,
    stripe_payment_intent_id = p_payment_intent_id,
    paid_at = case when fully_paid then now() else null end,
    status = 'in_progress'
  where id = p_order_id;

  if selected_order.status <> 'in_progress' then
    insert into public.order_status_history(order_id, from_status, to_status, changed_by, note)
    values (
      p_order_id,
      selected_order.status,
      'in_progress',
      null,
      case when fully_paid then 'Payment received; production started' else 'Deposit received; production started' end
    );
  end if;

  return jsonb_build_object(
    'applied', true,
    'duplicate', false,
    'fully_paid', fully_paid,
    'amount_paid_cents', new_paid,
    'previous_status', selected_order.status
  );
end $$;

create or replace function public.record_stripe_order_refund(
  p_order_id uuid,
  p_order_payment_id uuid,
  p_stripe_refund_id text,
  p_amount_cents integer,
  p_reason text,
  p_created_by uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_order public.orders%rowtype;
  selected_payment public.order_payments%rowtype;
  inserted_refund_id uuid;
  new_payment_refunded integer;
  new_total_refunded integer;
  fully_refunded boolean;
begin
  if p_amount_cents is null or p_amount_cents < 1 or nullif(trim(p_stripe_refund_id), '') is null then
    raise exception 'invalid_refund';
  end if;

  select * into selected_order from public.orders where id = p_order_id for update;
  select * into selected_payment from public.order_payments
    where id = p_order_payment_id and order_id = p_order_id for update;
  if selected_order.id is null or selected_payment.id is null then
    raise exception 'payment_not_found';
  end if;
  if p_amount_cents > selected_payment.amount_cents - selected_payment.amount_refunded_cents then
    raise exception 'refund_exceeds_payment';
  end if;
  if p_amount_cents > selected_order.amount_paid_cents - selected_order.amount_refunded_cents then
    raise exception 'refund_exceeds_order';
  end if;

  insert into public.order_refunds(
    order_id, order_payment_id, stripe_refund_id, amount_cents, reason, created_by
  ) values (
    p_order_id, p_order_payment_id, p_stripe_refund_id, p_amount_cents, left(trim(p_reason), 1000), p_created_by
  )
  on conflict (stripe_refund_id) do nothing
  returning id into inserted_refund_id;

  if inserted_refund_id is null then
    return jsonb_build_object('applied', false, 'duplicate', true, 'amount_refunded_cents', selected_order.amount_refunded_cents);
  end if;

  new_payment_refunded := selected_payment.amount_refunded_cents + p_amount_cents;
  new_total_refunded := selected_order.amount_refunded_cents + p_amount_cents;
  fully_refunded := new_total_refunded >= selected_order.amount_paid_cents;

  update public.order_payments set amount_refunded_cents = new_payment_refunded where id = selected_payment.id;
  update public.orders set
    amount_refunded_cents = new_total_refunded,
    payment_status = case when fully_refunded then 'refunded' else selected_order.payment_status end
  where id = selected_order.id;

  return jsonb_build_object(
    'applied', true,
    'duplicate', false,
    'fully_refunded', fully_refunded,
    'amount_refunded_cents', new_total_refunded
  );
end $$;

revoke all on function public.record_stripe_order_payment(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.record_stripe_order_refund(uuid, uuid, text, integer, text, uuid) from public, anon, authenticated;
grant execute on function public.record_stripe_order_payment(uuid, text, integer) to service_role;
grant execute on function public.record_stripe_order_refund(uuid, uuid, text, integer, text, uuid) to service_role;

notify pgrst, 'reload schema';
commit;
