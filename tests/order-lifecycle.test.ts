import assert from "node:assert/strict";
import test from "node:test";

import {
  CANCELLATION_REASON_CODES,
  DEFAULT_COMMERCE_POLICY,
  FULFILLMENT_TRANSITIONS,
  RETURN_REASON_CODES,
  RETURN_TRANSITIONS,
  canTransitionCancellationRequest,
  canTransitionFulfillment,
  canTransitionReturn,
  customerLifecycleHeadline,
  evaluateCancellation,
  evaluateReturn,
  hasCollectedPayment,
  parseCommercePolicy,
  paymentWasTaken,
  refundableCents,
  returnRefundCents,
  type CommercePolicy,
} from "../src/lib/commerce/orderLifecycle.ts";

/**
 * The lifecycle rules, tested as rules.
 *
 * Everything here is a pure function, which is the point: the customer page,
 * the staff workspace and four route handlers all import these, so a bug found
 * here is a bug found in every surface at once.
 */

const policy = (overrides: Partial<CommercePolicy>): CommercePolicy => ({
  ...DEFAULT_COMMERCE_POLICY,
  ...overrides,
  cancellation: { ...DEFAULT_COMMERCE_POLICY.cancellation, ...(overrides.cancellation ?? {}) },
  returns: { ...DEFAULT_COMMERCE_POLICY.returns, ...(overrides.returns ?? {}) },
  inventory: { ...DEFAULT_COMMERCE_POLICY.inventory, ...(overrides.inventory ?? {}) },
});

const baseOrder = {
  status: "awaiting_payment",
  payment_status: "unpaid",
  cancellation_status: "none",
  fulfillment_status: "unfulfilled",
  return_status: "none",
  amount_paid_cents: 0,
  amount_refunded_cents: 0,
};

// ---------------------------------------------------------------------------
// Refundable arithmetic
// ---------------------------------------------------------------------------

test("refundable subtracts settled refunds", () => {
  assert.equal(refundableCents({ amount_paid_cents: 10_000, amount_refunded_cents: 2_500 }), 7_500);
});

test("refundable also subtracts refunds still in flight", () => {
  // The whole point. A refund handed to Stripe and not yet confirmed is money
  // already committed; counting it as available is how the same order gets
  // refunded twice by two people looking at the same screen.
  assert.equal(
    refundableCents({ amount_paid_cents: 10_000, amount_refunded_cents: 2_500, pending_refund_cents: 5_000 }),
    2_500
  );
});

test("refundable never goes negative", () => {
  assert.equal(
    refundableCents({ amount_paid_cents: 1_000, amount_refunded_cents: 900, pending_refund_cents: 400 }),
    0
  );
});

test("refundable ignores missing fields rather than producing NaN", () => {
  assert.equal(refundableCents({}), 0);
  assert.equal(refundableCents({ amount_paid_cents: null, amount_refunded_cents: null }), 0);
});

test("a partially refunded order still counts as having taken payment", () => {
  assert.equal(paymentWasTaken({ payment_status: "partially_refunded", amount_paid_cents: 5_000 }), true);
  assert.equal(hasCollectedPayment({ payment_status: "partially_refunded", amount_paid_cents: 5_000, amount_refunded_cents: 1_000 }), true);
});

test("a fully refunded order has collected nothing net", () => {
  assert.equal(
    hasCollectedPayment({ payment_status: "refunded", amount_paid_cents: 5_000, amount_refunded_cents: 5_000 }),
    false
  );
});

test("a failed payment has not collected anything", () => {
  assert.equal(hasCollectedPayment({ payment_status: "payment_failed", amount_paid_cents: 0 }), false);
});

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

test("fulfillment cannot move backwards", () => {
  assert.equal(canTransitionFulfillment("shipped", "unfulfilled"), false);
  assert.equal(canTransitionFulfillment("delivered", "shipped"), false);
  assert.equal(canTransitionFulfillment("picked_up", "ready_for_pickup"), false);
});

