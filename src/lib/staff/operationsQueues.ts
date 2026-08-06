import {
  FULFILLMENT_DEPARTED,
  FULFILLMENT_STAFF_LABELS,
  lifecycleLabel,
  type FulfillmentState,
} from "../commerce/orderLifecycle.ts";

/**
 * The operational queues the staff area runs on.
 *
 * Pure and dependency-free, so the dashboard, the fulfillment queue and the
 * tests all read the same rules. Two surfaces disagreeing about what "needs
 * fulfilling" means is how a dashboard card says 3 while the queue it links to
 * shows 5, and it is the reason this is a module rather than a `filter` written
 * twice.
 *
 * **Every order lands in exactly one bucket**, so the counts add up to the
 * total and a card can link to a view that contains precisely what it counted.
 */

export type QueueOrder = {
  id: string;
  order_number: string | null;
  customer_id: string;
  product_name: string;
  status: string;
  quantity: number;
  agreed_price_cents: number | null;
  amount_paid_cents: number;
  amount_refunded_cents: number | null;
  payment_status: string;
  fulfillment_status: string | null;
  fulfillment_method: string | null;
  cancellation_status: string | null;
  return_status: string | null;
  shipping_carrier: string | null;
  tracking_number: string | null;
  ready_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  target_date: string | null;
  created_at: string;
  updated_at: string;
};

/** Order states in which no further work is expected. */
export const CLOSED_ORDER_STATUSES: readonly string[] = ["completed", "declined", "cancelled"];

/** The money still owed on an order, never negative. */
export function outstandingBalanceCents(order: {
  agreed_price_cents: number | null;
  amount_paid_cents: number;
  amount_refunded_cents: number | null;
}): number {
  const net = Math.max(0, (order.amount_paid_cents || 0) - (order.amount_refunded_cents || 0));
  return Math.max(0, (order.agreed_price_cents || 0) - net);
}

export const FULFILLMENT_BUCKETS = [
  "to_prepare",
  "in_progress",
  "ready",
  "in_transit",
  "awaiting_payment",
  "settled",
  "not_applicable",
] as const;
export type FulfillmentBucket = (typeof FULFILLMENT_BUCKETS)[number];

export const FULFILLMENT_BUCKET_COPY: Readonly<
  Record<FulfillmentBucket, { label: string; description: string }>
> = {
  to_prepare: {
    label: "To prepare",
    description: "Paid and not started. These are the orders to pick and pack next.",
  },
  in_progress: {
    label: "Being prepared",
    description: "Packing has started. Mark them packed, collected or shipped when they are done.",
  },
  ready: {
    label: "Ready to go",
    description: "Packed and waiting for a label to be bought or a customer to collect.",
  },
  in_transit: {
    label: "Out for delivery",
    description: "Shipped and not yet confirmed delivered. Confirm delivery when it lands.",
  },
  awaiting_payment: {
    label: "Waiting on payment",
    description: "Not fulfillable yet: the balance has to be collected first.",
  },
  settled: {
    label: "Completed",
    description: "Delivered, collected or returned. Nothing further to do.",
  },
  not_applicable: {
    label: "No delivery needed",
    description: "Cancelled, declined, or an order with nothing to send.",
  },
};

/**
 * Which fulfillment queue an order belongs in.
 *
 * The order of these tests is the rule. Payment is checked **before** anything
 * that would have somebody pick stock, because an unpaid order is not work — it
 * is a reason to chase an invoice — but it is checked *after* the departed and
 * terminal states, so an order that shipped and was then partly refunded does
 * not reappear on the packing bench.
 */
export function fulfillmentBucket(order: QueueOrder): FulfillmentBucket {
  const state = String(order.fulfillment_status || "unfulfilled");

  if (state === "canceled" || state === "not_required") return "not_applicable";
  if (CLOSED_ORDER_STATUSES.includes(order.status) && !FULFILLMENT_DEPARTED.includes(state as FulfillmentState)) {
    return "not_applicable";
  }
  if (state === "delivered" || state === "picked_up" || state === "returned" || state === "partially_returned") {
    return "settled";
  }
  if (state === "shipped") return "in_transit";
  if (state === "ready_to_fulfill" || state === "ready_for_pickup") return "ready";

  // Everything below here is work that has not started or has just started, so
  // the balance matters.
  if (outstandingBalanceCents(order) > 0) return "awaiting_payment";

  if (state === "processing") return "in_progress";
  return "to_prepare";
}

/** Buckets that represent live work, in the order a shop actually works them. */
export const ACTIVE_FULFILLMENT_BUCKETS: readonly FulfillmentBucket[] = [
  "to_prepare",
  "in_progress",
  "ready",
  "in_transit",
  "awaiting_payment",
];

export function groupByFulfillmentBucket(orders: readonly QueueOrder[]): Record<FulfillmentBucket, QueueOrder[]> {
  const grouped = Object.fromEntries(FULFILLMENT_BUCKETS.map((bucket) => [bucket, [] as QueueOrder[]])) as Record<
    FulfillmentBucket,
    QueueOrder[]
  >;
  for (const order of orders) grouped[fulfillmentBucket(order)].push(order);
  return grouped;
}

