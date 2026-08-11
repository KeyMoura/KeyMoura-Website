import assert from "node:assert/strict";
import test from "node:test";
import { percentageChange, resolveAnalyticsWindow } from "../src/lib/businessAnalytics.ts";
import { fulfillmentMetrics, productionMetrics, supportMetrics } from "../src/lib/analytics/reporting.ts";

test("UTC ranges and prior periods are adjacent and zero comparisons are omitted", () => {
  const window = resolveAnalyticsWindow("7d", new Date("2026-08-11T23:30:00-07:00"));
  assert.equal(window.end.toISOString(), "2026-08-13T00:00:00.000Z");
  assert.equal(window.previousEnd?.toISOString(), window.start?.toISOString());
  assert.equal(percentageChange(10, 0), null);
  assert.equal(percentageChange(12, 10), .2);
});

test("production durations exclude incomplete jobs and count explicit pressure", () => {
  const base = { id: "a", priority: "normal", due_date: "2026-08-01", created_at: "2026-07-01T00:00:00Z", rework_count: 0 };
  const result = productionMetrics([
    { ...base, status: "completed", started_at: "2026-08-01T00:00:00Z", completed_at: "2026-08-02T00:00:00Z" },
    { ...base, id: "b", status: "on_hold", started_at: "2026-08-03T00:00:00Z", completed_at: null },
  ], new Date("2026-08-11T00:00:00Z"));
  assert.equal(result.averageHours, 24); assert.equal(result.blocked, 1); assert.equal(result.overdue, 1);
});

test("fulfillment uses timestamps and support first response is authoritative", () => {
  const fulfillment = fulfillmentMetrics([{ id: "o", fulfillment_method: "pickup", fulfillment_status: "picked_up", paid_at: "2026-08-01T00:00:00Z", ready_to_fulfill_at: "2026-08-02T00:00:00Z", shipped_at: null, pickup_confirmed_at: "2026-08-03T00:00:00Z" }]);
  assert.equal(fulfillment.averagePaidToFulfilledHours, 48); assert.equal(fulfillment.readyPickupWaitHours, 24);
  const support = supportMetrics([{ id: "s", status: "resolved", category: "order", priority: "normal", created_at: "2026-08-01T00:00:00Z", first_staff_response_at: "2026-08-01T02:00:00Z", resolved_at: "2026-08-02T00:00:00Z" }]);
  assert.equal(support.averageFirstResponseHours, 2); assert.equal(support.averageResolutionHours, 24);
});
