/**
 * The filter model behind `/staff/orders`.
 *
 * Pure and dependency-free — no React, no `next/*`, no Supabase — so the page,
 * the API route, the dashboard's deep links and the tests all read the **same**
 * definition. The pass-9 lesson applies directly: a card reading 3 that opens a
 * list of 5 happens when the count and the list are filtered by two hand-written
 * copies of "needs action".
 *
 * ## Why the filters are named, not free-form
 *
 * Every filter is an enum over values the database CHECK constraints already
 * enumerate. The API route rejects anything not in these lists rather than
 * interpolating a caller's string into a query, so a filter parameter cannot
 * become a way to ask the database a question the UI never offered.
 *
 * ## Why views are derived, not stored
 *
 * A "saved view" here is a *named preset of these same filters*, not a second
 * mechanism. Selecting "Refund failures" writes the ordinary parameters into the
 * URL, so it is bookmarkable, back-button-safe, and — the point — a view cannot
 * drift from the filters it claims to apply, because it *is* them.
 */

import { PRODUCTION_STATUSES } from "../production/jobs.ts";

// ---------------------------------------------------------------------------
// Vocabularies — each mirrors a CHECK constraint on `public.orders`
// ---------------------------------------------------------------------------

export const ORDER_STATUSES = [
  "requested", "needs_information", "accepted", "awaiting_payment", "in_progress",
  "customer_review", "final_review", "ready", "completed", "declined", "cancelled",
] as const;

export const PAYMENT_STATUSES = [
  "not_required", "unpaid", "payment_pending", "partial", "paid",
  "partially_refunded", "refunded", "payment_failed", "payment_canceled",
] as const;

export const FULFILLMENT_STATUSES = [
  "not_required", "unfulfilled", "processing", "ready_to_fulfill", "ready_for_pickup",
  "picked_up", "shipped", "delivered", "returned", "partially_returned", "canceled",
] as const;

export const CANCELLATION_STATUSES = [
  "none", "requested", "under_review", "approved", "denied", "withdrawn",
  "refund_pending", "refund_failed", "completed",
] as const;

export const RETURN_STATUSES = [
  "none", "requested", "under_review", "approved", "denied", "awaiting_shipment",
  "in_transit", "received", "inspected", "refund_pending", "completed", "closed",
] as const;

export const FULFILLMENT_METHODS = ["shipping", "pickup", "none"] as const;
export const ORDER_KINDS = ["custom_request", "direct_purchase"] as const;
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

/**
 * Production-job states.
 *
 * Imported from the production domain rather than restated. The first draft of
 * this file guessed the vocabulary and got **nine of thirteen values wrong** —
 * `queued`, `materials_pending`, `awaiting_customer`, `rework`, `ready`,
 * `failed` and `blocked` are not states this schema has. Every one of those
 * would have produced a filter that silently matched nothing, which reads on
 * screen exactly like "no orders are in production".
 */
export const PRODUCTION_STATES = PRODUCTION_STATUSES;

export const SORTS = [
  "updated_desc", "created_desc", "created_asc", "priority", "target_date", "price_desc",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];
export type CancellationStatus = (typeof CANCELLATION_STATUSES)[number];
export type ReturnStatus = (typeof RETURN_STATUSES)[number];
export type FulfillmentMethod = (typeof FULFILLMENT_METHODS)[number];
export type OrderKind = (typeof ORDER_KINDS)[number];
export type Priority = (typeof PRIORITIES)[number];
export type OrderSort = (typeof SORTS)[number];

/**
 * Derived predicates that are not a single column.
 *
 * Kept as an explicit enum rather than a boolean per concept so the URL stays
 * short and so an unknown value is refused rather than silently ignored.
 */
export const FLAGS = [
  "requires_action",
  "overdue",
  "refund_failed",
  "inventory_issue",
  "unassigned",
] as const;
export type OrderFlag = (typeof FLAGS)[number];

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;
/** Bounded so a pasted search box cannot become an unbounded scan. */
export const MAX_SEARCH_LENGTH = 120;