test("fulfillment moves forward along the real path", () => {
  assert.equal(canTransitionFulfillment("unfulfilled", "processing"), true);
  assert.equal(canTransitionFulfillment("processing", "shipped"), true);
  assert.equal(canTransitionFulfillment("shipped", "delivered"), true);
  assert.equal(canTransitionFulfillment("ready_for_pickup", "picked_up"), true);
});

test("re-selecting the current fulfillment state is not a transition", () => {
  for (const state of Object.keys(FULFILLMENT_TRANSITIONS)) {
    assert.equal(canTransitionFulfillment(state, state), false, `${state} → ${state}`);
  }
});

test("a return cannot skip receipt on the way to inspection", () => {
  assert.equal(canTransitionReturn("approved", "inspected"), false);
  assert.equal(canTransitionReturn("requested", "received"), false);
  assert.equal(canTransitionReturn("received", "inspected"), true);
});

test("a denied return is terminal and cannot silently reopen", () => {
  assert.deepEqual(RETURN_TRANSITIONS.denied, []);
  for (const target of Object.keys(RETURN_TRANSITIONS)) {
    assert.equal(canTransitionReturn("denied", target), false, `denied → ${target}`);
  }
});

test("a denied cancellation request is terminal", () => {
  for (const target of ["pending", "approved", "completed", "withdrawn"]) {
    assert.equal(canTransitionCancellationRequest("denied", target), false, `denied → ${target}`);
  }
});

test("an approved cancellation can complete or fail, but not be re-decided", () => {
  assert.equal(canTransitionCancellationRequest("approved", "completed"), true);
  assert.equal(canTransitionCancellationRequest("approved", "failed"), true);
  assert.equal(canTransitionCancellationRequest("approved", "denied"), false);
});

test("a failed refund can be retried into completion", () => {
  assert.equal(canTransitionCancellationRequest("failed", "completed"), true);
});

// ---------------------------------------------------------------------------
// Cancellation eligibility
// ---------------------------------------------------------------------------

test("an unpaid order cancels immediately", () => {
  const result = evaluateCancellation({ ...baseOrder });
  assert.equal(result.kind, "immediate");
});

test("a paid order must go through review", () => {
  const result = evaluateCancellation({
    ...baseOrder,
    payment_status: "paid",
    status: "in_progress",
    amount_paid_cents: 12_000,
  });
  assert.equal(result.kind, "request");
  assert.equal(result.kind === "request" && result.refundableCents, 12_000);
});

test("a customer is never told a refund is automatic", () => {
  const result = evaluateCancellation({
    ...baseOrder,
    payment_status: "paid",
    amount_paid_cents: 5_000,
  });
  assert.equal(result.kind, "request");
  if (result.kind !== "request") return;
  assert.match(result.note, /not automatic/i);
});

test("a shipped order cannot be cancelled and is pointed at returns", () => {
  const result = evaluateCancellation({
    ...baseOrder,
    payment_status: "paid",
    amount_paid_cents: 5_000,
    fulfillment_status: "shipped",
  });
  assert.equal(result.kind, "unavailable");
  assert.equal(result.kind === "unavailable" && /return/i.test(result.reason), true);
});

test("a delivered order cannot be cancelled", () => {
  const result = evaluateCancellation({
    ...baseOrder,
    payment_status: "paid",
    amount_paid_cents: 5_000,
    fulfillment_status: "delivered",
  });
  assert.equal(result.kind, "unavailable");
});

test("an already-cancelled order offers nothing", () => {
  const result = evaluateCancellation({ ...baseOrder, status: "cancelled", cancellation_status: "completed" });
  assert.equal(result.kind, "unavailable");
});

test("an open request blocks a second one", () => {
  const result = evaluateCancellation({ ...baseOrder, payment_status: "paid", amount_paid_cents: 100, hasOpenRequest: true });
  assert.equal(result.kind, "pending");
});

