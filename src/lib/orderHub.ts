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

export function orderNeedsCustomerAction(order: {
  status: string;
  payment_status: string;
  agreed_price_cents: number | null;
}) {
  return (
    order.status === "needs_information" ||
    ["customer_review", "final_review"].includes(order.status) ||
    (Boolean(order.agreed_price_cents) &&
      order.payment_status !== "paid" &&
      ["accepted", "awaiting_payment"].includes(order.status))
  );
}

export function orderNextStep(order: {
  status: string;
  payment_status: string;
  agreed_price_cents: number | null;
  fulfillment_method?: "shipping" | "pickup";
}) {
  if (order.status === "needs_information") return "Reply with the requested details";
  if (order.status === "customer_review") return "Review KeyMoura’s latest update";
  if (order.status === "final_review") return "Approve the finished order";
  if (
    order.agreed_price_cents &&
    order.payment_status !== "paid" &&
    ["accepted", "awaiting_payment"].includes(order.status)
  ) return "Payment is ready";
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