// ---------------------------------------------------------------------------
// The filter shape
// ---------------------------------------------------------------------------

export type OrderFilters = {
  view: string | null;
  status: OrderStatus[];
  payment: PaymentStatus[];
  fulfillment: FulfillmentStatus[];
  method: FulfillmentMethod[];
  cancellation: CancellationStatus[];
  returns: ReturnStatus[];
  production: string[];
  kind: OrderKind[];
  priority: Priority[];
  flags: OrderFlag[];
  assignedTo: string | null;
  /** ISO date (YYYY-MM-DD), inclusive, against `created_at`. */
  from: string | null;
  to: string | null;
  search: string;
  sort: OrderSort;
  page: number;
  pageSize: number;
};

export function emptyFilters(): OrderFilters {
  return {
    view: null, status: [], payment: [], fulfillment: [], method: [], cancellation: [],
    returns: [], production: [], kind: [], priority: [], flags: [], assignedTo: null,
    from: null, to: null, search: "", sort: "updated_desc", page: 1, pageSize: DEFAULT_PAGE_SIZE,
  };
}

// ---------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------

export type SavedView = {
  id: string;
  label: string;
  /** What this view is for, shown as the list's subtitle so the queue explains itself. */
  description: string;
  group: "Attention" | "Money" | "Making" | "Sending" | "Closed";
  /**
   * True for the handful of views that get a chip above the list.
   *
   * All fifteen used to be rendered as a single wrapping row of chips, which at
   * 1280px was three lines of pills before the list started and at 375px filled
   * most of a screen. Six of them describe how a shop actually works through
   * its orders; the rest are real and useful and live in the Filters panel,
   * one dropdown away, rather than competing with the six every time the page
   * is opened.
   */
  primary?: boolean;
  filters: Partial<OrderFilters>;
};

/**
 * The named queues, in the order a shop actually works them.
 *
 * Each is a preset over the filters above. `SAVED_VIEWS` is the single source
 * the page's tabs, the dashboard's deep links and the tests all read.
 */
export const SAVED_VIEWS: readonly SavedView[] = [
  {
    /*
     * The default working queue, and the one the dashboard's "All open work"
     * link opens. It existed only as a bare `?flags=requires_action` URL, so
     * the page it landed on showed no chip selected and looked like an
     * unfiltered list that happened to be short.
     */
    id: "needs_attention", label: "Needs attention", group: "Attention", primary: true,
    description: "Every order waiting on somebody here — decisions, quotes, packing and chasing.",
    filters: { flags: ["requires_action"] },
  },
  {
    id: "needs_review", label: "New", group: "Attention", primary: true,
    description: "New requests waiting for someone to accept, decline or price them.",
    filters: { status: ["requested"], sort: "created_asc" },
  },
  {
    id: "awaiting_information", label: "Awaiting information", group: "Attention",
    description: "Waiting on the customer to supply something before work can continue.",
    filters: { status: ["needs_information"] },
  },
  {
    id: "awaiting_payment", label: "Awaiting payment", group: "Money", primary: true,
    description: "A balance has to be collected before these can be made or sent.",
    filters: { status: ["awaiting_payment"], payment: ["unpaid", "payment_pending", "partial"] },
  },
  {
    id: "paid_needs_production", label: "Paid — needs production", group: "Making",
    description: "Paid in full and not yet started. These are next on the bench.",
    filters: { payment: ["paid"], fulfillment: ["unfulfilled"], status: ["accepted", "in_progress", "ready"] },
  },
  {
    id: "in_production", label: "In production", group: "Making", primary: true,
    description: "Being made right now.",
    filters: { status: ["in_progress"] },
  },
  {
    id: "ready_to_fulfill", label: "Ready to fulfill", group: "Sending", primary: true,
    description: "Made and waiting to be packed, labelled or handed over.",
    filters: { fulfillment: ["ready_to_fulfill", "processing"] },
  },
  {
    id: "ready_for_pickup", label: "Ready for pickup", group: "Sending",
    description: "Waiting for the customer to collect in person.",
    filters: { fulfillment: ["ready_for_pickup"], method: ["pickup"] },
  },
  {
    id: "shipped", label: "Shipped", group: "Sending",
    description: "In the post and not yet confirmed delivered.",
    filters: { fulfillment: ["shipped"] },
  },
  {
    id: "cancellation_requests", label: "Cancellation requests", group: "Attention",
    description: "A customer has asked to cancel. Approving one is a staff decision.",
    filters: { cancellation: ["requested", "under_review", "refund_pending", "refund_failed"] },
  },
  {
    id: "return_requests", label: "Return requests", group: "Attention",
    description: "Returns to review, receive or inspect.",
    filters: {
      returns: ["requested", "under_review", "approved", "awaiting_shipment", "in_transit", "received", "inspected", "refund_pending"],
    },
  },
  {
    id: "refund_failures", label: "Refund failures", group: "Money",
    description: "A refund was attempted and refused. The money has not moved and the customer is waiting.",
    filters: { flags: ["refund_failed"] },
  },
  {
    id: "inventory_problems", label: "Inventory problems", group: "Attention",
    description: "Stock holds that lapsed or outlived the order's payment state.",
    filters: { flags: ["inventory_issue"] },
  },
  {
    id: "overdue", label: "Overdue", group: "Attention",
    description: "Past the target date and not finished.",
    filters: { flags: ["overdue"] },
  },
  {
    id: "completed", label: "Completed", group: "Closed", primary: true,
    description: "Delivered, collected or otherwise finished.",
    filters: { status: ["completed"], sort: "updated_desc" },
  },
  {
    id: "canceled", label: "Canceled", group: "Closed",
    description: "Cancelled or declined. Kept for the record.",
    filters: { status: ["cancelled", "declined"] },
  },
];

