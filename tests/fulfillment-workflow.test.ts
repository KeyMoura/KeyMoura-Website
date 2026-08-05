import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FULFILLMENT_CUSTOMER_EMAIL,
  FULFILLMENT_LABELS,
  FULFILLMENT_STAFF_LABELS,
  FULFILLMENT_STATES,
  FULFILLMENT_TRANSITIONS,
  canTransitionFulfillment,
  canTransitionFulfillmentForMethod,
  fulfillmentTransitionsFor,
  type FulfillmentState,
} from "../src/lib/commerce/orderLifecycle.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const route = read("src/app/api/staff/orders/[id]/fulfillment/route.ts");

/**
 * The fulfillment state machine.
 *
 * The property that matters most: a shipped order cannot silently become
 * unfulfilled, and a picked-up order cannot return to ready-for-pickup. Both
 * would mean a second label or a second handover for something already gone.
 */

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

test("every state has an entry, and every target is a real state", () => {
  for (const state of FULFILLMENT_STATES) {
    assert.ok(Array.isArray(FULFILLMENT_TRANSITIONS[state]), `${state} has no transition list`);
    for (const target of FULFILLMENT_TRANSITIONS[state]) {
      assert.ok(FULFILLMENT_STATES.includes(target), `${state} -> ${target} is not a real state`);
    }
  }
});

test("every state has both a customer and a staff label", () => {
  for (const state of FULFILLMENT_STATES) {
    assert.ok(FULFILLMENT_LABELS[state], `${state} has no customer label`);
    assert.ok(FULFILLMENT_STAFF_LABELS[state], `${state} has no staff label`);
  }
});

test("the pass-7 states and edges all survive", () => {
  // Pass 8 widened this graph. Nothing it added may remove an edge an existing
  // order could already have taken.
  for (const state of [
    "not_required", "unfulfilled", "processing", "ready_for_pickup",
    "picked_up", "shipped", "delivered", "returned", "partially_returned",
  ] as FulfillmentState[]) {
    assert.ok(FULFILLMENT_STATES.includes(state));
  }
  assert.equal(canTransitionFulfillment("processing", "shipped"), true);
  assert.equal(canTransitionFulfillment("processing", "ready_for_pickup"), true);
  assert.equal(canTransitionFulfillment("shipped", "delivered"), true);
  assert.equal(canTransitionFulfillment("ready_for_pickup", "picked_up"), true);
});

test("a shipped order can never become unfulfilled again", () => {
  for (const departed of ["shipped", "delivered", "picked_up"] as FulfillmentState[]) {
    for (const backwards of ["unfulfilled", "processing", "ready_to_fulfill", "ready_for_pickup"] as FulfillmentState[]) {
      assert.equal(
        canTransitionFulfillment(departed, backwards),
        false,
        `${departed} -> ${backwards} must be refused`
      );
    }
  }
});

test("a picked-up order cannot go back to ready for pickup", () => {
  assert.equal(canTransitionFulfillment("picked_up", "ready_for_pickup"), false);
});

test("re-selecting the current state is never a transition, so a dropdown touch is not a write", () => {
  for (const state of FULFILLMENT_STATES) {
    assert.equal(canTransitionFulfillment(state, state), false);
  }
});

test("terminal states are terminal", () => {
  assert.deepEqual([...FULFILLMENT_TRANSITIONS.returned], []);
  assert.deepEqual([...FULFILLMENT_TRANSITIONS.canceled], []);
});

test("fulfillment can be cancelled before departure and not after", () => {
  for (const before of ["unfulfilled", "processing", "ready_to_fulfill", "ready_for_pickup"] as FulfillmentState[]) {
    assert.equal(canTransitionFulfillment(before, "canceled"), true, `${before} should be cancellable`);
  }
  for (const after of ["shipped", "delivered", "picked_up"] as FulfillmentState[]) {
    assert.equal(canTransitionFulfillment(after, "canceled"), false, `${after} has already left the shop`);
  }
});

// ---------------------------------------------------------------------------
// Method narrowing
// ---------------------------------------------------------------------------

test("a pickup order is never offered shipping states", () => {
  for (const from of FULFILLMENT_STATES) {
    for (const target of fulfillmentTransitionsFor(from, "pickup")) {
      assert.ok(!["shipped", "delivered"].includes(target), `pickup order offered ${target} from ${from}`);
    }
  }
});

test("a shipping order is never offered pickup states", () => {
  for (const from of FULFILLMENT_STATES) {
    for (const target of fulfillmentTransitionsFor(from, "shipping")) {
      assert.ok(!["ready_for_pickup", "picked_up"].includes(target), `shipping order offered ${target} from ${from}`);
    }
  }
});

