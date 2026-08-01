export type PaymentAmounts = {
  agreed_price_cents: number | null;
  amount_paid_cents: number | null;
  amount_refunded_cents?: number | null;
  deposit_amount_cents?: number | null;
};

export function netCollectedCents(order: PaymentAmounts) {
  return Math.max(0, (order.amount_paid_cents || 0) - (order.amount_refunded_cents || 0));
}

export function remainingBalanceCents(order: PaymentAmounts) {
  return Math.max(0, (order.agreed_price_cents || 0) - netCollectedCents(order));
}

export function checkoutAmountCents(order: PaymentAmounts) {
  const remaining = remainingBalanceCents(order);
  if (!remaining) return 0;
  if (netCollectedCents(order) > 0) return remaining;
  return Math.min(order.deposit_amount_cents || remaining, remaining);
}