/**
 * A shipping order that has departed with no tracking number.
 *
 * Marking shipped without tracking is refused by the API, so this only ever
 * catches rows that predate that rule — which is exactly why it is worth
 * surfacing rather than assuming away.
 */
export function missingTracking(order: QueueOrder): boolean {
  return (
    String(order.fulfillment_method || "shipping") === "shipping" &&
    String(order.fulfillment_status || "") === "shipped" &&
    !String(order.tracking_number || "").trim()
  );
}

/** Human sentence for what fulfillment is waiting on. Used on cards and rows. */
export function fulfillmentNextAction(order: QueueOrder): string {
  switch (fulfillmentBucket(order)) {
    case "awaiting_payment":
      return "Collect the balance before fulfilling";
    case "to_prepare":
      return "Start preparing this order";
    case "in_progress":
      return String(order.fulfillment_method) === "pickup" ? "Mark ready for collection" : "Pack and ship";
    case "ready":
      return String(order.fulfillment_method) === "pickup" ? "Waiting for the customer to collect" : "Buy a label and ship";
    case "in_transit":
      return missingTracking(order) ? "Add the missing tracking number" : "Confirm delivery when it lands";
    case "settled":
      return lifecycleLabel(FULFILLMENT_STAFF_LABELS, String(order.fulfillment_status || ""));
    default:
      return "No delivery action";
  }
}

// ---------------------------------------------------------------------------
// Attention queue
// ---------------------------------------------------------------------------

export type AttentionKind =
  | "cancellation"
  | "return"
  | "unfulfilled"
  | "in_transit"
  | "quote"
  | "request"
  | "unpaid"
  | "overdue"
  | "tracking";

export type AttentionItem = {
  kind: AttentionKind;
  orderId: string;
  title: string;
  detail: string;
  /** Higher sorts first. Money and customer-blocking work outrank housekeeping. */
  weight: number;
};

const OPEN_CANCELLATION = new Set(["requested", "under_review", "refund_pending", "refund_failed"]);
const OPEN_RETURN = new Set([
  "requested",
  "under_review",
  "approved",
  "awaiting_shipment",
  "in_transit",
  "received",
  "inspected",
  "refund_pending",
]);

/**
 * Everything that wants a human, newest concern first.
 *
 * One order can raise more than one item — an overdue order with an open return
 * is two separate pieces of work, and collapsing them to one row is how the
 * return gets forgotten.
 */
export function attentionQueue(orders: readonly QueueOrder[], now: Date): AttentionItem[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const items: AttentionItem[] = [];

  for (const order of orders) {
    const name = order.order_number || order.product_name;
    const closed = CLOSED_ORDER_STATUSES.includes(order.status);

    if (OPEN_CANCELLATION.has(String(order.cancellation_status || "none"))) {
      items.push({
        kind: "cancellation",
        orderId: order.id,
        title: `Cancellation to decide — ${name}`,
        detail: "A customer has asked to cancel. Approving it is a staff decision.",
        weight: 100,
      });
    }
    if (OPEN_RETURN.has(String(order.return_status || "none"))) {
      items.push({
        kind: "return",
        orderId: order.id,
        title: `Return in progress — ${name}`,
        detail: "Review, receive or inspect this return.",
        weight: 95,
      });
    }
    if (missingTracking(order)) {
      items.push({
        kind: "tracking",
        orderId: order.id,
        title: `Shipped with no tracking — ${name}`,
        detail: "The customer has nothing to follow. Add the carrier and number.",
        weight: 90,
      });
    }

    if (closed) continue;

    if (order.status === "requested") {
      items.push({
        kind: "request",
        orderId: order.id,
        title: `New request — ${name}`,
        detail: "Review the specifications and accept or decline.",
        weight: 80,
      });
    }
    if (order.status === "accepted" && order.agreed_price_cents == null) {
      items.push({
        kind: "quote",
        orderId: order.id,
        title: `Quote to prepare — ${name}`,
        detail: "The request is accepted and has no price yet.",
        weight: 75,
      });
    }
    if (order.target_date && new Date(`${order.target_date}T00:00:00`) < today) {
      items.push({
        kind: "overdue",
        orderId: order.id,
        title: `Past its target date — ${name}`,
        detail: `Target was ${order.target_date}.`,
        weight: 70,
      });
    }

    const bucket = fulfillmentBucket(order);
    if (bucket === "to_prepare" || bucket === "in_progress" || bucket === "ready") {
      items.push({
        kind: "unfulfilled",
        orderId: order.id,
        title: `Waiting to be sent — ${name}`,
        detail: fulfillmentNextAction(order),
        weight: 60,
      });
    } else if (bucket === "in_transit" && !missingTracking(order)) {
      items.push({
        kind: "in_transit",
        orderId: order.id,
        title: `Delivery to confirm — ${name}`,
        detail: "Shipped and not yet confirmed delivered.",
        weight: 40,
      });
    } else if (bucket === "awaiting_payment") {
      items.push({
        kind: "unpaid",
        orderId: order.id,
        title: `Balance outstanding — ${name}`,
        detail: `${(outstandingBalanceCents(order) / 100).toFixed(2)} still to collect.`,
        weight: 50,
      });
    }
  }

  return items.sort((a, b) => b.weight - a.weight || a.title.localeCompare(b.title));
}
