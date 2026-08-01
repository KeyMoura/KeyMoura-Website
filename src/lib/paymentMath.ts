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

export function checkoutAmountCents(order: PaymentAmounts) {
  const remaining = remainingBalanceCents(order);
  if (!remaining) return 0;
  if (netCollectedCents(order) > 0) return remaining;

  const configuredDeposit = order.deposit_amount_cents;
  if (configuredDeposit == null || configuredDeposit <= 0) return remaining;

  return Math.min(configuredDeposit, remaining);
}