test("an approved cancellation awaiting its refund reads as pending, not actionable", () => {
  const result = evaluateCancellation({
    ...baseOrder,
    payment_status: "paid",
    amount_paid_cents: 5_000,
    cancellation_status: "refund_pending",
  });
  assert.equal(result.kind, "pending");
});

test("materials committed blocks online cancellation when policy says so", () => {
  const result = evaluateCancellation({
    ...baseOrder,
    payment_status: "paid",
    amount_paid_cents: 5_000,
    productionStatus: "waiting_on_materials",
    policy: policy({ cancellation: { ...DEFAULT_COMMERCE_POLICY.cancellation, blockAfterMaterialsOrdered: true } }),
  });
  assert.equal(result.kind, "unavailable");
  assert.equal(result.kind === "unavailable" && /materials/i.test(result.reason), true);
});

test("production started blocks cancellation only when the owner turned that on", () => {
  const started = { ...baseOrder, payment_status: "paid", amount_paid_cents: 5_000, productionStatus: "in_progress" };

  const permissive = evaluateCancellation({
    ...started,
    policy: policy({
      cancellation: {
        ...DEFAULT_COMMERCE_POLICY.cancellation,
        blockAfterProductionStart: false,
        blockAfterMaterialsOrdered: false,
      },
    }),
  });
  assert.equal(permissive.kind, "request");

  const strict = evaluateCancellation({
    ...started,
    policy: policy({
      cancellation: { ...DEFAULT_COMMERCE_POLICY.cancellation, blockAfterProductionStart: true },
    }),
  });
  assert.equal(strict.kind, "unavailable");
});

test("a custom order can be excluded from paid cancellation by policy", () => {
  const result = evaluateCancellation({
    ...baseOrder,
    payment_status: "paid",
    amount_paid_cents: 5_000,
    order_kind: "custom_request",
    policy: policy({ cancellation: { ...DEFAULT_COMMERCE_POLICY.cancellation, blockForCustomOrders: true } }),
  });
  assert.equal(result.kind, "unavailable");
});

test("the unpaid cancellation window closes when configured", () => {
  const created = new Date("2026-08-01T00:00:00Z").toISOString();
  const withinWindow = evaluateCancellation({
    ...baseOrder,
    created_at: created,
    now: new Date("2026-08-01T06:00:00Z"),
    policy: policy({ cancellation: { ...DEFAULT_COMMERCE_POLICY.cancellation, unpaidWindowHours: 24 } }),
  });
  assert.equal(withinWindow.kind, "immediate");

  const afterWindow = evaluateCancellation({
    ...baseOrder,
    created_at: created,
    now: new Date("2026-08-03T06:00:00Z"),
    policy: policy({ cancellation: { ...DEFAULT_COMMERCE_POLICY.cancellation, unpaidWindowHours: 24 } }),
  });
  assert.equal(afterWindow.kind, "unavailable");
});

test("a zero window means no window, not an instantly closed one", () => {
  const result = evaluateCancellation({
    ...baseOrder,
    created_at: new Date("2020-01-01T00:00:00Z").toISOString(),
    now: new Date("2026-08-05T00:00:00Z"),
  });
  assert.equal(result.kind, "immediate");
});

// ---------------------------------------------------------------------------
// Return eligibility
// ---------------------------------------------------------------------------

const catalogueLine = {
  order_item_id: "item-1",
  product_name: "Premade Shift Knob",
  unit_price_cents: 4_000,
  quantity: 2,
  returned_quantity: 0,
  is_custom: false,
};

const deliveredOrder = {
  status: "completed",
  payment_status: "paid",
  fulfillment_status: "delivered",
  return_status: "none",
  delivered_at: new Date("2026-08-01T00:00:00Z").toISOString(),
  lines: [catalogueLine],
  now: new Date("2026-08-05T00:00:00Z"),
};

test("a delivered catalogue order inside the window is returnable", () => {
  const result = evaluateReturn(deliveredOrder);
  assert.equal(result.kind, "eligible");
  assert.equal(result.kind === "eligible" && result.lines[0].quantity, 2);
});

