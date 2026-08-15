/**
 * The rules behind a customer's order history.
 *
 * Pure and dependency-free apart from the lifecycle vocabulary it projects, so
 * the page, the card and the tests all read one set of rules. Nothing here
 * queries anything: what a card *says* and what a card *offers* are decisions,
 * and decisions belong somewhere they can be tested without a database.
 *
 * ## The one rule everything else follows
 *
 * A history card may only state something the order's own columns say. Not
 * `updated_at` (which moves when staff edit a note), not a status inferred from
 * a date, and never an internal production state. Where the truthful answer is
 * "we do not know", the card says nothing rather than guessing — a delivery
 * date invented from a timestamp is worse than no delivery date, because the
 * customer will plan around it.
 *
 * ## Why the actions are derived here and gated on the server
 *
 * The actions a card offers are a *summary* of what the order detail page will
 * let the customer do. Everything genuinely consequential — paying, cancelling,
 * returning — is decided by `orderLifecycle` against fresh rows behind an API,
 * and this module deliberately cannot reach it. So the card never offers
 * "Request a return"; it offers the page that computes whether a return is
 * possible. Showing a self-service return button from a date and a status would
 * be inferring eligibility on the client, which is the one thing pass 8
 * established must never happen.
 */

import { orderCustomerStatus } from "../orderHub.ts";

// ---------------------------------------------------------------------------
// The shape a card needs
// ---------------------------------------------------------------------------

export type OrderHistoryItem = {
  id?: string | null;
  product_id?: string | null;
  product_name: string;
  product_slug?: string | null;
  quantity: number;
  unit_price_cents?: number | null;
  line_subtotal_cents?: number | null;
  selected_options?: Record<string, unknown> | null;
};

export type OrderHistoryOrder = {
  id: string;
  order_number: string | null;
  product_name: string;
  quantity?: number | null;
  status: string;
  payment_status: string;
  fulfillment_method: string | null;
  fulfillment_status: string | null;
  cancellation_status?: string | null;
  return_status?: string | null;
  agreed_price_cents: number | null;
  amount_paid_cents?: number | null;
  amount_refunded_cents?: number | null;
  tracking_url?: string | null;
  tracking_number?: string | null;
  shipping_carrier?: string | null;
  shipping_address?: Record<string, unknown> | null;
  pickup_location_snapshot?: Record<string, unknown> | null;
  created_at: string;
  ready_at?: string | null;
  shipped_at?: string | null;
  delivered_at?: string | null;
  picked_up_at?: string | null;
  order_items?: OrderHistoryItem[] | null;
};

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * The four tones a status may wear. Four rather than one per state: a colour
 * per status is fifteen colours nobody can learn, and the useful distinction is
 * only ever "is this finished, is it moving, does it want me, or did it stop".
 */
export type OrderTone = "progress" | "attention" | "complete" | "stopped";

export type OrderHistoryStatus = { label: string; tone: OrderTone };

/**
 * The headline a card leads with.
 *
 * Reuses `orderCustomerStatus` — the same lossy projection the order detail
 * page and the transactional email are titled from — so the list, the page and
 * the inbox cannot describe one order three ways. Cancellation and return work
 * outranks it, because an order the customer has asked to cancel is not
 * meaningfully "in production" to them any more.
 */
export function orderHistoryStatus(order: OrderHistoryOrder): OrderHistoryStatus {
  const cancellation = order.cancellation_status ?? "none";
  const returned = order.return_status ?? "none";

  if (order.status === "cancelled" || cancellation === "completed") {
    return { label: "Cancelled", tone: "stopped" };
  }
  if (order.status === "declined") return { label: "Not proceeding", tone: "stopped" };
  if (["requested", "under_review"].includes(cancellation)) {
    return { label: "Cancellation requested", tone: "attention" };
  }
  if (["approved", "refund_pending"].includes(cancellation)) {
    return { label: "Cancellation approved", tone: "attention" };
  }
  if (!["none", "denied", "closed", "completed"].includes(returned)) {
    return { label: "Return in progress", tone: "attention" };
  }

  if (order.payment_status === "refunded") return { label: "Refunded", tone: "stopped" };
  if (order.payment_status === "partially_refunded") return { label: "Partly refunded", tone: "complete" };
  if (order.payment_status === "payment_failed") return { label: "Payment failed", tone: "attention" };

  // Where the parcel got to outranks where the paperwork got to. An order that
  // is both `completed` and `delivered` is described by the shared projection
  // as "Complete", which is true and is not the thing the customer wants to
  // read — they want to know it arrived, and on what day.
  if (order.fulfillment_status === "delivered") return { label: "Delivered", tone: "complete" };
  if (order.fulfillment_status === "picked_up") return { label: "Picked up", tone: "complete" };

  const label = orderCustomerStatus(order.status, order.fulfillment_status);
  if (["Delivered", "Picked up", "Complete"].includes(label)) return { label, tone: "complete" };
  if (["Payment needed", "Your review needed", "Details needed"].includes(label)) {
    return { label, tone: "attention" };
  }
  return { label, tone: "progress" };
}

