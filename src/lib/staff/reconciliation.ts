/**
 * Reconciliation: does what the accounting says match what the records say?
 *
 * Pure and dependency-free. The route loads rows; this decides what is wrong
 * with them, and the tests exercise it without a database. That split matters
 * here more than usual, because every check below is a *claim about money or
 * stock* and a claim like that should be readable as an assertion rather than
 * buried in a query.
 *
 * **Read-only by design.** Nothing here repairs anything. Pass 7's refund
 * settlement and pass 8's reservation commit are the only writers of these
 * numbers, and both are idempotent and guarded; a reconciliation screen that
 * offered a "fix" button would be a third writer with none of those guarantees.
 * The output is evidence for a human, and the fix is the ordinary staff action
 * that the finding names.
 */

export type Severity = "critical" | "warning" | "info";

export type Finding = {
  /** Stable key, so a finding can be counted and looked up without matching prose. */
  code: string;
  severity: Severity;
  title: string;
  /** What is wrong, in one sentence, with the numbers in it. */
  detail: string;
  /** What to do about it. Never "contact support". */
  remedy: string;
  href?: string;
};

export type CheckResult = {
  id: string;
  title: string;
  /** What this check compares, so a clean result is meaningful rather than mysterious. */
  question: string;
  checked: number;
  findings: Finding[];
};

const money = (cents: number) => `$${(Math.abs(cents) / 100).toFixed(2)}`;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type ReconOrder = {
  id: string;
  order_number: string | null;
  status: string;
  payment_status: string;
  fulfillment_status: string | null;
  fulfillment_method: string | null;
  agreed_price_cents: number | null;
  amount_paid_cents: number;
  amount_refunded_cents: number | null;
  tracking_number: string | null;
  paid_at: string | null;
  inventory_committed_at: string | null;
  created_at: string;
};

export type ReconPayment = { order_id: string; amount_cents: number };

export type ReconRefund = {
  id: string;
  order_id: string;
  status: string | null;
  amount_cents: number;
  confirmed_amount_cents: number | null;
  created_at: string;
};

export type ReconReservation = {
  id: string;
  product_id: string;
  order_id: string | null;
  status: string;
  quantity: number;
  expires_at: string | null;
};

export type ReconProduct = {
  id: string;
  name: string;
  inventory_policy: string;
  inventory_quantity: number;
  low_stock_threshold: number;
  made_to_order: boolean | null;
  archived_at: string | null;
};

export type ReconAdjustment = { product_id: string; quantity_after: number; created_at: string };

/** `inventory_alerts`. The column is `level` (`low` / `out`), not `severity`. */
export type ReconAlert = { id: string; product_id: string; level: string; status: string };

