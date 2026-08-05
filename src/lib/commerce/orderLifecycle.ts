/**
 * The order lifecycle, stated once.
 *
 * Pure and dependency-free on purpose: the customer page, the staff workspace,
 * every route handler and the tests all import these definitions, so none of
 * them can quietly hold a different opinion about whether an order can be
 * cancelled. Anything needing a database, Stripe or a session belongs in
 * `orderLifecycleServer.ts`, not here.
 *
 * Five independent state fields rather than one enum. An order can be paid,
 * in production, carrying an open cancellation request and partly returned all
 * at once; a single column would need a value per combination and would still
 * be wrong the first time a new combination happened.
 */

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/**
 * `orders.status` — where the order is in the *commercial* conversation.
 * Unchanged by this pass: these eleven values predate it and every existing
 * reader keeps working.
 */
export const ORDER_STATES = [
  "requested",
  "needs_information",
  "accepted",
  "awaiting_payment",
  "customer_review",
  "in_progress",
  "final_review",
  "ready",
  "completed",
  "declined",
  "cancelled",
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export const PAYMENT_STATES = [
  "not_required",
  "unpaid",
  "payment_pending",
  "partial",
  "paid",
  "partially_refunded",
  "refunded",
  "payment_failed",
  "payment_canceled",
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const FULFILLMENT_STATES = [
  "not_required",
  "unfulfilled",
  "processing",
  // Added in pass 8. `ready_to_fulfill` is the packed-and-waiting state a
  // shipping order sits in between production finishing and a label being
  // bought; `canceled` is where fulfillment stops when the order itself is
  // cancelled, which previously had nowhere to go and left a cancelled order
  // reading "Not yet prepared" forever.
  "ready_to_fulfill",
  "ready_for_pickup",
  "picked_up",
  "shipped",
  "delivered",
  "returned",
  "partially_returned",
  "canceled",
] as const;
export type FulfillmentState = (typeof FULFILLMENT_STATES)[number];

export const CANCELLATION_STATES = [
  "none",
  "requested",
  "under_review",
  "approved",
  "denied",
  "withdrawn",
  "refund_pending",
  "refund_failed",
  "completed",
] as const;
export type CancellationState = (typeof CANCELLATION_STATES)[number];

export const RETURN_STATES = [
  "none",
  "requested",
  "under_review",
  "approved",
  "denied",
  "awaiting_shipment",
  "in_transit",
  "received",
  "inspected",
  "refund_pending",
  "completed",
  "closed",
] as const;
export type ReturnState = (typeof RETURN_STATES)[number];

export const REFUND_STATES = ["pending", "succeeded", "failed", "canceled"] as const;
export type RefundState = (typeof REFUND_STATES)[number];

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Fulfillment moves forward. A shipped order that silently becomes
 * "unfulfilled" is how a second label gets printed for a parcel already in the
 * post, so backward moves are not in the graph at all — a mistake is corrected
 * by editing the tracking details, which is audited, rather than by rewinding
 * the state.
 *
 * `returned` and `partially_returned` are reachable from every delivered-ish
 * state because that is where a return actually lands.
 */
export const FULFILLMENT_TRANSITIONS: Readonly<Record<FulfillmentState, readonly FulfillmentState[]>> = {
  not_required: ["unfulfilled", "canceled"],
  unfulfilled: ["processing", "not_required", "canceled"],
  processing: ["ready_to_fulfill", "ready_for_pickup", "shipped", "canceled"],
  // A packed order can still be handed over the counter or posted; it can no
  // longer be cancelled silently once it has left, which is why `canceled`
  // stops being reachable after `shipped` and `picked_up`.
  ready_to_fulfill: ["ready_for_pickup", "shipped", "canceled"],
  ready_for_pickup: ["picked_up", "shipped", "canceled"],
  picked_up: ["returned", "partially_returned"],
  shipped: ["delivered", "returned", "partially_returned"],
  delivered: ["returned", "partially_returned"],
  returned: [],
  partially_returned: ["returned"],
  canceled: [],
};

/**
 * The same graph, narrowed by how the order is actually being fulfilled.
 *
 * A pickup order must never be offered "Shipped", and a shipping order must
 * never be offered "Ready for pickup" — showing both is how a parcel gets a
 * tracking number and a collection slot at the same time. The narrowing is
 * applied server-side as well as in the UI, so hiding a control is a
 * convenience rather than the control.
 */
const METHOD_FORBIDDEN: Readonly<Record<string, readonly FulfillmentState[]>> = {
  shipping: ["ready_for_pickup", "picked_up"],
  pickup: ["shipped", "delivered"],
  none: ["ready_for_pickup", "picked_up", "shipped", "delivered", "ready_to_fulfill"],
};

export function fulfillmentTransitionsFor(from: string, method: string | null | undefined): FulfillmentState[] {
  const allowed = FULFILLMENT_TRANSITIONS[from as FulfillmentState];
  if (!Array.isArray(allowed)) return [];
  const forbidden = METHOD_FORBIDDEN[String(method || "shipping")] ?? [];
  return allowed.filter((state) => !forbidden.includes(state));
}

export function canTransitionFulfillmentForMethod(
  from: string,
  to: string,
  method: string | null | undefined
): boolean {
  if (from === to) return false;
  return (fulfillmentTransitionsFor(from, method) as readonly string[]).includes(to);
}

/**
 * Fulfillment states in which the order has physically left the shop. Read by
 * cancellation eligibility and by the reservation release rules.
 */
export const FULFILLMENT_DEPARTED: readonly FulfillmentState[] = ["shipped", "delivered", "picked_up"];

/** Which timestamp column a transition stamps, if any. */
export const FULFILLMENT_TIMESTAMP_COLUMN: Readonly<Partial<Record<FulfillmentState, string>>> = {
  ready_to_fulfill: "ready_at",
  ready_for_pickup: "ready_at",
  picked_up: "picked_up_at",
  shipped: "shipped_at",
  delivered: "delivered_at",
};

/**
 * Transitions that reach the customer. Staff are shown exactly this before
 * they confirm, so "what will the customer be told" is answered by the same
 * table that decides what is sent.
 */
export const FULFILLMENT_CUSTOMER_EMAIL: Readonly<Partial<Record<FulfillmentState, string>>> = {
  processing: "fulfillment_processing",
  ready_for_pickup: "order_ready_for_pickup",
  picked_up: "order_picked_up",
  shipped: "order_shipped",
  delivered: "order_delivered",
};

/**
 * A return's own progression. `denied` and `closed` are terminal; `completed`
 * can still be closed out administratively.
 */
export const RETURN_TRANSITIONS: Readonly<Record<ReturnState, readonly ReturnState[]>> = {
  none: ["requested"],
  requested: ["under_review", "approved", "denied"],
  under_review: ["approved", "denied"],
  approved: ["awaiting_shipment", "in_transit", "received"],
  denied: [],
  awaiting_shipment: ["in_transit", "received", "closed"],
  in_transit: ["received", "closed"],
  received: ["inspected"],
  inspected: ["refund_pending", "completed", "closed"],
  refund_pending: ["completed", "closed"],
  completed: ["closed"],
  closed: [],
};

export const CANCELLATION_REQUEST_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  pending: ["approved", "denied", "withdrawn"],
  // A denied request must not silently reopen. Starting again means a new
  // request, which is a new row with its own reason and timestamp.
  approved: ["completed", "failed"],
  denied: [],
  withdrawn: [],
  completed: [],
  failed: ["completed"],
};

export function canTransitionFulfillment(from: string, to: string): boolean {
  if (from === to) return false;
  const allowed = FULFILLMENT_TRANSITIONS[from as FulfillmentState];
  return Array.isArray(allowed) && (allowed as readonly string[]).includes(to);
}

export function canTransitionReturn(from: string, to: string): boolean {
  if (from === to) return false;
  const allowed = RETURN_TRANSITIONS[from as ReturnState];
  return Array.isArray(allowed) && (allowed as readonly string[]).includes(to);
}

export function canTransitionCancellationRequest(from: string, to: string): boolean {
  if (from === to) return false;
  const allowed = CANCELLATION_REQUEST_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export type CommercePolicy = {
  cancellation: {
    /** 0 means "for as long as the order stays otherwise eligible". */
    unpaidWindowHours: number;
    allowPaidRequests: boolean;
    blockAfterProductionStart: boolean;
    blockForCustomOrders: boolean;
    blockAfterMaterialsOrdered: boolean;
    nonRefundableDepositCents: number;
    policyText: string;
  };
  returns: {
    enabled: boolean;
    windowDays: number;
    allowCustomProducts: boolean;
    allowLocalPickupReturns: boolean;
    customerPaysReturnShipping: boolean;
    restockingFeePercent: number;
    requireInspection: boolean;
    returnAddress: Record<string, string> | null;
    instructions: string;
    policyText: string;
  };
  inventory: {
    commitOnPayment: boolean;
    restoreOnCancellation: boolean;
    restoreOnReturn: boolean;
    lowStockThresholdDefault: number;
  };
};

/**
 * Deliberately conservative. Custom and personalized work is not returnable
 * unless the owner turns it on: guessing generously here is guessing with the
 * shop's money, and a one-off part cannot be resold.
 */
export const DEFAULT_COMMERCE_POLICY: CommercePolicy = {
  cancellation: {
    unpaidWindowHours: 0,
    allowPaidRequests: true,
    blockAfterProductionStart: false,
    blockForCustomOrders: false,
    blockAfterMaterialsOrdered: true,
    nonRefundableDepositCents: 0,
    policyText: "",
  },
  returns: {
    enabled: true,
    windowDays: 30,
    allowCustomProducts: false,
    allowLocalPickupReturns: true,
    customerPaysReturnShipping: true,
    restockingFeePercent: 0,
    requireInspection: true,
    returnAddress: null,
    instructions: "",
    policyText: "",
  },
  inventory: {
    commitOnPayment: true,
    restoreOnCancellation: true,
    restoreOnReturn: true,
    lowStockThresholdDefault: 2,
  },
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const boundedInt = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
};

const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");

/**
 * Total: any input at all yields a usable policy. The column is `jsonb` with
 * only an object CHECK behind it, so a hand-edited row must not be able to
 * take cancellations offline by holding a string where a number belongs.
 */
export function parseCommercePolicy(raw: unknown): CommercePolicy {
  const root = asRecord(raw);
  const cancellation = asRecord(root.cancellation);
  const returns = asRecord(root.returns);
  const inventory = asRecord(root.inventory);
  const defaults = DEFAULT_COMMERCE_POLICY;

  const address = asRecord(returns.returnAddress);
  const addressEntries = Object.entries(address)
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .slice(0, 12)
    .map(([key, value]) => [key.slice(0, 40), String(value).slice(0, 200)] as const);

  return {
    cancellation: {
      unpaidWindowHours: boundedInt(cancellation.unpaidWindowHours, defaults.cancellation.unpaidWindowHours, 0, 8760),
      allowPaidRequests: bool(cancellation.allowPaidRequests, defaults.cancellation.allowPaidRequests),
      blockAfterProductionStart: bool(cancellation.blockAfterProductionStart, defaults.cancellation.blockAfterProductionStart),
      blockForCustomOrders: bool(cancellation.blockForCustomOrders, defaults.cancellation.blockForCustomOrders),
      blockAfterMaterialsOrdered: bool(cancellation.blockAfterMaterialsOrdered, defaults.cancellation.blockAfterMaterialsOrdered),
      nonRefundableDepositCents: boundedInt(cancellation.nonRefundableDepositCents, 0, 0, 100_000_00),
      policyText: text(cancellation.policyText, 4000),
    },
    returns: {
      enabled: bool(returns.enabled, defaults.returns.enabled),
      windowDays: boundedInt(returns.windowDays, defaults.returns.windowDays, 0, 730),
      allowCustomProducts: bool(returns.allowCustomProducts, defaults.returns.allowCustomProducts),
      allowLocalPickupReturns: bool(returns.allowLocalPickupReturns, defaults.returns.allowLocalPickupReturns),
      customerPaysReturnShipping: bool(returns.customerPaysReturnShipping, defaults.returns.customerPaysReturnShipping),
      restockingFeePercent: boundedInt(returns.restockingFeePercent, 0, 0, 100),
      requireInspection: bool(returns.requireInspection, defaults.returns.requireInspection),
      returnAddress: addressEntries.length ? Object.fromEntries(addressEntries) : null,
      instructions: text(returns.instructions, 4000),
      policyText: text(returns.policyText, 4000),
    },
    inventory: {
      commitOnPayment: bool(inventory.commitOnPayment, defaults.inventory.commitOnPayment),
      restoreOnCancellation: bool(inventory.restoreOnCancellation, defaults.inventory.restoreOnCancellation),
      restoreOnReturn: bool(inventory.restoreOnReturn, defaults.inventory.restoreOnReturn),
      lowStockThresholdDefault: boundedInt(inventory.lowStockThresholdDefault, 2, 0, 10_000),
    },
  };
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export type RefundableInput = {
  amount_paid_cents?: number | null;
  amount_refunded_cents?: number | null;
  /** Refunds already sent to Stripe and not yet confirmed. */
  pending_refund_cents?: number | null;
};

/**
 * What may still be refunded, in integer minor units.
 *
 * Pending refunds are subtracted as well as settled ones. Money that has been
 * handed to Stripe and not yet confirmed is money already committed; counting
 * it as available is precisely how an order gets refunded twice by two staff
 * members looking at the same screen.
 */
export function refundableCents(input: RefundableInput): number {
  const paid = Math.max(0, Math.trunc(input.amount_paid_cents || 0));
  const refunded = Math.max(0, Math.trunc(input.amount_refunded_cents || 0));
  const pending = Math.max(0, Math.trunc(input.pending_refund_cents || 0));
  return Math.max(0, paid - refunded - pending);
}

/** True once real money has been collected and not fully given back. */
export function hasCollectedPayment(order: { payment_status?: string | null; amount_paid_cents?: number | null; amount_refunded_cents?: number | null }): boolean {
  if (order.payment_status === "unpaid" || order.payment_status === "not_required") return false;
  if (order.payment_status === "payment_failed" || order.payment_status === "payment_canceled") return false;
  return Math.max(0, (order.amount_paid_cents || 0) - (order.amount_refunded_cents || 0)) > 0;
}

/** True when the customer has paid at least something, refunds aside. */
export function paymentWasTaken(order: { payment_status?: string | null; amount_paid_cents?: number | null }): boolean {
  return (order.amount_paid_cents || 0) > 0 ||
    order.payment_status === "paid" ||
    order.payment_status === "partial" ||
    order.payment_status === "partially_refunded" ||
    order.payment_status === "refunded";
}

// ---------------------------------------------------------------------------
// Cancellation eligibility
// ---------------------------------------------------------------------------

export const CANCELLATION_REASONS = [
  { code: "changed_mind", label: "I changed my mind" },
  { code: "ordered_by_mistake", label: "I ordered this by mistake" },
  { code: "found_another_option", label: "I found another option" },
  { code: "taking_too_long", label: "It is taking longer than I expected" },
  { code: "no_longer_needed", label: "I no longer need it" },
  { code: "duplicate_order", label: "This is a duplicate order" },
  { code: "incorrect_details", label: "The order details are wrong" },
  { code: "other", label: "Something else" },
] as const;

export type CancellationReasonCode = (typeof CANCELLATION_REASONS)[number]["code"];

export const CANCELLATION_REASON_CODES: readonly string[] = CANCELLATION_REASONS.map((entry) => entry.code);

export type CancellationEligibilityInput = {
  status: string;
  payment_status: string;
  cancellation_status: string;
  fulfillment_status: string;
  order_kind?: string | null;
  created_at?: string | null;
  amount_paid_cents?: number | null;
  amount_refunded_cents?: number | null;
  /** Set when the order already carries an open request. */
  hasOpenRequest?: boolean;
  /** The furthest-along linked production job, if any. */
  productionStatus?: string | null;
  /** True when any linked job has moved past planning into real work. */
  materialsOrdered?: boolean;
  isCustomOrder?: boolean;
  policy?: CommercePolicy;
  now?: Date;
};

export type CancellationEligibility =
  | { kind: "immediate"; refundableCents: 0 }
  | { kind: "request"; refundableCents: number; note: string }
  | { kind: "pending"; note: string }
  | { kind: "unavailable"; reason: string };

/** Production states that mean real work or spend has started. */
const PRODUCTION_STARTED = new Set([
  "in_progress",
  "quality_check",
  "rework_required",
  "ready_for_pickup",
  "ready_to_ship",
  "completed",
]);

const MATERIALS_COMMITTED = new Set(["waiting_on_materials", "scheduled", ...PRODUCTION_STARTED]);

/**
 * Whether a customer may cancel, and by which route.
 *
 * Returns one of three usable outcomes and one refusal, each carrying the
 * sentence the customer should see. Deciding this on the client would make it
 * a suggestion; every route re-runs it server-side against fresh rows.
 */
export function evaluateCancellation(input: CancellationEligibilityInput): CancellationEligibility {
  const rules = (input.policy ?? DEFAULT_COMMERCE_POLICY).cancellation;

  if (input.status === "cancelled" || input.cancellation_status === "completed") {
    return { kind: "unavailable", reason: "This order is already cancelled." };
  }
  if (input.status === "declined") {
    return { kind: "unavailable", reason: "This request was declined, so there is nothing to cancel." };
  }
  if (input.hasOpenRequest || ["requested", "under_review"].includes(input.cancellation_status)) {
    return { kind: "pending", note: "Your cancellation request is with the team." };
  }
  if (["approved", "refund_pending"].includes(input.cancellation_status)) {
    return { kind: "pending", note: "Your cancellation was approved and is being finalised." };
  }

  if (["shipped", "delivered", "picked_up"].includes(input.fulfillment_status)) {
    return {
      kind: "unavailable",
      reason: "This order has already left the shop. Start a return instead.",
    };
  }
  if (input.status === "completed") {
    return {
      kind: "unavailable",
      reason: "This order is complete. Start a return if something is wrong with it.",
    };
  }

  const paid = paymentWasTaken(input);

  if (!paid) {
    if (rules.unpaidWindowHours > 0 && input.created_at) {
      const created = new Date(input.created_at).getTime();
      const now = (input.now ?? new Date()).getTime();
      if (Number.isFinite(created) && now - created > rules.unpaidWindowHours * 3_600_000) {
        return {
          kind: "unavailable",
          reason: "The window for cancelling this order yourself has closed. Send a message and the team will help.",
        };
      }
    }
    return { kind: "immediate", refundableCents: 0 };
  }

  if (!rules.allowPaidRequests) {
    return {
      kind: "unavailable",
      reason: "Paid orders cannot be cancelled online. Send a message and the team will help.",
    };
  }
  if (rules.blockForCustomOrders && (input.isCustomOrder || input.order_kind === "custom_request")) {
    return {
      kind: "unavailable",
      reason: "Custom orders cannot be cancelled once paid. Send a message and the team will help.",
    };
  }
  if (rules.blockAfterProductionStart && PRODUCTION_STARTED.has(String(input.productionStatus || ""))) {
    return {
      kind: "unavailable",
      reason: "Work on this order has already started, so it can no longer be cancelled online.",
    };
  }
  if (rules.blockAfterMaterialsOrdered && (input.materialsOrdered || MATERIALS_COMMITTED.has(String(input.productionStatus || "")))) {
    return {
      kind: "unavailable",
      reason: "Materials for this order are already committed, so it can no longer be cancelled online. Send a message and the team will help.",
    };
  }

  return {
    kind: "request",
    refundableCents: refundableCents(input),
    note: "Cancelling a paid order needs a quick review. Approving it is not automatic, and a refund is decided as part of that review.",
  };
}

// ---------------------------------------------------------------------------
// Return eligibility
// ---------------------------------------------------------------------------

export const RETURN_REASONS = [
  { code: "wrong_item", label: "Wrong item was sent" },
  { code: "damaged_in_transit", label: "Damaged in transit" },
  { code: "defective", label: "Defective or not working" },
  { code: "does_not_fit", label: "Does not fit" },
  { code: "not_as_described", label: "Not as described" },
  { code: "changed_mind", label: "Changed my mind" },
  { code: "other", label: "Something else" },
] as const;

export type ReturnReasonCode = (typeof RETURN_REASONS)[number]["code"];
export const RETURN_REASON_CODES: readonly string[] = RETURN_REASONS.map((entry) => entry.code);

export type ReturnableLine = {
  order_item_id: string;
  product_name: string;
  unit_price_cents: number;
  quantity: number;
  /** Already spoken for by a return that is not denied or closed. */
  returned_quantity: number;
  is_custom?: boolean;
};

export type ReturnEligibilityInput = {
  status: string;
  payment_status: string;
  fulfillment_status: string;
  return_status: string;
  order_kind?: string | null;
  delivered_at?: string | null;
  picked_up_at?: string | null;
  hasOpenReturn?: boolean;
  lines: ReturnableLine[];
  policy?: CommercePolicy;
  now?: Date;
};

export type ReturnEligibility =
  | { kind: "eligible"; lines: ReturnableLine[]; windowClosesAt: string | null }
  | { kind: "pending"; note: string }
  | { kind: "unavailable"; reason: string };

/**
 * Custom and personalized work is excluded by default rather than inheriting
 * standard return rules. A bespoke part cannot be resold, and the brief is
 * explicit that these must not be treated the same as catalogue stock.
 */
export function evaluateReturn(input: ReturnEligibilityInput): ReturnEligibility {
  const rules = (input.policy ?? DEFAULT_COMMERCE_POLICY).returns;

  if (!rules.enabled) {
    return { kind: "unavailable", reason: "Returns are handled by the team directly. Send a message to get started." };
  }
  if (input.hasOpenReturn || !["none", "denied", "closed", "completed"].includes(input.return_status)) {
    return { kind: "pending", note: "A return for this order is already open." };
  }
  if (!paymentWasTaken(input)) {
    return { kind: "unavailable", reason: "This order has not been paid, so there is nothing to return." };
  }

  const deliveredish = ["delivered", "picked_up", "partially_returned"].includes(input.fulfillment_status);
  if (!deliveredish) {
    return {
      kind: "unavailable",
      reason: "This order has not been delivered yet. Ask to cancel it instead if you no longer want it.",
    };
  }

  const receivedAt = input.delivered_at || input.picked_up_at;
  let windowClosesAt: string | null = null;
  if (rules.windowDays > 0) {
    if (!receivedAt) {
      return { kind: "unavailable", reason: "We do not have a delivery date for this order yet. Send a message and the team will help." };
    }
    const received = new Date(receivedAt).getTime();
    if (!Number.isFinite(received)) {
      return { kind: "unavailable", reason: "We could not read this order's delivery date. Send a message and the team will help." };
    }
    const closes = received + rules.windowDays * 86_400_000;
    windowClosesAt = new Date(closes).toISOString();
    if ((input.now ?? new Date()).getTime() > closes) {
      return {
        kind: "unavailable",
        reason: `The ${rules.windowDays}-day return window for this order has closed. Send a message and the team will still take a look.`,
      };
    }
  }

  const lines = input.lines
    .map((line) => ({ ...line, quantity: Math.max(0, line.quantity - line.returned_quantity) }))
    .filter((line) => line.quantity > 0)
    .filter((line) => rules.allowCustomProducts || !line.is_custom);

  if (!lines.length) {
    const blockedByCustom = !rules.allowCustomProducts && input.lines.some((line) => line.is_custom);
    return {
      kind: "unavailable",
      reason: blockedByCustom
        ? "Custom and made-to-order items are not returnable. Send a message if there is a problem with yours and the team will help."
        : "Everything on this order has already been returned.",
    };
  }

  return { kind: "eligible", lines, windowClosesAt };
}

/** What a set of return lines is worth, before any restocking fee. */
export function returnRefundCents(
  lines: { unit_price_cents: number; quantity: number }[],
  restockingFeePercent = 0
): number {
  const gross = lines.reduce((sum, line) => sum + Math.max(0, line.unit_price_cents) * Math.max(0, line.quantity), 0);
  const fee = Math.floor((gross * Math.min(100, Math.max(0, restockingFeePercent))) / 100);
  return Math.max(0, gross - fee);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const titleCase = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

/**
 * Customer-facing wording. Internal state names leak process detail the
 * customer did not ask for — "Refund pending" is useful, "Under review" on a
 * fulfillment field is not.
 */
export const FULFILLMENT_LABELS: Readonly<Record<FulfillmentState, string>> = {
  not_required: "No delivery needed",
  unfulfilled: "Not yet prepared",
  processing: "Being prepared",
  ready_to_fulfill: "Packed and ready",
  ready_for_pickup: "Ready for pickup",
  picked_up: "Picked up",
  shipped: "Shipped",
  delivered: "Delivered",
  returned: "Returned",
  partially_returned: "Partly returned",
  canceled: "Cancelled",
};

/**
 * The staff wording, which is deliberately not the customer wording. Staff need
 * to know an order is waiting on a label; the customer needs to know it is
 * being prepared.
 */
export const FULFILLMENT_STAFF_LABELS: Readonly<Record<FulfillmentState, string>> = {
  not_required: "No fulfillment required",
  unfulfilled: "Unfulfilled",
  processing: "Processing",
  ready_to_fulfill: "Ready to fulfill",
  ready_for_pickup: "Ready for pickup",
  picked_up: "Picked up",
  shipped: "Shipped",
  delivered: "Delivered",
  returned: "Returned",
  partially_returned: "Partially returned",
  canceled: "Fulfillment cancelled",
};

export const CANCELLATION_LABELS: Readonly<Record<CancellationState, string>> = {
  none: "—",
  requested: "Cancellation requested",
  under_review: "Cancellation under review",
  approved: "Cancellation approved",
  denied: "Cancellation declined",
  withdrawn: "Cancellation withdrawn",
  refund_pending: "Refund in progress",
  refund_failed: "Refund needs attention",
  completed: "Cancelled",
};

export const RETURN_LABELS: Readonly<Record<ReturnState, string>> = {
  none: "—",
  requested: "Return requested",
  under_review: "Return under review",
  approved: "Return approved",
  denied: "Return declined",
  awaiting_shipment: "Waiting for your parcel",
  in_transit: "Return on its way",
  received: "Return received",
  inspected: "Return inspected",
  refund_pending: "Refund in progress",
  completed: "Return complete",
  closed: "Return closed",
};

export const PAYMENT_LABELS: Readonly<Record<PaymentState, string>> = {
  not_required: "No payment needed",
  unpaid: "Unpaid",
  payment_pending: "Payment processing",
  partial: "Deposit paid",
  paid: "Paid",
  partially_refunded: "Partly refunded",
  refunded: "Refunded",
  payment_failed: "Payment failed",
  payment_canceled: "Payment cancelled",
};

export const REFUND_LABELS: Readonly<Record<RefundState, string>> = {
  pending: "Refund in progress",
  succeeded: "Refund complete",
  failed: "Refund failed",
  canceled: "Refund cancelled",
};

export const lifecycleLabel = (
  map: Readonly<Record<string, string>>,
  value: string | null | undefined
): string => (value && map[value]) || titleCase(String(value || ""));

/**
 * The one sentence a customer should read first. Cancellation and return work
 * outrank everything else because they are what the customer is waiting on.
 */
export function customerLifecycleHeadline(order: {
  status: string;
  payment_status: string;
  fulfillment_status: string;
  cancellation_status: string;
  return_status: string;
}): string {
  if (order.cancellation_status === "completed" || order.status === "cancelled") return "Cancelled";
  if (order.cancellation_status !== "none") return lifecycleLabel(CANCELLATION_LABELS, order.cancellation_status);
  if (order.return_status !== "none") return lifecycleLabel(RETURN_LABELS, order.return_status);
  if (["shipped", "delivered", "picked_up", "ready_for_pickup"].includes(order.fulfillment_status)) {
    return lifecycleLabel(FULFILLMENT_LABELS, order.fulfillment_status);
  }
  if (order.payment_status === "payment_failed") return "Payment failed";
  if (order.status === "completed") return "Complete";
  return titleCase(order.status);
}