test("shipping and pickup controls can never both be offered", () => {
  for (const method of ["shipping", "pickup", "none"]) {
    for (const from of FULFILLMENT_STATES) {
      const targets = fulfillmentTransitionsFor(from, method);
      const hasShipping = targets.some((t) => ["shipped", "delivered"].includes(t));
      const hasPickup = targets.some((t) => ["ready_for_pickup", "picked_up"].includes(t));
      assert.ok(!(hasShipping && hasPickup), `${method}/${from} offers both channels`);
    }
  }
});

test("a no-fulfillment order is offered no delivery states at all", () => {
  for (const from of FULFILLMENT_STATES) {
    for (const target of fulfillmentTransitionsFor(from, "none")) {
      assert.ok(
        !["shipped", "delivered", "ready_for_pickup", "picked_up", "ready_to_fulfill"].includes(target),
        `no-fulfillment order offered ${target}`
      );
    }
  }
});

test("an unknown method is treated as shipping rather than unlocking everything", () => {
  const targets = fulfillmentTransitionsFor("processing", "banana");
  assert.ok(!targets.includes("ready_for_pickup"));
});

test("the method-aware check refuses what the base graph refuses", () => {
  for (const from of FULFILLMENT_STATES) {
    for (const to of FULFILLMENT_STATES) {
      if (canTransitionFulfillmentForMethod(from, to, "shipping")) {
        assert.equal(canTransitionFulfillment(from, to), true, `${from} -> ${to} narrowed check is broader than the graph`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// What the customer is told
// ---------------------------------------------------------------------------

test("every customer-facing email key maps to a real state", () => {
  for (const state of Object.keys(FULFILLMENT_CUSTOMER_EMAIL)) {
    assert.ok(FULFILLMENT_STATES.includes(state as FulfillmentState), `${state} is not a real state`);
  }
});

test("packing and cancelling send the customer nothing", () => {
  // The customer has no action to take when an order is packed, and a
  // cancellation is announced by the cancellation flow, not by this one.
  assert.equal(FULFILLMENT_CUSTOMER_EMAIL.ready_to_fulfill, undefined);
  assert.equal(FULFILLMENT_CUSTOMER_EMAIL.canceled, undefined);
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

test("reading and writing fulfillment need different permissions", () => {
  assert.match(route, /requirePermission\(req, "fulfillment\.view"\)/);
  assert.match(route, /requirePermission\(req, "fulfillment\.manage"\)/);
});

test("a stale page is refused rather than allowed to overwrite", () => {
  assert.match(route, /expectedStatus/);
  assert.match(route, /status: 409/);
  assert.match(route, /moved on since the page loaded/i);
});

test("marking shipped without tracking is refused before the state moves", () => {
  const shippedGuard = route.slice(route.indexOf('if (to === "shipped"'));
  assert.match(shippedGuard.slice(0, 700), /Add a carrier and tracking number/);
  // The refusal has to come before the transition, or the order ends up
  // "shipped" with nothing to tell the customer.
  assert.ok(route.indexOf('if (to === "shipped"') < route.indexOf("transitionFulfillment({"));
});

test("a repeated submission is idempotent and sends nothing twice", () => {
  assert.match(route, /if \(result\.already\) return NextResponse\.json\(\{ ok: true, already: true/);
  // The early return sits before the notification and the audit write.
  const alreadyAt = route.indexOf("result.already");
  assert.ok(alreadyAt < route.indexOf("notifyCustomer("), "an already-applied transition must not re-notify");
  assert.ok(alreadyAt < route.indexOf("logLifecycleAudit("), "an already-applied transition must not re-audit");
});

test("the transition is conditional on the from-status, not a blind write", () => {
  assert.match(route, /from: current/);
  assert.match(route, /canTransitionFulfillmentForMethod\(current, to, method\)/);
});

test("internal notes never reach the customer", () => {
  // `customerNote` is the only free text routed into the notification, and
  // `fulfillment_notes` is the internal column.
  const notify = route.slice(route.indexOf("async function notifyCustomer"));
  assert.match(notify, /detail: input\.customerNote \|\| ""/);
  // Asserted against a *read* of the internal column, not the bare word, so the
  // comment explaining the rule does not fail the rule.
  assert.doesNotMatch(
    notify,
    /\.fulfillment_notes/,
    "the internal note column must never be read on the customer notification path"
  );
});

test("a tracking correction preserves the previous values and does not rewind the state", () => {
  const update = route.slice(route.indexOf("async function updateTracking"));
  assert.match(update, /previous_carrier/);
  assert.match(update, /previous_tracking/);
  assert.match(update, /from_status: input\.current,\s*\n\s*to_status: input\.current/);
  assert.match(update, /staff\.order\.tracking_corrected/);
});

test("a manual tracking URL is validated at the route, not just at the form", () => {
  assert.match(route, /isSafeTrackingUrl\(input\.manualUrl\)/);
  assert.match(route, /buildTrackingUrl\(input\.settings, input\.carrier, input\.number\)/);
});