/**
 * "Delivered Aug 12", or nothing.
 *
 * Only columns whose *name* is the event are read. `updated_at` is not a
 * delivery date, and a status of "completed" is not evidence of when. An order
 * whose timestamp was never written says only what it is, which is honest.
 */
export function orderHistoryStatusDate(order: OrderHistoryOrder): string | null {
  if (order.delivered_at) return order.delivered_at;
  if (order.picked_up_at) return order.picked_up_at;
  if (order.shipped_at) return order.shipped_at;
  if (order.fulfillment_status === "ready_for_pickup" && order.ready_at) return order.ready_at;
  return null;
}

// ---------------------------------------------------------------------------
// The header strip
// ---------------------------------------------------------------------------

export type FulfillmentSummary = { label: string; value: string | null };

/**
 * "Ship to — Ethan", or "Pickup — KeyMoura", or just the method.
 *
 * The recipient's *name* and nothing else. A history list is a page a customer
 * opens in a coffee shop with somebody behind them; a street address on every
 * card is a privacy cost with no matching benefit, and the full address is one
 * click away on the order itself where it is actually needed.
 */
export function orderHistoryFulfillment(order: OrderHistoryOrder): FulfillmentSummary {
  if (order.fulfillment_method === "pickup") {
    const snapshot = order.pickup_location_snapshot;
    const name = snapshot && typeof snapshot.name === "string" ? snapshot.name.trim() : "";
    return { label: "Pickup", value: name || null };
  }
  const address = order.shipping_address;
  const recipient =
    address && typeof address.name === "string" && address.name.trim() ? address.name.trim() : null;
  // A first name is enough to tell two shipping destinations apart, which is
  // the only job this field has on a list.
  return { label: "Ship to", value: recipient ? recipient.split(/\s+/)[0] : null };
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/**
 * The lines a card should show, from whichever shape this order has.
 *
 * Two generations of orders exist. A cart checkout writes `order_items`, one
 * row per product, with the name and price copied at purchase time. A custom
 * request predates that and carries a single `product_name` on the order
 * itself. Both are real history and neither is being migrated, so the card
 * reads the line items when there are any and falls back to the order's own
 * product otherwise.
 *
 * The names and prices returned here are always the *snapshot* — what was
 * bought, at what it cost then. Only the picture is allowed to come from the
 * live product, and it is labelled as illustrative where that matters.
 */
export function orderHistoryItems(order: OrderHistoryOrder): OrderHistoryItem[] {
  const items = order.order_items ?? [];
  if (items.length) return items;
  return [
    {
      id: null,
      product_id: null,
      product_name: order.product_name,
      product_slug: null,
      quantity: Math.max(1, Number(order.quantity ?? 1)),
      unit_price_cents: null,
      line_subtotal_cents: null,
      selected_options: null,
    },
  ];
}

/**
 * The chosen options as one short line: `Blue · Large`.
 *
 * Values only, keys dropped, and capped. A configuration block belongs on the
 * order page; on a card it is there to tell two otherwise identical shift knobs
 * apart, and four words do that as well as a definition list does.
 */
export function orderHistoryOptionSummary(
  options: Record<string, unknown> | null | undefined,
  limit = 3
): string {
  if (!options) return "";
  const values: string[] = [];
  for (const value of Object.values(options)) {
    if (typeof value === "string" && value.trim()) values.push(value.trim());
    else if (typeof value === "number" && Number.isFinite(value)) values.push(String(value));
    if (values.length >= limit) break;
  }
  return values.join(" · ");
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type OrderAction = {
  key: string;
  label: string;
  href: string;
  /** `primary` is the one thing to do next; there is at most one per card. */
  role: "primary" | "secondary" | "quiet";
  /** Set when the destination is somebody else's site. */
  external?: boolean;
};

/**
 * What this order offers, in the order it should be offered.
 *
 * At most one primary, and never the full set: a card carrying six buttons has
 * told the customer nothing about which one they want. The rules are the
 * order's own state and nothing else — no eligibility is computed here, and
 * anything consequential links to the page that computes it properly.
 */
export function orderHistoryActions(order: OrderHistoryOrder): OrderAction[] {
  const detail = `/orders/${order.id}`;
  const actions: OrderAction[] = [];
  const cancellation = order.cancellation_status ?? "none";
  const stopped = ["cancelled", "declined"].includes(order.status) || cancellation === "completed";
  const isPickup = order.fulfillment_method === "pickup";

  // 1. The one thing the customer is being asked to do, if there is one. Each
  //    of these lands on the anchor the detail page reserves for its action
  //    panel, so the button and the thing it promised are on the same screen.
  if (!stopped) {
    if (order.status === "needs_information") {
      actions.push({ key: "respond", label: "Send details", href: `${detail}#customer-action`, role: "primary" });
    } else if (order.status === "customer_review") {
      actions.push({ key: "quote", label: "Review quote", href: `${detail}#customer-action`, role: "primary" });
    } else if (order.status === "final_review") {
      actions.push({ key: "approve", label: "Approve order", href: `${detail}#customer-action`, role: "primary" });
    } else if (orderHistoryBalanceCents(order) > 0) {
      actions.push({ key: "pay", label: "Pay now", href: `${detail}#customer-action`, role: "primary" });
    }
  }

  // 2. Following the parcel. Only a tracking URL somebody actually stored — a
  //    carrier name and a number are not a link, and guessing the carrier's URL
  //    format is how a customer ends up on a 404 blaming us for losing it.
  if (!stopped && order.tracking_url) {
    actions.push({
      key: "track",
      label: "Track package",
      href: order.tracking_url,
      role: actions.length ? "secondary" : "primary",
      external: true,
    });
  }

  // 3. Collection details, for the orders that have somewhere to be collected
  //    from. The snapshot is on the order page; this is the signpost.
  if (!stopped && isPickup && ["ready_for_pickup", "picked_up"].includes(order.fulfillment_status ?? "")) {
    actions.push({
      key: "pickup",
      label: "Pickup details",
      href: `${detail}#fulfillment`,
      role: actions.length ? "secondary" : "primary",
    });
  }

  // 4. Always available, and never the primary when something above is: the
  //    order page is where everything actually lives.
  actions.push({
    key: "view",
    label: "View order",
    href: detail,
    role: actions.length ? "secondary" : "primary",
  });

  // 5. Buying it again, which is a *link to the product* and deliberately not a
  //    one-click re-add. See `orderHistoryRepurchaseSlug`.
  const repurchase = orderHistoryRepurchaseSlug(order);
  if (repurchase) {
    actions.push({ key: "buy-again", label: "Buy it again", href: `/catalog/${repurchase}`, role: "secondary" });
  }

  // 6. Help, on the orders where "something is wrong with this" is a thing a
  //    customer might reasonably be thinking. Pre-associated with the order so
  //    nobody has to find their own order number to ask about it.
  if (orderHistoryCanAskForHelp(order)) {
    actions.push({
      key: "support",
      label: "Get help",
      href: `/support?order=${encodeURIComponent(order.id)}`,
      role: "quiet",
    });
  }

  return actions;
}

/**
 * The product to send a repeat purchase to, or null.
 *
 * ## Why this is a link and not an Add to cart
 *
 * The cart stores product ids and option *selections*, and prices them live
 * against the product's current option groups. That makes re-adding a
 * historical configuration safe against everything that fails loudly — a value
 * that was withdrawn, a product that is out of stock, one that now needs a
 * quote, one that lost its fixed price — because `priceLine` rejects each of
 * those outright.
 *
 * It is not safe against the failure that is silent. An option *group* removed
 * from the product since the purchase is simply not in the current groups, so
 * the stored selection for it is dropped without complaint and the customer is
 * sold a similar object that is missing the thing that distinguished the one
 * they liked. Deciding whether that has happened means comparing the snapshot's
 * option keys against the product's current ones, which is a query and a
 * comparison per distinct product on the page, to save a customer one click on
 * a page they were going to look at anyway.
 *
 * So: repeat purchase means "open the product", where the options that exist
 * *now* are the ones on offer, and what was bought before stays visible and
 * unaltered on the order. That is the conservative half of the trade and the
 * only half that cannot quietly sell somebody the wrong thing.
 *
 * Offered only on a finished order — repurchasing something still in
 * production is not a thing anyone means to do — and only when the order has
 * exactly one line, because "buy it again" on a four-item order does not say
 * which again.
 */
export function orderHistoryRepurchaseSlug(order: OrderHistoryOrder): string | null {
  const finished =
    order.status === "completed" ||
    ["delivered", "picked_up"].includes(order.fulfillment_status ?? "");
  if (!finished) return null;
  const items = order.order_items ?? [];
  if (items.length !== 1) return null;
  const slug = items[0].product_slug?.trim();
  return slug || null;
}

/**
 * Whether a "Get help" link belongs on this card.
 *
 * Delivered and finished orders, and stopped ones — the moments where the
 * customer has a thing in their hands, or does not have a thing they expected.
 * An order still moving through production has the order chat on its own page,
 * which keeps the conversation attached to the order rather than opening a
 * second thread about it.
 */
export function orderHistoryCanAskForHelp(order: OrderHistoryOrder): boolean {
  if (["cancelled", "declined"].includes(order.status)) return true;
  if (order.status === "completed") return true;
  return ["delivered", "picked_up", "returned", "partially_returned"].includes(order.fulfillment_status ?? "");
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * What is still owed, in integer minor units.
 *
 * Asked of the amounts rather than of `payment_status`, for the reason
 * `orderHub.balanceRemains` documents: a settled order that was partly refunded
 * would otherwise start telling its customer to pay again. Terminal states owe
 * nothing regardless of arithmetic.
 */
export function orderHistoryBalanceCents(order: OrderHistoryOrder): number {
  if (["cancelled", "declined"].includes(order.status)) return 0;
  if (order.agreed_price_cents == null) return 0;
  if (["paid", "partially_refunded", "refunded", "not_required"].includes(order.payment_status)) return 0;
  const paid = Math.max(0, Number(order.amount_paid_cents ?? 0));
  const refunded = Math.max(0, Number(order.amount_refunded_cents ?? 0));
  return Math.max(0, order.agreed_price_cents - Math.max(0, paid - refunded));
}

/** What has actually been given back, when that is worth saying out loud. */
export function orderHistoryRefundedCents(order: OrderHistoryOrder): number {
  return Math.max(0, Number(order.amount_refunded_cents ?? 0));
}

// ---------------------------------------------------------------------------
// Filtering, searching, sorting
// ---------------------------------------------------------------------------

export const ORDER_HISTORY_TABS = ["active", "completed", "cancelled", "all"] as const;
export type OrderHistoryTab = (typeof ORDER_HISTORY_TABS)[number];

export const ORDER_HISTORY_TAB_LABELS: Record<OrderHistoryTab, string> = {
  active: "Active",
  completed: "Completed",
  cancelled: "Cancelled & refunded",
  all: "All orders",
};

const CANCELLED = ["cancelled", "declined"];

export function orderHistoryTabOf(order: OrderHistoryOrder): Exclude<OrderHistoryTab, "all"> {
  if (CANCELLED.includes(order.status) || order.cancellation_status === "completed") return "cancelled";
  if (order.payment_status === "refunded") return "cancelled";
  if (order.status === "completed") return "completed";
  return "active";
}

export function filterOrderHistoryTab(
  orders: readonly OrderHistoryOrder[],
  tab: OrderHistoryTab
): OrderHistoryOrder[] {
  if (tab === "all") return [...orders];
  return orders.filter((order) => orderHistoryTabOf(order) === tab);
}

/**
 * Order number and product name, matched as a substring.
 *
 * Deliberately not full-text search. A customer has tens of orders, not
 * thousands; the two things they can actually remember are the number on the
 * confirmation email and roughly what the thing was called, and a substring
 * match over a list already in memory answers both instantly and with no
 * infrastructure at all. `KM-0012`, `km0012` and `shift knob` all work.
 */
export function searchOrderHistory(
  orders: readonly OrderHistoryOrder[],
  query: string
): OrderHistoryOrder[] {
  const term = query.trim().toLowerCase();
  if (!term) return [...orders];
  // A typed `KM-12` should find `KM-0012`, and a pasted number should not be
  // defeated by the hyphen the customer did or did not include.
  const loose = term.replace(/[\s-]/g, "");
  return orders.filter((order) => {
    const number = (order.order_number ?? "").toLowerCase();
    if (number.includes(term) || number.replace(/[\s-]/g, "").includes(loose)) return true;
    const names = [order.product_name, ...orderHistoryItems(order).map((item) => item.product_name)];
    return names.some((name) => name.toLowerCase().includes(term));
  });
}

export const ORDER_HISTORY_SORTS = ["newest", "oldest"] as const;
export type OrderHistorySort = (typeof ORDER_HISTORY_SORTS)[number];

export const ORDER_HISTORY_SORT_OPTIONS: { value: OrderHistorySort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

/**
 * By when the order was placed, which is the date printed on the card.
 *
 * `updated_at` was the previous default and it is not a property of the
 * *order*: a staff note or an internal status touch reshuffles the list under a
 * customer who has done nothing, and the position no longer agrees with the
 * only date they can see. Sorting by the visible field is the whole rule.
 */
export function sortOrderHistory(
  orders: readonly OrderHistoryOrder[],
  sort: OrderHistorySort
): OrderHistoryOrder[] {
  const direction = sort === "oldest" ? -1 : 1;
  return [...orders].sort(
    (left, right) => direction * (Date.parse(right.created_at) - Date.parse(left.created_at))
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** `Aug 11, 2026`. One formatter, so two cards cannot disagree about a date. */
export function orderHistoryDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(parsed);
}

/** `Aug 12` — the short form, for a date already in context. */
export function orderHistoryShortDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(parsed);
}
