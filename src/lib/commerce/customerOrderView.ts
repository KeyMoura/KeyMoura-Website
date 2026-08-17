import { orderCustomerStatus } from "../orderHub.ts";

export type CustomerProgressStage = {
  key: string;
  label: string;
  state: "complete" | "current" | "upcoming";
  at?: string | null;
};

type ProgressOrder = {
  status: string;
  payment_status: string;
  fulfillment_method?: string | null;
  fulfillment_status?: string | null;
  created_at: string;
  amount_paid_cents?: number | null;
  quote_accepted_at?: string | null;
  ready_at?: string | null;
  shipped_at?: string | null;
  delivered_at?: string | null;
  picked_up_at?: string | null;
};

const paid = (order: ProgressOrder) =>
  Number(order.amount_paid_cents ?? 0) > 0 || ["paid", "partially_refunded", "refunded"].includes(order.payment_status);

/** A deliberately lossy, customer-safe projection of internal order state. */
export function customerOrderStatus(order: Pick<ProgressOrder, "status" | "fulfillment_status">): string {
  return orderCustomerStatus(order.status, order.fulfillment_status);
}

/**
 * Builds only applicable stages. Dates are attached solely to columns whose
 * meaning names that event; updated_at and staff production records are never
 * used as substitutes.
 */
export function customerOrderProgress(order: ProgressOrder): CustomerProgressStage[] {
  const isPickup = order.fulfillment_method === "pickup";
  const isRequest = ["requested", "needs_information", "customer_review", "accepted", "awaiting_payment"].includes(order.status);
  const stopped = ["declined", "cancelled"].includes(order.status);
  const fulfillment = String(order.fulfillment_status || "unfulfilled");

  const definitions = isRequest && !paid(order)
    ? [
        { key: "received", label: "Request submitted", done: true, at: order.created_at },
        { key: "accepted", label: "Request accepted", done: !["requested", "needs_information"].includes(order.status) },
        { key: "quote", label: "Quote ready", done: Boolean(order.quote_accepted_at) || order.status === "awaiting_payment", at: order.quote_accepted_at },
        { key: "payment", label: "Payment", done: paid(order) },
        { key: "production", label: "Production", done: ["in_progress", "final_review", "ready", "completed"].includes(order.status) },
        { key: "complete", label: "Complete", done: order.status === "completed" },
      ]
    : [
        { key: "received", label: "Order received", done: true, at: order.created_at },
        { key: "payment", label: "Payment confirmed", done: paid(order) },
        /*
         * Production is complete at `final_review` and later, and **not** at
         * `in_progress`.
         *
         * `in_progress` is set by `record_stripe_order_payment` the moment a
         * payment clears — it means production has *started*. Counting it as
         * done ticked this stage off at checkout, so a customer whose part had
         * not been touched saw "In production ✓" with "Ready to ship" as the
         * current step. The fulfillment states below it stay in the test
         * because an order can be handed over without a job ever existing.
         */
        { key: "production", label: isPickup && ["ready_for_pickup", "picked_up"].includes(fulfillment) ? "Production complete" : "In production", done: ["final_review", "ready", "completed"].includes(order.status) || ["ready_to_fulfill", "ready_for_pickup", "shipped", "delivered", "picked_up"].includes(fulfillment) },
        // Named for what the customer is waiting on rather than for the
        // internal review state: by here the part exists and the question is
        // when it goes out.
        ...(!isPickup ? [{ key: "checks", label: "Ready to ship", done: ["ready", "completed"].includes(order.status) || ["ready_to_fulfill", "shipped", "delivered"].includes(fulfillment) }] : []),
        ...(isPickup
          ? [
              { key: "pickup-ready", label: "Ready for pickup", done: ["ready_for_pickup", "picked_up"].includes(fulfillment), at: order.ready_at },
              { key: "picked-up", label: "Picked up", done: fulfillment === "picked_up", at: order.picked_up_at },
            ]
          : [
              { key: "shipped", label: "Shipped", done: ["shipped", "delivered"].includes(fulfillment), at: order.shipped_at },
              ...(fulfillment === "delivered" ? [{ key: "delivered", label: "Delivered", done: true, at: order.delivered_at }] : []),
            ]),
      ];

  if (stopped) return definitions.slice(0, 1).map((stage) => ({ ...stage, state: "complete" as const }));
  const firstIncomplete = definitions.findIndex((stage) => !stage.done);
  return definitions.map((stage, index) => ({
    key: stage.key,
    label: stage.label,
    at: stage.at,
    state: stage.done ? "complete" : index === firstIncomplete ? "current" : "upcoming",
  }));
}

export type CustomerPaymentSummary = {
  subtotal: number | null;
  discount: number;
  shipping: number | null;
  tax: number | null;
  total: number | null;
  paid: number;
  refunded: number;
  balance: number | null;
};

export function customerPaymentSummary(order: {
  subtotal_cents?: number | null; discount_cents?: number | null; shipping_cents?: number | null;
  tax_cents?: number | null; agreed_price_cents: number | null; amount_paid_cents?: number | null;
  amount_refunded_cents?: number | null;
  payment_status?: string | null;
}): CustomerPaymentSummary {
  const total = order.agreed_price_cents;
  const paidAmount = Math.max(0, Number(order.amount_paid_cents ?? 0));
  const refunded = Math.max(0, Number(order.amount_refunded_cents ?? 0));
  return {
    subtotal: order.subtotal_cents ?? null,
    discount: Math.max(0, Number(order.discount_cents ?? 0)),
    shipping: order.shipping_cents ?? null,
    tax: order.tax_cents ?? null,
    total,
    paid: paidAmount,
    refunded,
    balance: total == null ? null : ["paid", "partially_refunded", "refunded", "not_required"].includes(order.payment_status ?? "")
      ? 0
      : Math.max(0, total - paidAmount),
  };
}
