/**
 * The rules behind the staff page framework.
 *
 * Pure and dependency-free — no React, no `next/*` — so tab resolution and
 * status wording are testable as functions rather than only observable by
 * rendering a page. The components in `@/components/staff/StaffPage` are the
 * only consumers that render; everything decidable is decided here.
 *
 * **Why a module rather than props.** Before this pass eight staff pages each
 * decided independently what a "paid" chip looked like and which tab a `#hash`
 * meant. `/staff/orders` tinted payment states one way, the order page another,
 * and the fulfillment queue a third. A staff member learning that green means
 * settled on one page learned nothing that transferred. One table fixes that,
 * and a test can assert it.
 */

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export type StaffTab = {
  id: string;
  label: string;
  /** Hidden tabs stay in the list so the caller can keep one array. */
  available?: boolean;
  /** Rendered beside the label. `0` shows; `null`/`undefined` shows nothing. */
  count?: number | null;
};

/** The tabs a viewer may actually open, in declaration order. */
export function availableTabs(tabs: readonly StaffTab[]): StaffTab[] {
  return tabs.filter((tab) => tab.available !== false);
}

/**
 * Which tab a request resolves to.
 *
 * The rule is "an unknown or unavailable request falls back to the first
 * available tab", which matters more than it looks: `/staff/orders/<id>#production`
 * is linked from the dashboard, the production queue and the fulfillment queue,
 * and a viewer without `production.view` following one of those links must land
 * on a page rather than on an empty frame. Returning `null` for an empty tab set
 * keeps "there is nothing to show" distinguishable from "show the first thing".
 */
export function resolveTab(tabs: readonly StaffTab[], requested: string | null | undefined): string | null {
  const open = availableTabs(tabs);
  if (!open.length) return null;
  // Trim *before* stripping the `#`: a value arriving as `" #activity "` — from
  // a hand-typed URL or a copied link with trailing whitespace — anchors the
  // `^#` against a space and silently falls through to the first tab.
  const wanted = String(requested ?? "").trim().replace(/^#/, "").trim().toLowerCase();
  return open.find((tab) => tab.id === wanted)?.id ?? open[0].id;
}

/**
 * Legacy `#hash` anchors, mapped to the tabs that replaced them.
 *
 * The order workspace was one long page whose sections were reachable by
 * anchor, and those anchors are linked from the fulfillment queue
 * (`#fulfillment`), the production panel (`#production`) and the order page's
 * own "next step" button. Turning the sections into tabs would have broken
 * every one of those links; mapping them keeps the old URL meaningful and
 * lands the reader on the tab that now holds the thing they asked for.
 */
export const ORDER_TAB_ALIASES: Readonly<Record<string, string>> = {
  conversation: "messages",
  "shop-work": "production",
  "customer-review-package": "production",
  quote: "payment",
  activity: "activity",
  fulfillment: "fulfillment",
  production: "production",
  items: "items",
  payment: "payment",
  messages: "messages",
  returns: "returns",
  overview: "overview",
};

/** Resolve a hash against the alias table before matching it to a tab. */
export function resolveTabWithAliases(
  tabs: readonly StaffTab[],
  requested: string | null | undefined,
  aliases: Readonly<Record<string, string>>
): string | null {
  const raw = String(requested ?? "").replace(/^#/, "").trim().toLowerCase();
  return resolveTab(tabs, aliases[raw] ?? raw);
}

// ---------------------------------------------------------------------------
// Status chips
// ---------------------------------------------------------------------------

export type ChipTone = "neutral" | "accent" | "warning" | "danger" | "success";

/**
 * The colour a state gets, everywhere in staff.
 *
 * Grouped by what the colour *means* rather than by which table the value came
 * from, which is why `refunded`, `cancelled` and `failed` share a tone despite
 * living in three different columns:
 *
 * - **success** — settled, nothing further to do.
 * - **warning** — live work, or something a human should look at soon.
 * - **danger**  — a failure, or money that moved the wrong way.
 * - **accent**  — in flight and healthy.
 * - **neutral** — a fact with no urgency attached.
 */
const TONE_BY_STATE: Readonly<Record<string, ChipTone>> = {
  // Payment
  paid: "success",
  captured: "success",
  unpaid: "warning",
  pending: "warning",
  partially_paid: "warning",
  deposit_paid: "accent",
  refunded: "danger",
  partially_refunded: "danger",
  refund_failed: "danger",
  failed: "danger",
  // Order lifecycle
  requested: "warning",
  needs_information: "warning",
  accepted: "accent",
  awaiting_payment: "warning",
  in_progress: "accent",
  customer_review: "accent",
  final_review: "accent",
  ready: "success",
  completed: "success",
  declined: "neutral",
  cancelled: "neutral",
  canceled: "neutral",
  // Fulfillment
  unfulfilled: "warning",
  processing: "accent",
  ready_to_fulfill: "success",
  ready_for_pickup: "success",
  shipped: "accent",
  in_transit: "accent",
  delivered: "success",
  picked_up: "success",
  returned: "danger",
  partially_returned: "warning",
  not_required: "neutral",
  // Production
  queued: "warning",
  blocked: "danger",
  on_hold: "warning",
  done: "success",
  // Generic
  active: "success",
  published: "success",
  draft: "neutral",
  archived: "neutral",
  none: "neutral",
};

/** The tone for a raw database state value. Unknown values read as neutral. */
export function stateTone(value: string | null | undefined): ChipTone {
  return TONE_BY_STATE[String(value ?? "").trim().toLowerCase()] ?? "neutral";
}

/**
 * `in_progress` → `In progress`.
 *
 * Sentence case, not Title Case: "Awaiting Payment" reads like a proper noun
 * and every staff surface had its own version of this three-line helper.
 */
export function stateLabel(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const spaced = raw.replaceAll("_", " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The handful of states whose plain label would mislead. */
const STATE_OVERRIDES: Readonly<Record<string, string>> = {
  customer_review: "Quote review",
  final_review: "Finished-product review",
  not_required: "No delivery needed",
  ready_to_fulfill: "Ready to ship",
  ready_for_pickup: "Ready for pickup",
  needs_information: "Needs information",
};

/** The label a chip shows for a state value. */
export function stateText(value: string | null | undefined): string {
  const key = String(value ?? "").trim().toLowerCase();
  return STATE_OVERRIDES[key] ?? stateLabel(value);
}

// ---------------------------------------------------------------------------
// Attention severity
// ---------------------------------------------------------------------------

export type AttentionSeverity = "critical" | "warning" | "info";

/**
 * How loudly a dashboard queue row should present itself.
 *
 * Derived from the weight `operationsQueues.ts` already assigns, so the
 * dashboard's ordering and its colouring cannot disagree — the alternative was
 * a second switch statement listing every `AttentionKind` again, which is
 * exactly the kind of duplicate that drifts.
 */
export function attentionSeverity(weight: number): AttentionSeverity {
  if (weight >= 90) return "critical";
  if (weight >= 60) return "warning";
  return "info";
}
