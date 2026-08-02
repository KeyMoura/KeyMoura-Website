import assert from "node:assert/strict";
import test from "node:test";

import { buildBusinessAnalytics, type AnalyticsOrder } from "../src/lib/businessAnalytics.ts";

const baseOrder: AnalyticsOrder = {
  id: "one", customer_id: "customer", product_id: "product", product_name: "Shift knob", status: "completed", quantity: 2,
  agreed_price_cents: 10000, amount_paid_cents: 10000, amount_refunded_cents: 2000, payment_status: "paid",
  target_date: null, accepted_at: "2026-07-03T00:00:00Z", completed_at: "2026-07-08T00:00:00Z",
  created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-08T00:00:00Z",
};

test("business analytics uses payment and refund event dates for cash metrics", () => {
  const summary = buildBusinessAnalytics(
    [baseOrder], [],
    [{ order_id: "one", amount_cents: 10000, received_at: "2026-07-05T00:00:00Z" }],
    [{ order_id: "one", amount_cents: 2000, created_at: "2026-07-07T00:00:00Z" }],
    "30d", new Date("2026-07-15T00:00:00Z"),
  );
  assert.equal(summary.grossCollectedCents, 10000);
  assert.equal(summary.refundedCents, 2000);
  assert.equal(summary.netCollectedCents, 8000);
  assert.equal(summary.averageOrderCents, 8000);
  assert.equal(summary.averageTurnaroundDays, 5);
});

test("business analytics separates active pressure, inventory risk, and demand", () => {
  const active = { ...baseOrder, id: "two", status: "in_progress", completed_at: null, target_date: "2026-07-10", updated_at: "2026-06-20T00:00:00Z" };
  const summary = buildBusinessAnalytics(
    [baseOrder, active],
    [{ id: "product", name: "Shift knob", is_published: true, inventory_policy: "track", inventory_quantity: 1, low_stock_threshold: 2, archived_at: null }],
    [], [], "all", new Date("2026-07-15T00:00:00Z"),
  );
  assert.equal(summary.activeOrderCount, 1);
  assert.equal(summary.overdueCount, 1);
  assert.equal(summary.agingCount, 1);
  assert.equal(summary.inventoryAlerts.length, 1);
  assert.equal(summary.topProducts[0]?.orders, 2);
  assert.equal(summary.topProducts[0]?.units, 4);
});