export const SAVED_VIEW_IDS: readonly string[] = SAVED_VIEWS.map((view) => view.id);
export const savedView = (id: string | null | undefined): SavedView | null =>
  SAVED_VIEWS.find((view) => view.id === id) ?? null;

/**
 * Apply a view's preset, letting explicit parameters win.
 *
 * A view sets a starting point; a staff member narrowing it further must not
 * have their choice silently overwritten by the preset they started from.
 */
export function applyView(filters: OrderFilters): OrderFilters {
  const view = savedView(filters.view);
  if (!view) return filters;
  const merged = { ...filters };
  for (const [key, value] of Object.entries(view.filters) as [keyof OrderFilters, unknown][]) {
    const current = merged[key];
    const unset = Array.isArray(current) ? current.length === 0 : current === null || current === "";
    // Preset arrays are sorted for the same reason parsed ones are: a view's
    // filters have to serialize to a string that re-parses to itself, or
    // selecting a view and then reloading the page yields different filters.
    if (unset) (merged as Record<string, unknown>)[key] = Array.isArray(value) ? [...value].sort() : value;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Query-parameter codec
// ---------------------------------------------------------------------------

/**
 * The URL parameter each filter uses. Stable, because these end up in
 * bookmarks, in the browser's history and in links written on the dashboard.
 */
export const PARAM = {
  view: "view", status: "status", payment: "payment", fulfillment: "fulfillment",
  method: "method", cancellation: "cancellation", returns: "returns", production: "production",
  kind: "kind", priority: "priority", flags: "flag", assignedTo: "assignee",
  from: "from", to: "to", search: "q", sort: "sort", page: "page", pageSize: "size",
} as const;

/**
 * Anything not in the vocabulary is dropped, never passed through to a query.
 *
 * The result is **sorted**, which makes parsing canonical: `status=a,b` and
 * `status=b,a` produce the same filters, so they serialize to the same string
 * and the round trip is an identity. Without this, navigating writes a URL that
 * re-parses to a *different-looking* value, and every equality check downstream
 * — including the effect dependency that decides whether to refetch — sees a
 * change that did not happen.
 */
function pickMany<T extends string>(raw: string | null | undefined, allowed: readonly T[]): T[] {
  if (!raw) return [];
  const set = new Set<string>(allowed);
  return [...new Set(raw.split(",").map((part) => part.trim()).filter((part) => set.has(part)))].sort() as T[];
}

const pickOne = <T extends string>(raw: string | null | undefined, allowed: readonly T[]): T | null =>
  raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : null;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date, so `2026-02-31` is refused rather than silently shifted by `Date`. */
function pickDate(raw: string | null | undefined): string | null {
  if (!raw || !ISO_DATE.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw ? null : raw;
}

function pickInt(raw: string | null | undefined, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Read filters out of any `URLSearchParams`-alike. Total: any input yields usable filters. */
export function parseOrderFilters(params: { get(key: string): string | null }): OrderFilters {
  const from = pickDate(params.get(PARAM.from));
  const to = pickDate(params.get(PARAM.to));
  // An inverted range is a typo, not a request for zero rows. Swapping is what
  // the staff member meant; refusing would show an empty list that looks like a
  // true "nothing matched".
  const [start, end] = from && to && from > to ? [to, from] : [from, to];

  return applyView({
    view: pickOne(params.get(PARAM.view), SAVED_VIEW_IDS as readonly string[]),
    status: pickMany(params.get(PARAM.status), ORDER_STATUSES),
    payment: pickMany(params.get(PARAM.payment), PAYMENT_STATUSES),
    fulfillment: pickMany(params.get(PARAM.fulfillment), FULFILLMENT_STATUSES),
    method: pickMany(params.get(PARAM.method), FULFILLMENT_METHODS),
    cancellation: pickMany(params.get(PARAM.cancellation), CANCELLATION_STATUSES),
    returns: pickMany(params.get(PARAM.returns), RETURN_STATUSES),
    production: pickMany(params.get(PARAM.production), PRODUCTION_STATES),
    kind: pickMany(params.get(PARAM.kind), ORDER_KINDS),
    priority: pickMany(params.get(PARAM.priority), PRIORITIES),
    flags: pickMany(params.get(PARAM.flags), FLAGS),
    assignedTo: (params.get(PARAM.assignedTo) ?? "").trim() || null,
    from: start,
    to: end,
    search: (params.get(PARAM.search) ?? "").trim().slice(0, MAX_SEARCH_LENGTH),
    sort: pickOne(params.get(PARAM.sort), SORTS) ?? "updated_desc",
    page: pickInt(params.get(PARAM.page), 1, 1, 10_000),
    pageSize: pickInt(params.get(PARAM.pageSize), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
  });
}

/**
 * Write filters back to a query string.
 *
 * Defaults are omitted so a clean URL stays clean, and the keys are emitted in
 * a fixed order so the same filter set always produces the *same* string —
 * otherwise the back button records visits that differ only by key order.
 */
export function serializeOrderFilters(filters: OrderFilters): string {
  const params = new URLSearchParams();
  const list = (key: string, values: readonly string[]) => {
    if (values.length) params.set(key, [...values].sort().join(","));
  };
  if (filters.view) params.set(PARAM.view, filters.view);
  list(PARAM.status, filters.status);
  list(PARAM.payment, filters.payment);
  list(PARAM.fulfillment, filters.fulfillment);
  list(PARAM.method, filters.method);
  list(PARAM.cancellation, filters.cancellation);
  list(PARAM.returns, filters.returns);
  list(PARAM.production, filters.production);
  list(PARAM.kind, filters.kind);
  list(PARAM.priority, filters.priority);
  list(PARAM.flags, filters.flags);
  if (filters.assignedTo) params.set(PARAM.assignedTo, filters.assignedTo);
  if (filters.from) params.set(PARAM.from, filters.from);
  if (filters.to) params.set(PARAM.to, filters.to);
  if (filters.search) params.set(PARAM.search, filters.search);
  if (filters.sort !== "updated_desc") params.set(PARAM.sort, filters.sort);
  if (filters.page > 1) params.set(PARAM.page, String(filters.page));
  if (filters.pageSize !== DEFAULT_PAGE_SIZE) params.set(PARAM.pageSize, String(filters.pageSize));
  return params.toString();
}

/** The href for a saved view, for the dashboard's deep links. */
export const viewHref = (id: string): string => `/staff/orders?${PARAM.view}=${encodeURIComponent(id)}`;

/**
 * Which saved view an attention-queue item belongs to.
 *
 * The dashboard counts its attention queue with `attentionQueue()` and this maps
 * each kind onto the list that contains exactly those orders — so "3
 * cancellations to decide" opens a list of those 3, not a general order list the
 * reader then has to filter by hand.
 *
 * Keyed by `AttentionKind` from `operationsQueues.ts`. A test asserts every kind
 * has an entry, so adding a kind without a destination fails rather than
 * silently linking nowhere.
 */
export const ATTENTION_VIEW: Readonly<Record<string, string>> = {
  cancellation: "cancellation_requests",
  return: "return_requests",
  unfulfilled: "ready_to_fulfill",
  in_transit: "shipped",
  quote: "needs_review",
  request: "needs_review",
  unpaid: "awaiting_payment",
  overdue: "overdue",
  tracking: "shipped",
};

/**
 * Everything that wants a human, as one filtered list.
 *
 * Points at the **saved view** rather than at the bare flag it applies. Both
 * produce the same rows, but arriving by the raw parameter left the page with
 * no chip selected — so a dashboard link landed on what looked like an
 * unfiltered list that happened to be short, with no way to see what had been
 * applied or to clear it.
 */
export const REQUIRES_ACTION_HREF = viewHref("needs_attention");

/** The views that earn a chip above the list. The rest live in the Filters panel. */
export const PRIMARY_SAVED_VIEWS: readonly SavedView[] = SAVED_VIEWS.filter((view) => view.primary);
export const SECONDARY_SAVED_VIEWS: readonly SavedView[] = SAVED_VIEWS.filter((view) => !view.primary);

// ---------------------------------------------------------------------------
// Active-filter description
// ---------------------------------------------------------------------------

export type ActiveFilter = { key: keyof OrderFilters; label: string; value: string };

const humanize = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** What is currently narrowing the list, so it can be shown and individually cleared. */
export function describeActiveFilters(filters: OrderFilters): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  const many = (key: keyof OrderFilters, label: string, values: readonly string[]) => {
    if (values.length) out.push({ key, label, value: values.map(humanize).join(", ") });
  };
  many("status", "Order status", filters.status);
  many("payment", "Payment", filters.payment);
  many("fulfillment", "Fulfillment", filters.fulfillment);
  many("method", "Method", filters.method);
  many("cancellation", "Cancellation", filters.cancellation);
  many("returns", "Return", filters.returns);
  many("production", "Production", filters.production);
  many("kind", "Order type", filters.kind);
  many("priority", "Priority", filters.priority);
  many("flags", "Flag", filters.flags);
  if (filters.assignedTo) out.push({ key: "assignedTo", label: "Assigned to", value: "Selected staff member" });
  if (filters.from) out.push({ key: "from", label: "Created from", value: filters.from });
  if (filters.to) out.push({ key: "to", label: "Created to", value: filters.to });
  if (filters.search) out.push({ key: "search", label: "Search", value: filters.search });
  return out;
}

export const hasActiveFilters = (filters: OrderFilters): boolean =>
  Boolean(filters.view) || describeActiveFilters(filters).length > 0;

/** Clear one filter, keeping the rest — and drop the view, since it no longer describes the list. */
export function clearFilter(filters: OrderFilters, key: keyof OrderFilters): OrderFilters {
  const next: OrderFilters = { ...filters, view: null, page: 1 };
  const current = next[key];
  if (Array.isArray(current)) (next as Record<string, unknown>)[key] = [];
  else if (key === "search") next.search = "";
  else (next as Record<string, unknown>)[key] = null;
  return next;
}
