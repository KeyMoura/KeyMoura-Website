import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  RECONCILIATION_CHECKS,
  checkAlerts,
  checkFulfillment,
  checkInventoryLedger,
  checkPaymentTotals,
  checkRefundTotals,
  checkReservations,
  runReconciliation,
  type ReconciliationInput,
} from "../src/lib/staff/reconciliation.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const NOW = new Date("2026-08-05T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

function input(overrides: Partial<ReconciliationInput> = {}): ReconciliationInput {
  return {
    orders: [],
    payments: [],
    refunds: [],
    reservations: [],
    products: [],
    latestAdjustments: [],
    alerts: [],
    now: NOW,
    ...overrides,
  };
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: "o1",
    order_number: "KM-0001",
    status: "completed",
    payment_status: "paid",
    fulfillment_status: "delivered",
    fulfillment_method: "shipping",
    agreed_price_cents: 10_000,
    amount_paid_cents: 10_000,
    amount_refunded_cents: 0,
    tracking_number: "1Z999",
    paid_at: daysAgo(2),
    inventory_committed_at: daysAgo(2),
    created_at: daysAgo(3),
    ...overrides,
  } as ReconciliationInput["orders"][number];
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

test("a matching payment total is clean", () => {
  const result = checkPaymentTotals(
    input({ orders: [order()], payments: [{ order_id: "o1", amount_cents: 10_000 }] })
  );
  assert.deepEqual(result.findings, []);
  assert.equal(result.checked, 1);
});

test("a payment total that disagrees with its rows is critical", () => {
  const result = checkPaymentTotals(
    input({ orders: [order()], payments: [{ order_id: "o1", amount_cents: 4_000 }] })
  );
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].code, "payment_total_mismatch");
  assert.equal(result.findings[0].severity, "critical");
  assert.match(result.findings[0].detail, /\$100\.00 collected; its payment rows add up to \$40\.00/);
});

test("an order with no payment rows and nothing collected is not a finding", () => {
  const result = checkPaymentTotals(input({ orders: [order({ amount_paid_cents: 0, paid_at: null })] }));
  assert.deepEqual(result.findings, []);
});

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

const refund = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "r1",
    order_id: "o1",
    status: "succeeded",
    amount_cents: 3_000,
    confirmed_amount_cents: 3_000,
    created_at: daysAgo(1),
    ...overrides,
  }) as ReconciliationInput["refunds"][number];

test("settled refunds that match the order are clean", () => {
  const result = checkRefundTotals(
    input({ orders: [order({ amount_refunded_cents: 3_000 })], refunds: [refund()] })
  );
  assert.deepEqual(result.findings, []);
});

test("a pending refund is not counted as settled money", () => {
  // Pass 7 only grows amount_refunded_cents at settlement. Counting a pending
  // leg here would report every in-flight refund as a discrepancy.
  const result = checkRefundTotals(
    input({
      orders: [order({ amount_refunded_cents: 0 })],
      refunds: [refund({ status: "pending", confirmed_amount_cents: null, created_at: daysAgo(0) })],
    })
  );
  assert.deepEqual(result.findings, []);
});

test("a refund pending for more than a day is reported as stuck", () => {
  const result = checkRefundTotals(
    input({
      orders: [order({ amount_refunded_cents: 0 })],
      refunds: [refund({ status: "pending", confirmed_amount_cents: null, created_at: daysAgo(3) })],
    })
  );
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].code, "refund_stuck_pending");
  assert.match(result.findings[0].detail, /still reducing what can be refunded/);
});

test("a Dashboard refund the application was never told about is critical", () => {
  const result = checkRefundTotals(
    input({ orders: [order({ amount_refunded_cents: 5_000 })], refunds: [] })
  );
  const codes = result.findings.map((finding) => finding.code);
  assert.ok(codes.includes("refund_total_mismatch"));
  assert.match(result.findings[0].remedy, /reconcile_stripe_refund/);
});

test("refunding more than was collected is reported on its own", () => {
  const result = checkRefundTotals(
    input({
      orders: [order({ amount_paid_cents: 1_000, amount_refunded_cents: 3_000 })],
      refunds: [refund()],
    })
  );
  assert.ok(result.findings.some((finding) => finding.code === "over_refunded"));
});

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

const product = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "p1",
    name: "Shift knob",
    inventory_policy: "track",
    inventory_quantity: 5,
    low_stock_threshold: 2,
    made_to_order: false,
    archived_at: null,
    ...overrides,
  }) as ReconciliationInput["products"][number];

