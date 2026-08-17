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
  /**
   * `custom_request` or `direct_purchase`. Read by the production gate: a
   * bespoke order is always made before it can be sent, a catalogue purchase
   * of stock generally is not.
   */
  order_kind?: string | null;
  /**
   * The furthest-along linked production job, when the caller has it.
   *
   * Optional for the same reason as `paid_at`: `staff_order_queue` carries it
   * and the fulfillment queue — which reads `orders` through RLS, a table with
   * no such column — does not. Absent, the gate falls back to `order_kind` and
   * `status`, which every caller has.
   */
  production_status?: string | null;
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
  /**
   * Optional: only the dashboard selects it, to total what was collected in the
   * last seven days. The fulfillment queue does not, and a required field here
   * would have made every caller select a column it has no use for.
   */
  paid_at?: string | null;
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

// ---------------------------------------------------------------------------
// The production gate
// ---------------------------------------------------------------------------

/**
 * Production job states in which the goods physically exist.
 *
 * `ready_to_ship` and `ready_for_pickup` are production's own hand-off states —
 * the job is off the machine — so they count as made, not merely as finished
 * paperwork.
 */
export const PRODUCTION_DONE_STATUSES: readonly string[] = [
  "completed",
  "ready_to_ship",
  "ready_for_pickup",
];

/**
 * Order states in which production has finished on the *order* record.
 *
 * `final_review` is deliberately absent. The part exists by then, but the
 * customer has not signed it off, and packing something that may still be
 * revised is how a rejected part ends up in the post.
 */
export const ORDER_PRODUCTION_COMPLETE: readonly string[] = ["ready", "completed"];

/**
 * Whether anything has to be *made* before this order can be sent.
 *
 * Deliberately narrow. Paying for a catalogue product that is in stock does not
 * start a production job, and gating those on a status nobody sets would strand
 * every direct purchase in a queue waiting for work that will never happen —
 * `record_stripe_order_payment` moves *every* paid order to `in_progress`,
 * including a plain stock purchase, so `status` alone cannot answer this.
 *
 * Two things make an order need production: it is bespoke, or somebody opened a
 * job for it.
 */
export function requiresProduction(order: Pick<QueueOrder, "order_kind" | "production_status">): boolean {
  if (String(order.order_kind || "") === "custom_request") return true;
  return Boolean(String(order.production_status || "").trim());
}

/**
 * Whether the goods are made and may be handed to fulfillment.
 *
 * An order needing no production is complete by definition — there was nothing
 * to wait for. Where a job exists it is the authority, because it is the record
 * of the actual work; where one does not, the order's own status is.
 */
export function productionComplete(
  order: Pick<QueueOrder, "status" | "order_kind" | "production_status">
): boolean {
  if (!requiresProduction(order)) return true;
  const job = String(order.production_status || "").trim();
  if (job) return PRODUCTION_DONE_STATUSES.includes(job);
  return ORDER_PRODUCTION_COMPLETE.includes(String(order.status || ""));
}