test("an undelivered order is not returnable and is pointed at cancellation", () => {
  const result = evaluateReturn({ ...deliveredOrder, fulfillment_status: "processing" });
  assert.equal(result.kind, "unavailable");
  assert.equal(result.kind === "unavailable" && /cancel/i.test(result.reason), true);
});

test("the return window closes", () => {
  const result = evaluateReturn({ ...deliveredOrder, now: new Date("2026-10-01T00:00:00Z") });
  assert.equal(result.kind, "unavailable");
  assert.equal(result.kind === "unavailable" && /window/i.test(result.reason), true);
});

test("custom products are excluded by default rather than inheriting catalogue rules", () => {
  // The brief is explicit: a bespoke part must not silently pick up the
  // standard 30-day return.
  const result = evaluateReturn({ ...deliveredOrder, lines: [{ ...catalogueLine, is_custom: true }] });
  assert.equal(result.kind, "unavailable");
  assert.equal(result.kind === "unavailable" && /custom/i.test(result.reason), true);
  assert.equal(DEFAULT_COMMERCE_POLICY.returns.allowCustomProducts, false);
});

test("custom products become returnable when the owner opts in", () => {
  const result = evaluateReturn({
    ...deliveredOrder,
    lines: [{ ...catalogueLine, is_custom: true }],
    policy: policy({ returns: { ...DEFAULT_COMMERCE_POLICY.returns, allowCustomProducts: true } }),
  });
  assert.equal(result.kind, "eligible");
});

test("already-returned quantity is deducted from what may be returned again", () => {
  const result = evaluateReturn({ ...deliveredOrder, lines: [{ ...catalogueLine, returned_quantity: 1 }] });
  assert.equal(result.kind, "eligible");
  assert.equal(result.kind === "eligible" && result.lines[0].quantity, 1);
});

test("a fully returned order offers nothing more", () => {
  const result = evaluateReturn({ ...deliveredOrder, lines: [{ ...catalogueLine, returned_quantity: 2 }] });
  assert.equal(result.kind, "unavailable");
});

test("an open return blocks a second one", () => {
  const result = evaluateReturn({ ...deliveredOrder, hasOpenReturn: true });
  assert.equal(result.kind, "pending");
});

test("an unpaid order has nothing to return", () => {
  const result = evaluateReturn({ ...deliveredOrder, payment_status: "unpaid" });
  assert.equal(result.kind, "unavailable");
});

test("a picked-up order is returnable on its pickup date", () => {
  const result = evaluateReturn({
    ...deliveredOrder,
    fulfillment_status: "picked_up",
    delivered_at: null,
    picked_up_at: new Date("2026-08-01T00:00:00Z").toISOString(),
  });
  assert.equal(result.kind, "eligible");
});

test("returns can be switched off entirely", () => {
  const result = evaluateReturn({
    ...deliveredOrder,
    policy: policy({ returns: { ...DEFAULT_COMMERCE_POLICY.returns, enabled: false } }),
  });
  assert.equal(result.kind, "unavailable");
});

test("a zero-day window means no window rather than no returns", () => {
  const result = evaluateReturn({
    ...deliveredOrder,
    now: new Date("2030-01-01T00:00:00Z"),
    policy: policy({ returns: { ...DEFAULT_COMMERCE_POLICY.returns, windowDays: 0 } }),
  });
  assert.equal(result.kind, "eligible");
});

// ---------------------------------------------------------------------------
// Return value arithmetic
// ---------------------------------------------------------------------------

test("returned value is quantity times unit price", () => {
  assert.equal(returnRefundCents([{ unit_price_cents: 4_000, quantity: 2 }]), 8_000);
});

test("a restocking fee comes off the returned value", () => {
  assert.equal(returnRefundCents([{ unit_price_cents: 10_000, quantity: 1 }], 15), 8_500);
});