test("a live hold that has not expired is clean", () => {
  const result = checkReservations(
    input({
      products: [product()],
      reservations: [
        {
          id: "h1",
          product_id: "p1",
          order_id: null,
          status: "active",
          quantity: 1,
          expires_at: new Date(NOW.getTime() + 600_000).toISOString(),
        },
      ],
    })
  );
  assert.deepEqual(result.findings, []);
});

test("lapsed holds are information, not a fault", () => {
  const result = checkReservations(
    input({
      products: [product()],
      reservations: [
        { id: "h1", product_id: "p1", order_id: null, status: "active", quantity: 2, expires_at: daysAgo(1) },
      ],
    })
  );
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].severity, "info");
  assert.match(result.findings[0].remedy, /availability already ignores a lapsed hold/);
});

test("a paid order still holding uncommitted stock is critical", () => {
  const result = checkReservations(
    input({
      orders: [order({ inventory_committed_at: null })],
      products: [product()],
      reservations: [
        {
          id: "h1",
          product_id: "p1",
          order_id: "o1",
          status: "active",
          quantity: 3,
          expires_at: new Date(NOW.getTime() + 600_000).toISOString(),
        },
      ],
    })
  );
  const finding = result.findings.find((row) => row.code === "reservation_not_committed");
  assert.ok(finding);
  assert.equal(finding.severity, "critical");
  assert.match(finding.detail, /3 unit\(s\) of Shift knob/);
});

test("an unpaid order holding stock is normal and raises nothing", () => {
  const result = checkReservations(
    input({
      orders: [order({ paid_at: null, inventory_committed_at: null })],
      products: [product()],
      reservations: [
        {
          id: "h1",
          product_id: "p1",
          order_id: "o1",
          status: "active",
          quantity: 1,
          expires_at: new Date(NOW.getTime() + 600_000).toISOString(),
        },
      ],
    })
  );
  assert.ok(!result.findings.some((finding) => finding.code === "reservation_not_committed"));
});

// ---------------------------------------------------------------------------
// Inventory ledger
// ---------------------------------------------------------------------------

test("stock matching its last movement is clean", () => {
  const result = checkInventoryLedger(
    input({
      products: [product({ inventory_quantity: 7 })],
      latestAdjustments: [{ product_id: "p1", quantity_after: 7, created_at: daysAgo(1) }],
    })
  );
  assert.deepEqual(result.findings, []);
});

test("a count edited outside the ledger is reported", () => {
  const result = checkInventoryLedger(
    input({
      products: [product({ inventory_quantity: 12 })],
      latestAdjustments: [{ product_id: "p1", quantity_after: 7, created_at: daysAgo(1) }],
    })
  );
  assert.equal(result.findings[0].code, "inventory_ledger_drift");
  assert.match(result.findings[0].detail, /reads 12; the last recorded movement left it at 7/);
});

test("a product with no movement history is not a drift", () => {
  const result = checkInventoryLedger(input({ products: [product()], latestAdjustments: [] }));
  assert.deepEqual(result.findings, []);
});

test("untracked and archived products are not checked against a ledger", () => {
  const result = checkInventoryLedger(
    input({
      products: [
        product({ id: "a", inventory_policy: "unlimited", inventory_quantity: 0 }),
        product({ id: "b", archived_at: daysAgo(30), inventory_quantity: 99 }),
      ],
      latestAdjustments: [
        { product_id: "a", quantity_after: 5, created_at: daysAgo(1) },
        { product_id: "b", quantity_after: 5, created_at: daysAgo(1) },
      ],
    })
  );
  assert.deepEqual(result.findings, []);
  assert.equal(result.checked, 0);
});

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

test("an alert on genuinely low stock is clean", () => {
  const result = checkAlerts(
    input({
      products: [product({ inventory_quantity: 1 })],
      alerts: [{ id: "a1", product_id: "p1", level: "low", status: "open" }],
    })
  );
  assert.deepEqual(result.findings, []);
});

test("an alert left open on restocked stock is reported", () => {
  const result = checkAlerts(
    input({
      products: [product({ inventory_quantity: 20 })],
      alerts: [{ id: "a1", product_id: "p1", level: "low", status: "open" }],
    })
  );
  assert.equal(result.findings[0].code, "alert_resolved_stock");
});

test("a resolved alert is never reported", () => {
  const result = checkAlerts(
    input({
      products: [product({ inventory_quantity: 20 })],
      alerts: [{ id: "a1", product_id: "p1", level: "low", status: "resolved" }],
    })
  );
  assert.deepEqual(result.findings, []);
});

test("an alert on a made-to-order product is stale by definition", () => {
  const result = checkAlerts(
    input({
      products: [product({ made_to_order: true, inventory_quantity: 0 })],
      alerts: [{ id: "a1", product_id: "p1", level: "out", status: "open" }],
    })
  );
  assert.equal(result.findings[0].code, "alert_untracked_product");
});