export const FULFILLMENT_BUCKETS = [
  "awaiting_production",
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
  awaiting_production: {
    label: "In production",
    description: "Paid, but still being made. Not fulfillment work yet — it arrives here when production finishes.",
  },
  to_prepare: {
    label: "To prepare",
    description: "Made, paid and not started. These are the orders to pick and pack next.",
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

  // Somebody has physically started packing this. That is a deliberate act and
  // it is reported as what it is, even if the gate below would have said the
  // work was early — hiding started work is worse than showing it.
  if (state === "processing") return "in_progress";

  /*
   * The production gate.
   *
   * Without this, `unfulfilled` + paid fell straight through to `to_prepare`,
   * so an order landed on the packing bench the instant its payment cleared —
   * `record_stripe_order_payment` sets `status = 'in_progress'` on every paid
   * order, which is to say "production started", and the fulfillment queue was
   * reading that moment as "ready to pack". Production finishing is what hands
   * an order to fulfillment, and until it does this is somebody else's work.
   */
  if (!productionComplete(order)) return "awaiting_production";

  return "to_prepare";
}

/**
 * Buckets that represent live work, in the order a shop actually works them.
 *
 * `awaiting_production` leads because it is upstream of everything else: it is
 * what is coming, not what is late. It stays in this list rather than being
 * hidden so that every open order is still counted exactly once and the page's
 * claim that the counts add up survives — but `fulfillmentNextAction` names it
 * as somebody else's work, so it reads as a pipeline rather than a backlog.
 */
export const ACTIVE_FULFILLMENT_BUCKETS: readonly FulfillmentBucket[] = [
  "awaiting_production",
  "to_prepare",
  "in_progress",
  "ready",
  "in_transit",
  "awaiting_payment",
];

/**
 * Generic over the row, so a caller that selected more than `QueueOrder`
 * requires gets its own type back rather than the narrowed one. The fulfillment
 * queue reads an address and a handoff stamp it needs on the far side of this
 * call; widening them away here would have forced a cast at every use.
 */
export function groupByFulfillmentBucket<T extends QueueOrder>(
  orders: readonly T[]
): Record<FulfillmentBucket, T[]> {
  const grouped = Object.fromEntries(FULFILLMENT_BUCKETS.map((bucket) => [bucket, [] as T[]])) as Record<
    FulfillmentBucket,
    T[]
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
    case "awaiting_production":
      return "Waiting on production to finish";
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
  /** What happened. */
  title: string;
  /** What has to happen about it. */
  detail: string;
  /** The primary action, named as a verb phrase. */
  action: string;
  /**
   * Where that action is performed — the **tab** of the order workspace that
   * holds it, not just the order.
   *
   * Landing on the order's Overview and expecting the reader to find the
   * cancellation panel is how a dashboard becomes a list of links to the same
   * place. `#returns` puts them on the control.
   */
  href: string;
  /** Higher sorts first. Money and customer-blocking work outrank housekeeping. */
  weight: number;
};

/** Which tab of the order workspace each kind of work is done on. */
const ATTENTION_TAB: Readonly<Record<AttentionKind, string>> = {
  cancellation: "returns",
  return: "returns",
  tracking: "fulfillment",
  request: "overview",
  quote: "payment",
  overdue: "production",
  unfulfilled: "fulfillment",
  in_transit: "fulfillment",
  unpaid: "payment",
};

/** The order workspace, opened on the tab where this work is done. */
export const attentionHref = (kind: AttentionKind, orderId: string): string =>
  `/staff/orders/${orderId}#${ATTENTION_TAB[kind]}`;

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
  /** Fills in the two derived fields so no call site can forget one. */
  const add = (item: Omit<AttentionItem, "href">) => items.push({ ...item, href: attentionHref(item.kind, item.orderId) });

  for (const order of orders) {
    const name = order.order_number || order.product_name;
    const closed = CLOSED_ORDER_STATUSES.includes(order.status);

    if (OPEN_CANCELLATION.has(String(order.cancellation_status || "none"))) {
      add({
        kind: "cancellation",
        orderId: order.id,
        title: `Cancellation to decide — ${name}`,
        detail: "A customer has asked to cancel. Approving it is a staff decision.",
        action: "Review cancellation",
        weight: 100,
      });
    }
    if (OPEN_RETURN.has(String(order.return_status || "none"))) {
      add({
        kind: "return",
        orderId: order.id,
        title: `Return in progress — ${name}`,
        detail: "Review, receive or inspect this return.",
        action: "Progress return",
        weight: 95,
      });
    }
    if (missingTracking(order)) {
      add({
        kind: "tracking",
        orderId: order.id,
        title: `Shipped with no tracking — ${name}`,
        detail: "The customer has nothing to follow. Add the carrier and number.",
        action: "Add tracking",
        weight: 90,
      });
    }

    if (closed) continue;

    if (order.status === "requested") {
      add({
        kind: "request",
        orderId: order.id,
        title: `New request — ${name}`,
        detail: "Review the specifications and accept or decline.",
        action: "Review request",
        weight: 80,
      });
    }
    if (order.status === "accepted" && order.agreed_price_cents == null) {
      add({
        kind: "quote",
        orderId: order.id,
        title: `Quote to prepare — ${name}`,
        detail: "The request is accepted and has no price yet.",
        action: "Prepare quote",
        weight: 75,
      });
    }
    if (order.target_date && new Date(`${order.target_date}T00:00:00`) < today) {
      add({
        kind: "overdue",
        orderId: order.id,
        title: `Past its target date — ${name}`,
        detail: `Target was ${order.target_date}.`,
        action: "Check production",
        weight: 70,
      });
    }

    const bucket = fulfillmentBucket(order);
    if (bucket === "to_prepare" || bucket === "in_progress" || bucket === "ready") {
      add({
        kind: "unfulfilled",
        orderId: order.id,
        title: `Waiting to be sent — ${name}`,
        detail: fulfillmentNextAction(order),
        action: String(order.fulfillment_method) === "pickup" ? "Prepare pickup" : "Pack and ship",
        weight: 60,
      });
    } else if (bucket === "in_transit" && !missingTracking(order)) {
      add({
        kind: "in_transit",
        orderId: order.id,
        title: `Delivery to confirm — ${name}`,
        detail: "Shipped and not yet confirmed delivered.",
        action: "Confirm delivery",
        weight: 40,
      });
    } else if (bucket === "awaiting_payment") {
      add({
        kind: "unpaid",
        orderId: order.id,
        title: `Balance outstanding — ${name}`,
        // The `$` is not decoration. Browser-driving the rebuilt dashboard
        // showed this row reading "220.00 still to collect", which on a queue
        // that also counts days and quantities is a number with no unit.
        detail: `$${(outstandingBalanceCents(order) / 100).toFixed(2)} still to collect.`,
        action: "Collect balance",
        weight: 50,
      });
    }
  }

  return items.sort((a, b) => b.weight - a.weight || a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------------------
// Stock attention
// ---------------------------------------------------------------------------

export type StockProduct = {
  id: string;
  name: string;
  is_published: boolean;
  inventory_policy: string;
  inventory_quantity: number;
  low_stock_threshold: number;
  archived_at: string | null;
};

/**
 * Low and out-of-stock products, as attention rows.
 *
 * Stock was a separate panel at the bottom of the dashboard titled "Stock
 * alerts", below revenue. A published product at zero stock is not an alert to
 * read after the numbers — it is a product customers cannot buy, and it belongs
 * in the same queue as everything else that wants a human today.
 *
 * Archived and untracked products are excluded: an unlimited made-to-order
 * product's quantity is not a claim about anything.
 */
export function stockAttention(
  products: readonly StockProduct[]
): { id: string; title: string; detail: string; action: string; href: string; weight: number }[] {
  return products
    .filter(
      (product) =>
        !product.archived_at &&
        product.inventory_policy === "track" &&
        product.inventory_quantity <= product.low_stock_threshold
    )
    .map((product) => {
      const out = product.inventory_quantity <= 0;
      return {
        id: product.id,
        title: `${out ? "Out of stock" : "Low stock"} — ${product.name}`,
        detail: out
          ? product.is_published
            ? "Published with nothing on hand. Customers cannot buy it."
            : "Nothing on hand. The product is not published."
          : `${product.inventory_quantity} left, at or below the threshold of ${product.low_stock_threshold}.`,
        action: "Adjust stock",
        href: `/staff/inventory/${product.id}`,
        // An out-of-stock published product outranks unfulfilled work; a
        // low-stock warning sits below it.
        weight: out && product.is_published ? 85 : out ? 55 : 30,
      };
    })
    .sort((a, b) => b.weight - a.weight || a.title.localeCompare(b.title));
}
