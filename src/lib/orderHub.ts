export const ORDER_STATUS_STEPS = [
  "requested",
  "accepted",
  "customer_review",
  "awaiting_payment",
  "in_progress",
  "final_review",
  "ready",
  "completed",
] as const;

export function orderLabel(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Deliberately small customer projection. Internal workflow vocabulary must not
 * leak just because another production status was added to the database.
 */
export function orderCustomerStatus(status: string, fulfillmentStatus?: string | null) {
  if (["shipped", "in_transit"].includes(fulfillmentStatus ?? "")) return "Shipped";
  if (fulfillmentStatus === "ready_for_pickup") return "Ready for pickup";
  const labels: Record<string, string> = {
    requested: "Request received",
    needs_information: "Details needed",
    accepted: "Preparing your order",
    customer_review: "Your review needed",
    awaiting_payment: "Payment needed",
    awaiting_production: "Preparing your order",
    in_progress: "In production",
    production_active: "In production",
    qc: "Final checks",
    final_review: "Your review needed",
    ready: "Ready for fulfillment",
    fulfilled: "Shipped",
    completed: "Complete",
    declined: "Not proceeding",
    cancelled: "Cancelled",
  };
  return labels[status] ?? "Order in progress";
}

/**
 * "Is there still money due?" — asked of the amounts rather than of
 * `payment_status`.
 *
 * `payment_status !== "paid"` used to stand in for this, which broke the moment
 * the column gained `partially_refunded`: a settled order that was partly
 * refunded would have started telling its customer to pay again.
 */
function balanceRemains(order: {
  payment_status: string;
  agreed_price_cents: number | null;
  amount_paid_cents?: number | null;
  amount_refunded_cents?: number | null;
}) {
  if (!order.agreed_price_cents) return false;
  if (["paid", "partially_refunded", "refunded", "not_required"].includes(order.payment_status)) return false;
  if (order.amount_paid_cents == null) return true;
  return Math.max(0, (order.amount_paid_cents || 0) - (order.amount_refunded_cents || 0)) < order.agreed_price_cents;
}

export function orderNeedsCustomerAction(order: {
  status: string;
  payment_status: string;
  agreed_price_cents: number | null;
  amount_paid_cents?: number | null;
  amount_refunded_cents?: number | null;
  cancellation_status?: string | null;
}) {
  // A cancellation under review is the customer's live concern; asking them to
  // pay for an order they just asked to cancel is not.
  if (order.cancellation_status && !["none", "denied", "withdrawn"].includes(order.cancellation_status)) return false;
  return (
    order.status === "needs_information" ||
    ["customer_review", "final_review"].includes(order.status) ||
    (balanceRemains(order) && ["accepted", "awaiting_payment"].includes(order.status))
  );
}

export function orderNextStep(order: {
  status: string;
  payment_status: string;
  agreed_price_cents: number | null;
  amount_paid_cents?: number | null;
  amount_refunded_cents?: number | null;
  fulfillment_method?: "shipping" | "pickup";
  cancellation_status?: string | null;
  return_status?: string | null;
}) {
  // Lifecycle work the customer is waiting on outranks the ordinary flow.
  if (order.cancellation_status && !["none", "denied", "withdrawn", "completed"].includes(order.cancellation_status)) {
    return "Cancellation under review";
  }
  if (order.return_status && !["none", "denied", "closed", "completed"].includes(order.return_status)) {
    return "Return in progress";
  }
  if (order.payment_status === "payment_failed") return "Payment did not go through — try again";
  if (order.status === "needs_information") return "Reply with the requested details";
  if (order.status === "customer_review") return "Review KeyMoura’s latest update";
  if (order.status === "final_review") return "Approve the finished order";
  if (balanceRemains(order) && ["accepted", "awaiting_payment"].includes(order.status)) return "Payment is ready";
  if (order.status === "requested") return "Waiting for KeyMoura to review your request";
  if (order.status === "in_progress") return "Your order is being made";
  if (order.status === "ready") {
    return order.fulfillment_method === "pickup" ? "Ready for pickup" : "Ready or on its way";
  }
  if (order.status === "completed") return "Order complete";
  if (["declined", "cancelled"].includes(order.status)) return orderLabel(order.status);
  return orderLabel(order.status);
}

export function orderProgressIndex(status: string) {
  if (status === "needs_information") return 0;
  const index = ORDER_STATUS_STEPS.indexOf(status as (typeof ORDER_STATUS_STEPS)[number]);
  return index < 0 ? 0 : index;
}

export function moneyFromCents(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
}