export type ReconciliationInput = {
  orders: readonly ReconOrder[];
  payments: readonly ReconPayment[];
  refunds: readonly ReconRefund[];
  reservations: readonly ReconReservation[];
  products: readonly ReconProduct[];
  /** The most recent adjustment per product. */
  latestAdjustments: readonly ReconAdjustment[];
  alerts: readonly ReconAlert[];
  now: Date;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A refund leg that has taken money. Pending legs are *claims*, not settlements. */
const settledAmount = (refund: ReconRefund) =>
  refund.status === "succeeded" ? refund.confirmed_amount_cents ?? refund.amount_cents : 0;

const orderRef = (order: ReconOrder) => order.order_number || order.id.slice(0, 8).toUpperCase();

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * `orders.amount_paid_cents` against the sum of its payment rows.
 *
 * These are written by different code paths — the Stripe webhook's accounting
 * RPC writes both, but a manual correction or a partially-applied migration
 * could move one without the other. A drift here means the balance shown to a
 * customer is not the money actually recorded against them.
 */
export function checkPaymentTotals(input: ReconciliationInput): CheckResult {
  const byOrder = new Map<string, number>();
  for (const payment of input.payments) {
    byOrder.set(payment.order_id, (byOrder.get(payment.order_id) ?? 0) + Math.max(0, payment.amount_cents));
  }

  const findings: Finding[] = [];
  for (const order of input.orders) {
    const recorded = order.amount_paid_cents || 0;
    const summed = byOrder.get(order.id) ?? 0;
    if (recorded === summed) continue;
    findings.push({
      code: "payment_total_mismatch",
      severity: "critical",
      title: `Payment total disagrees — ${orderRef(order)}`,
      detail: `The order says ${money(recorded)} collected; its payment rows add up to ${money(summed)}.`,
      remedy:
        "Compare the order against Stripe. The payment rows are the record of individual captures; the order field is the running total the customer is shown.",
      href: `/staff/orders/${order.id}`,
    });
  }

  return {
    id: "payment_totals",
    title: "Payment totals",
    question: "Does each order's collected amount equal the sum of its payment rows?",
    checked: input.orders.length,
    findings,
  };
}

/**
 * `orders.amount_refunded_cents` against settled refund legs, plus two
 * conditions that are wrong on their face.
 *
 * Pending legs are excluded from the sum on purpose: pass 7 only grows
 * `amount_refunded_cents` at settlement, so counting a pending leg here would
 * report every in-flight refund as a discrepancy.
 */
export function checkRefundTotals(input: ReconciliationInput): CheckResult {
  const byOrder = new Map<string, number>();
  for (const refund of input.refunds) {
    byOrder.set(refund.order_id, (byOrder.get(refund.order_id) ?? 0) + settledAmount(refund));
  }

  const findings: Finding[] = [];
  for (const order of input.orders) {
    const recorded = order.amount_refunded_cents || 0;
    const summed = byOrder.get(order.id) ?? 0;
    if (recorded !== summed) {
      findings.push({
        code: "refund_total_mismatch",
        severity: "critical",
        title: `Refund total disagrees — ${orderRef(order)}`,
        detail: `The order says ${money(recorded)} refunded; its settled refund legs add up to ${money(summed)}.`,
        remedy:
          "Check Stripe for a refund this application was never told about. The webhook adopts Dashboard refunds through reconcile_stripe_refund, so a gap usually means an undelivered event.",
        href: `/staff/orders/${order.id}`,
      });
    }
    if (recorded > (order.amount_paid_cents || 0)) {
      findings.push({
        code: "over_refunded",
        severity: "critical",
        title: `Refunded more than was collected — ${orderRef(order)}`,
        detail: `${money(recorded)} refunded against ${money(order.amount_paid_cents || 0)} collected.`,
        remedy: "This should be impossible through the refund route. Investigate before issuing anything further.",
        href: `/staff/orders/${order.id}`,
      });
    }
  }

  // A refund that has been pending for a day is not in flight, it is stuck: it
  // is still holding down what the order can refund, so a legitimate second
  // refund would be refused for money nobody ever received.
  for (const refund of input.refunds) {
    if (refund.status !== "pending") continue;
    const age = input.now.getTime() - new Date(refund.created_at).getTime();
    if (age < DAY) continue;
    const order = input.orders.find((row) => row.id === refund.order_id);
    findings.push({
      code: "refund_stuck_pending",
      severity: "warning",
      title: `Refund pending for ${Math.floor(age / DAY)} day(s)${order ? ` — ${orderRef(order)}` : ""}`,
      detail: `${money(refund.amount_cents)} has been claimed against this order but never settled, and it is still reducing what can be refunded.`,
      remedy:
        "Look the refund up in Stripe. If it succeeded, the settlement webhook was missed; if it failed, the leg should have been released.",
      href: order ? `/staff/orders/${order.id}` : undefined,
    });
  }

  return {
    id: "refund_totals",
    title: "Refund totals",
    question: "Does each order's refunded amount equal its settled refund legs, and is anything stuck?",
    checked: input.orders.length,
    findings,
  };
}

/**
 * Stock holds that should no longer exist.
 *
 * Expiry does not depend on a cron service — availability ignores a lapsed hold
 * and the reservation path sweeps before it measures — so a lapsed row is not
 * an outage. It is still worth showing, because a large number of them means
 * checkouts are being abandoned at a rate somebody should know about.
 */
export function checkReservations(input: ReconciliationInput): CheckResult {
  const findings: Finding[] = [];
  const productName = new Map(input.products.map((product) => [product.id, product.name]));

  const lapsed = input.reservations.filter(
    (reservation) =>
      reservation.status === "active" &&
      reservation.expires_at != null &&
      new Date(reservation.expires_at).getTime() < input.now.getTime()
  );
  if (lapsed.length) {
    findings.push({
      code: "reservations_lapsed",
      severity: "info",
      title: `${lapsed.length} stock hold(s) have lapsed and not been swept`,
      detail: `${lapsed.reduce((sum, row) => sum + row.quantity, 0)} unit(s) across ${new Set(lapsed.map((row) => row.product_id)).size} product(s).`,
      remedy:
        "Nothing is broken: availability already ignores a lapsed hold, and the next reservation or a visit to Inventory sweeps them. A steadily growing number means checkouts are being abandoned.",
      href: "/staff/inventory",
    });
  }

  // A paid order still holding stock means the commit did not happen — the
  // stock was never actually taken off the shelf, so the next customer can be
  // sold a unit that is already spoken for.
  for (const order of input.orders) {
    if (!order.paid_at || order.inventory_committed_at) continue;
    const held = input.reservations.filter(
      (reservation) => reservation.order_id === order.id && reservation.status === "active"
    );
    if (!held.length) continue;
    findings.push({
      code: "reservation_not_committed",
      severity: "critical",
      title: `Paid order still holding uncommitted stock — ${orderRef(order)}`,
      detail: `${held.reduce((sum, row) => sum + row.quantity, 0)} unit(s) of ${held
        .map((row) => productName.get(row.product_id) ?? "a product")
        .join(", ")} are held but were never taken off the shelf.`,
      remedy:
        "The payment webhook commits inventory. Check the Stripe event log for a delivery failure on this order's payment.",
      href: `/staff/orders/${order.id}`,
    });
  }

  return {
    id: "reservations",
    title: "Stock holds",
    question: "Are any holds lapsed but unswept, or held against an order that is already paid?",
    checked: input.reservations.length,
    findings,
  };
}

/**
 * `products.inventory_quantity` against the ledger's last recorded outcome.
 *
 * `adjust_product_inventory` is the only writer of that column *through the
 * ledger*, but the catalog editor writes it directly as a definition. A drift
 * therefore usually means somebody typed a new count into the product editor
 * instead of recording an adjustment — which is not corruption, but it does
 * mean the movement history no longer explains the current number.
 */
export function checkInventoryLedger(input: ReconciliationInput): CheckResult {
  const latest = new Map(input.latestAdjustments.map((row) => [row.product_id, row]));
  const findings: Finding[] = [];

  for (const product of input.products) {
    if (product.archived_at || product.inventory_policy !== "track") continue;
    const adjustment = latest.get(product.id);
    if (!adjustment) continue;
    if (adjustment.quantity_after === product.inventory_quantity) continue;
    findings.push({
      code: "inventory_ledger_drift",
      severity: "warning",
      title: `Stock does not match its history — ${product.name}`,
      detail: `On hand reads ${product.inventory_quantity}; the last recorded movement left it at ${adjustment.quantity_after}.`,
      remedy:
        "The count was almost certainly edited on the product page rather than adjusted. Record an adjustment with a reason so the history explains the number.",
      href: `/staff/inventory/${product.id}`,
    });
  }

  return {
    id: "inventory_ledger",
    title: "Stock against its history",
    question: "Does each tracked product's count match the last movement recorded for it?",
    checked: input.products.filter((p) => !p.archived_at && p.inventory_policy === "track").length,
    findings,
  };
}

/**
 * Low-stock alerts against the stock they describe.
 *
 * An open alert on a restocked product is a bell that never stops ringing, and
 * staff learn to ignore the whole channel.
 */
export function checkAlerts(input: ReconciliationInput): CheckResult {
  const byId = new Map(input.products.map((product) => [product.id, product]));
  const findings: Finding[] = [];

  for (const alert of input.alerts) {
    if (alert.status !== "open") continue;
    const product = byId.get(alert.product_id);
    if (!product) continue;
    if (product.inventory_policy !== "track" || product.made_to_order) {
      findings.push({
        code: "alert_untracked_product",
        severity: "info",
        title: `Open stock alert on an untracked product — ${product.name}`,
        detail: "This product is made to order or untracked, so it cannot run out.",
        remedy: "The alert is stale. It resolves on the next movement, or can be left; nothing acts on it.",
        href: `/staff/inventory/${product.id}`,
      });
      continue;
    }
    if (product.inventory_quantity > product.low_stock_threshold) {
      findings.push({
        code: "alert_resolved_stock",
        severity: "warning",
        title: `Open stock alert on restocked product — ${product.name}`,
        detail: `${product.inventory_quantity} on hand, above the threshold of ${product.low_stock_threshold}.`,
        remedy: "Alerts resolve when stock rises through an adjustment. One left open means a movement bypassed the ledger.",
        href: `/staff/inventory/${product.id}`,
      });
    }
  }

  return {
    id: "alerts",
    title: "Stock alerts",
    question: "Is every open low-stock alert still true?",
    checked: input.alerts.filter((alert) => alert.status === "open").length,
    findings,
  };
}

/**
 * Fulfillment that has stalled or shipped without a way to follow it.
 *
 * The seven-day threshold is deliberately generous — this is a made-to-order
 * shop, and an order sitting for three days is normal work, not a fault.
 */
export function checkFulfillment(input: ReconciliationInput): CheckResult {
  const findings: Finding[] = [];

  for (const order of input.orders) {
    const state = String(order.fulfillment_status || "unfulfilled");

    if (
      String(order.fulfillment_method || "shipping") === "shipping" &&
      state === "shipped" &&
      !String(order.tracking_number || "").trim()
    ) {
      findings.push({
        code: "shipped_without_tracking",
        severity: "warning",
        title: `Shipped with no tracking — ${orderRef(order)}`,
        detail: "The customer has no way to follow the parcel.",
        remedy: "Add the carrier and number on the order; a correction emails the customer the new details.",
        href: `/staff/orders/${order.id}#fulfillment`,
      });
    }

    if (!order.paid_at) continue;
    if (["delivered", "picked_up", "returned", "partially_returned", "canceled", "not_required"].includes(state)) continue;
    const age = input.now.getTime() - new Date(order.paid_at).getTime();
    if (age < 7 * DAY) continue;
    findings.push({
      code: "fulfillment_stalled",
      severity: "warning",
      title: `Paid ${Math.floor(age / DAY)} days ago and not delivered — ${orderRef(order)}`,
      detail: `Fulfillment has been sitting at "${state.replaceAll("_", " ")}".`,
      remedy: "Move it on, or tell the customer why it is waiting. A silent week is how a chargeback starts.",
      href: `/staff/orders/${order.id}#fulfillment`,
    });
  }

  return {
    id: "fulfillment",
    title: "Fulfillment health",
    question: "Has anything paid stalled undelivered, or shipped with no tracking?",
    checked: input.orders.filter((order) => Boolean(order.paid_at)).length,
    findings,
  };
}

export const RECONCILIATION_CHECKS = [
  checkPaymentTotals,
  checkRefundTotals,
  checkReservations,
  checkInventoryLedger,
  checkAlerts,
  checkFulfillment,
] as const;

export type ReconciliationReport = {
  generatedAt: string;
  checks: CheckResult[];
  counts: Record<Severity, number>;
};

export function runReconciliation(input: ReconciliationInput): ReconciliationReport {
  const checks = RECONCILIATION_CHECKS.map((check) => check(input));
  const counts: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
  for (const check of checks) {
    for (const finding of check.findings) counts[finding.severity] += 1;
  }
  return { generatedAt: input.now.toISOString(), checks, counts };
}