// ---------------------------------------------------------------------------
// Fulfillment health
// ---------------------------------------------------------------------------

test("a delivered order raises nothing however old", () => {
  const result = checkFulfillment(input({ orders: [order({ paid_at: daysAgo(90) })] }));
  assert.deepEqual(result.findings, []);
});

test("a week-old paid order still undelivered is reported", () => {
  const result = checkFulfillment(
    input({ orders: [order({ fulfillment_status: "processing", paid_at: daysAgo(9) })] })
  );
  assert.equal(result.findings[0].code, "fulfillment_stalled");
  assert.match(result.findings[0].title, /Paid 9 days ago/);
});

test("three days is ordinary work in a made-to-order shop", () => {
  const result = checkFulfillment(
    input({ orders: [order({ fulfillment_status: "processing", paid_at: daysAgo(3) })] })
  );
  assert.deepEqual(result.findings, []);
});

test("shipped with no tracking is reported even when recent", () => {
  const result = checkFulfillment(
    input({ orders: [order({ fulfillment_status: "shipped", tracking_number: null, paid_at: daysAgo(1) })] })
  );
  assert.equal(result.findings[0].code, "shipped_without_tracking");
  assert.match(result.findings[0].href ?? "", /#fulfillment$/);
});

test("a pickup order is never asked for a tracking number", () => {
  const result = checkFulfillment(
    input({
      orders: [
        order({
          fulfillment_method: "pickup",
          fulfillment_status: "ready_for_pickup",
          tracking_number: null,
          paid_at: daysAgo(1),
        }),
      ],
    })
  );
  assert.deepEqual(result.findings, []);
});

// ---------------------------------------------------------------------------
// The report as a whole
// ---------------------------------------------------------------------------

test("an empty database reconciles cleanly", () => {
  const report = runReconciliation(input());
  assert.deepEqual(report.counts, { critical: 0, warning: 0, info: 0 });
  assert.equal(report.checks.length, RECONCILIATION_CHECKS.length);
});

test("every check states the question it asks", () => {
  for (const check of runReconciliation(input()).checks) {
    assert.ok(check.question.trim().endsWith("?"), `${check.id} does not state a question`);
    assert.ok(check.title.length > 3);
  }
});

test("every finding carries a remedy, and none of them says to contact support", () => {
  const report = runReconciliation(
    input({
      orders: [order({ amount_refunded_cents: 5_000, fulfillment_status: "shipped", tracking_number: null })],
      payments: [{ order_id: "o1", amount_cents: 1 }],
      products: [product({ inventory_quantity: 20 })],
      latestAdjustments: [{ product_id: "p1", quantity_after: 3, created_at: daysAgo(1) }],
      alerts: [{ id: "a1", product_id: "p1", level: "low", status: "open" }],
    })
  );
  const findings = report.checks.flatMap((check) => check.findings);
  assert.ok(findings.length >= 4);
  for (const finding of findings) {
    assert.ok(finding.remedy.length > 20, `${finding.code} has no usable remedy`);
    assert.doesNotMatch(finding.remedy, /contact support/i);
    assert.ok(finding.code.length > 0);
  }
  assert.ok(report.counts.critical > 0);
});

test("severity counts equal the findings that were produced", () => {
  const report = runReconciliation(
    input({ orders: [order({ amount_paid_cents: 500 })], payments: [{ order_id: "o1", amount_cents: 1 }] })
  );
  const total = report.checks.reduce((sum, check) => sum + check.findings.length, 0);
  assert.equal(report.counts.critical + report.counts.warning + report.counts.info, total);
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test("the reconciliation route is permission gated and read-only", () => {
  const route = read("src/app/api/staff/reconciliation/route.ts");
  assert.match(route, /requirePermission\(req, "orders\.view"\)/);
  assert.match(route, /status: 403/);
  // No writer: the settlement and commit paths are the only ones allowed to
  // move these numbers, and both are idempotent and guarded.
  assert.doesNotMatch(route, /export async function POST/);
  assert.doesNotMatch(route, /\.update\(|\.insert\(|\.delete\(|\.rpc\(/);
});

test("the report is bounded and says so", () => {
  const route = read("src/app/api/staff/reconciliation/route.ts");
  assert.match(route, /\.limit\(ORDER_LIMIT\)/);
  assert.match(route, /truncated:/);
  const page = read("src/app/staff/reconciliation/page.tsx");
  assert.match(page, /report\.scope\.truncated/);
});

test("the reconciliation page offers no repair button", () => {
  const page = read("src/app/staff/reconciliation/page.tsx");
  assert.doesNotMatch(page, /method: "POST"/);
});
