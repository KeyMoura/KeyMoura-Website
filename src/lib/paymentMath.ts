export type PaymentAmounts = {
  agreed_price_cents: number | null;
  amount_paid_cents: number | null;
  amount_refunded_cents?: number | null;
  deposit_amount_cents?: number | null;
  payment_status?: string | null;
};

export function netCollectedCents(order: PaymentAmounts) {
  // An unpaid order can retain stale amount fields after a quote is revised.
  // The explicit payment state wins so stale data cannot hide checkout.
  if (order.payment_status === "unpaid" || order.payment_status === "not_required") return 0;
  return Math.max(0, (order.amount_paid_cents || 0) - (order.amount_refunded_cents || 0));
}

export function remainingBalanceCents(order: PaymentAmounts) {
  return Math.max(0, (order.agreed_price_cents || 0) - netCollectedCents(order));
}

/**
 * The most this order can still accept, by the database's own arithmetic.
 *
 * `record_stripe_order_payment` adds the new amount to `amount_paid_cents` and
 * raises `order_amount_mismatch` when the net exceeds `agreed_price_cents`.
 * That sum is taken from the **raw columns** and takes no notice of
 * `payment_status` — while `netCollectedCents` above deliberately does, so that
 * a re-quote can reset an order to `unpaid` without stale amounts hiding
 * checkout.
 *
 * The two disagree, and the disagreement is expensive: a checkout that asks
 * Stripe for more than the row can absorb produces a payment the webhook can
 * only refuse, which means money taken and never recorded against the order.
 * This is the amount the ledger will actually accept, so a route can clamp to
 * it and refuse *before* a card is charged rather than after.
 *
 * Deliberately not folded into `checkoutAmountCents`: that function answers
 * "what should we ask for", which a deposit rule may legitimately shrink. This
 * one answers "what can be banked", which is a hard ceiling.
 */
export function payableHeadroomCents(order: PaymentAmounts) {
  const banked = Math.max(0, (order.amount_paid_cents || 0) - (order.amount_refunded_cents || 0));
  return Math.max(0, (order.agreed_price_cents || 0) - banked);
}

export function checkoutAmountCents(order: PaymentAmounts) {
  const remaining = remainingBalanceCents(order);
  if (!remaining) return 0;
  if (netCollectedCents(order) > 0) return remaining;

  const configuredDeposit = order.deposit_amount_cents;
  if (configuredDeposit == null || configuredDeposit <= 0) return remaining;

  return Math.min(configuredDeposit, remaining);
}

/**
 * What to actually charge: what the quote asks for, capped by what the ledger
 * can bank. Every route that creates a Stripe session for an order balance uses
 * this rather than `checkoutAmountCents` directly.
 */
export function chargeableAmountCents(order: PaymentAmounts) {
  return Math.min(checkoutAmountCents(order), payableHeadroomCents(order));
}
