import assert from "node:assert/strict";
import test from "node:test";

import { buildDashboardSummary, dashboardNextAction, type DashboardOrder } from "../src/lib/staffDashboard.ts";

const order = (overrides: Partial<DashboardOrder> = {}): DashboardOrder => ({
  id: "1", order_number: "KM-0001", customer_id: "customer", product_name: "Shift knob", status: "in_progress", quantity: 1,
  agreed_price_cents: 15000, amount_paid_cents: 15000, payment_status: "paid", target_date: "2026-07-30",
  paid_at: "2026-07-15T12:00:00Z",
  created_at: "2026-07-15T12:00:00Z", updated_at: "2026-07-29T12:00:00Z", shipped_at: null, delivered_at: null, ...overrides,
});

test("dashboard uses collected payments and identifies overdue work", () => {
  const summary = buildDashboardSummary([
    order(),
    order({ id: "2", amount_paid_cents: 0, payment_status: "unpaid", agreed_price_cents: 90000, target_date: null }),
    order({ id: "3", status: "completed", amount_paid_cents: 5000, target_date: null }),
    order({ id: "4", amount_paid_cents: 10000, paid_at: "2026-07-20T12:00:00Z", created_at: "2026-01-01T12:00:00Z", target_date: null }),
  ], [], "30d", new Date("2026-07-31T16:00:00Z"));
  assert.equal(summary.revenueCents, 30000);
  assert.equal(summary.averageOrderCents, 10000);
  assert.deepEqual(summary.overdue.map(item => item.id), ["1"]);
  assert.ok(summary.needsAttention.some(item => item.id === "2"));
});

test("dashboard reports low stock and fulfillment next actions", () => {
  const summary = buildDashboardSummary([], [{ id: "p", name: "Badge", slug: "badge", is_published: true, inventory_policy: "track", inventory_quantity: 1, low_stock_threshold: 2, archived_at: null }], "all", new Date("2026-07-31T16:00:00Z"));
  assert.equal(summary.inventoryAlerts.length, 1);
  assert.equal(dashboardNextAction(order({ status: "ready" })), "Arrange delivery");
  assert.equal(dashboardNextAction(order({ status: "ready", shipped_at: "2026-07-31T12:00:00Z" })), "Confirm delivery");
});