test("a restocking fee cannot exceed the value or invert it", () => {
  assert.equal(returnRefundCents([{ unit_price_cents: 1_000, quantity: 1 }], 500), 0);
  assert.equal(returnRefundCents([{ unit_price_cents: 1_000, quantity: 1 }], -50), 1_000);
});

// ---------------------------------------------------------------------------
// Policy parsing
// ---------------------------------------------------------------------------

test("policy parsing is total", () => {
  // The column is jsonb with only an object CHECK behind it. A hand-edited row
  // holding nonsense must not be able to take cancellations offline.
  for (const input of [null, undefined, 0, "", [], "not json", { cancellation: "yes" }]) {
    const parsed = parseCommercePolicy(input);
    assert.equal(typeof parsed.cancellation.allowPaidRequests, "boolean");
    assert.equal(typeof parsed.returns.windowDays, "number");
    assert.equal(Number.isFinite(parsed.returns.windowDays), true);
  }
});

test("policy parsing clamps rather than trusting", () => {
  const parsed = parseCommercePolicy({
    returns: { windowDays: 99_999, restockingFeePercent: 400 },
    cancellation: { unpaidWindowHours: -20 },
  });
  assert.equal(parsed.returns.windowDays, 730);
  assert.equal(parsed.returns.restockingFeePercent, 100);
  assert.equal(parsed.cancellation.unpaidWindowHours, 0);
});

test("policy parsing keeps values it recognizes", () => {
  const parsed = parseCommercePolicy({
    returns: { windowDays: 14, allowCustomProducts: true },
    inventory: { restoreOnReturn: false },
  });
  assert.equal(parsed.returns.windowDays, 14);
  assert.equal(parsed.returns.allowCustomProducts, true);
  assert.equal(parsed.inventory.restoreOnReturn, false);
  // Untouched keys keep their defaults rather than becoming undefined.
  assert.equal(parsed.returns.enabled, DEFAULT_COMMERCE_POLICY.returns.enabled);
});

test("a non-string return address entry is dropped rather than rendered", () => {
  const parsed = parseCommercePolicy({ returns: { returnAddress: { line1: "12 Mill Road", zip: 12345, bad: null } } });
  assert.deepEqual(parsed.returns.returnAddress, { line1: "12 Mill Road" });
});

// ---------------------------------------------------------------------------
// Customer-facing wording
// ---------------------------------------------------------------------------

test("the headline leads with whatever the customer is waiting on", () => {
  assert.equal(
    customerLifecycleHeadline({
      status: "in_progress",
      payment_status: "paid",
      fulfillment_status: "unfulfilled",
      cancellation_status: "requested",
      return_status: "none",
    }),
    "Cancellation requested"
  );
  assert.equal(
    customerLifecycleHeadline({
      status: "completed",
      payment_status: "paid",
      fulfillment_status: "delivered",
      cancellation_status: "none",
      return_status: "received",
    }),
    "Return received"
  );
  assert.equal(
    customerLifecycleHeadline({
      status: "completed",
      payment_status: "paid",
      fulfillment_status: "shipped",
      cancellation_status: "none",
      return_status: "none",
    }),
    "Shipped"
  );
});

test("every reason code offered to a customer is one the database accepts", () => {
  // The CHECK constraints in 20260805010000 list these exact values; a code
  // offered in a dropdown that the column refuses is a 500 waiting to happen.
  const migrationCancellation = [
    "changed_mind",
    "ordered_by_mistake",
    "found_another_option",
    "taking_too_long",
    "no_longer_needed",
    "duplicate_order",
    "incorrect_details",
    "other",
  ];
  const migrationReturn = [
    "wrong_item",
    "damaged_in_transit",
    "defective",
    "does_not_fit",
    "not_as_described",
    "changed_mind",
    "other",
  ];
  assert.deepEqual([...CANCELLATION_REASON_CODES].sort(), migrationCancellation.sort());
  assert.deepEqual([...RETURN_REASON_CODES].sort(), migrationReturn.sort());
});
