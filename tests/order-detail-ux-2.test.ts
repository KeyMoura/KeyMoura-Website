import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { customerOrderProgress, customerOrderStatus, customerPaymentSummary } from "../src/lib/commerce/customerOrderView.ts";
import { purchasedOptions } from "../src/lib/commerce/orderConfiguration.ts";

const base = { status: "in_progress", payment_status: "paid", fulfillment_method: "shipping", fulfillment_status: "unfulfilled", created_at: "2026-08-10T12:00:00Z", amount_paid_cents: 6290 };

test("customer status projection hides sensitive and unknown workflow states", () => {
  assert.equal(customerOrderStatus({ status: "production_active", fulfillment_status: null }), "In production");
  assert.equal(customerOrderStatus({ status: "qc", fulfillment_status: null }), "Final checks");
  assert.equal(customerOrderStatus({ status: "blocked", fulfillment_status: null }), "Order in progress");
  assert.equal(customerOrderStatus({ status: "machine_unavailable", fulfillment_status: null }), "Order in progress");
});

test("shipping timeline uses authoritative event dates and omits pickup", () => {
  const stages = customerOrderProgress({ ...base, fulfillment_status: "shipped", shipped_at: "2026-08-15T12:00:00Z" });
  assert.deepEqual(stages.map((stage) => stage.label), ["Order received", "Payment confirmed", "In production", "Final checks", "Shipped"]);
  assert.equal(stages.at(-1)?.at, "2026-08-15T12:00:00Z");
  assert.ok(!stages.some((stage) => stage.label.includes("pickup")));
});

test("pickup timeline omits shipping and marks collection as current", () => {
  const stages = customerOrderProgress({ ...base, fulfillment_method: "pickup", fulfillment_status: "ready_for_pickup", ready_at: "2026-08-15T12:00:00Z" });
  assert.ok(stages.some((stage) => stage.label === "Ready for pickup"));
  assert.ok(!stages.some((stage) => stage.label === "Shipped"));
  assert.equal(stages.find((stage) => stage.label === "Picked up")?.state, "current");
});

test("custom request timeline includes quote and payment without fulfillment", () => {
  const stages = customerOrderProgress({ ...base, status: "customer_review", payment_status: "unpaid", amount_paid_cents: 0 });
  assert.deepEqual(stages.map((stage) => stage.label), ["Request submitted", "Request accepted", "Quote ready", "Payment", "Production", "Complete"]);
});

test("historical payment rows and partial refunds remain truthful", () => {
  const summary = customerPaymentSummary({ subtotal_cents: 6100, discount_cents: 610, shipping_cents: 800, tax_cents: 0, agreed_price_cents: 6290, amount_paid_cents: 6290, amount_refunded_cents: 1000, payment_status: "partially_refunded" });
  assert.deepEqual(summary, { subtotal: 6100, discount: 610, shipping: 800, tax: 0, total: 6290, paid: 6290, refunded: 1000, balance: 0 });
});

test("immutable option labels and adjustments are read from snapshots", () => {
  const options = purchasedOptions({ color: { option_id: "private-option-id", option_name: "Color", value_id: "private-value-id", value_name: "Blue", value: "blue-machine", price_adjustment_cents: 500 } });
  assert.equal(options[0]?.option_name, "Color");
  assert.equal(options[0]?.value_name, "Blue");
  assert.equal(options[0]?.price_adjustment_cents, 500);
});

test("shared workspace has accessible and responsive customer hooks", () => {
  const component = readFileSync("src/components/commerce/CustomerOrderOverview.tsx", "utf8");
  const authenticated = readFileSync("src/app/orders/[id]/page.tsx", "utf8");
  const guest = readFileSync("src/app/orders/guest/[id]/page.tsx", "utf8");
  assert.match(component, /aria-current=.*step/);
  assert.match(component, /aria-labelledby="order-title"/);
  assert.match(component, /min-w-0/);
  assert.match(component, /Payment information unavailable/);
  assert.match(authenticated, /CustomerOrderOverview/);
  assert.match(guest, /CustomerOrderOverview/);
  assert.doesNotMatch(component, /machine|assignee|blocker|staff_notes|payment_intent/i);
});

test("authenticated reader is a named customer projection and notes are not exposed in updates", () => {
  const page = readFileSync("src/app/orders/[id]/page.tsx", "utf8");
  assert.doesNotMatch(page, /select\("\*/);
  assert.doesNotMatch(page, /detail:item\.note/);
  assert.match(page, /\.eq\("id", id\)\.maybeSingle\(\)/);
});
