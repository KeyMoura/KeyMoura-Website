import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("customer status changes use specific order notifications", () => {
  const route = read("src/app/api/staff/orders/[id]/route.ts");
  for (const title of [
    "More information needed",
    "Order request accepted",
    "Payment ready",
    "Production started",
    "Finished product ready for review",
    "Order completed",
    "Order request declined",
    "Order cancelled",
  ]) assert.match(route, new RegExp(title));
});

test("notification center presents customer order updates as KeyMoura activity", () => {
  const page = readFileSync("src/app/account/notifications/page.tsx", "utf8");
  assert.match(page, /Order updates, messages, and activity across KeyMoura/);
  assert.match(page, /isCustomerOrderUpdate/);
});

/**
 * Re-pointed at the fulfillment route.
 *
 * The old assertion pinned a ternary in `PATCH /api/staff/orders/[id]` that
 * chose pickup or shipping wording. That branch went with `shipment_action` in
 * pass 11 — it was a second, unguarded fulfillment path that skipped the
 * `fulfillment.manage` permission.
 *
 * The distinction it protected is now structural rather than a ternary: pickup
 * and shipping are different *states* with their own labels and their own
 * message lines, so the two cannot be conflated by editing one condition.
 */
test("shipping and pickup notifications use distinct customer language", () => {
  const route = read("src/app/api/staff/orders/[id]/fulfillment/route.ts");
  const labels = read("src/lib/commerce/orderLifecycle.ts");

  assert.match(route, /ready_for_pickup: "Your order is ready to collect\."/);
  assert.match(route, /picked_up: "Your order was collected\. Thank you\."/);
  assert.match(route, /shipped: tracking \?/);
  assert.match(route, /delivered: "Your order was marked delivered\."/);

  for (const [state, label] of [
    ["ready_for_pickup", "Ready for pickup"],
    ["picked_up", "Picked up"],
    ["shipped", "Shipped"],
    ["delivered", "Delivered"],
  ]) {
    assert.match(labels, new RegExp(`${state}: "${label}"`), `${state} needs its own customer label`);
  }

  // A pickup order can never reach the shipped wording, because it can never
  // reach the shipped state.
  assert.match(route, /canTransitionFulfillmentForMethod/);
});

test("private Workshop updates do not create order notifications", () => {
  const workspace = read("src/app/api/staff/orders/[id]/workspace/route.ts");
  assert.doesNotMatch(workspace, /notifyOrder(?:User|Staff)/);
  assert.doesNotMatch(workspace, /from\("notifications"\)/);
});

test("major customer actions notify staff", () => {
  for (const path of [
    "src/app/api/orders/[id]/messages/route.ts",
    "src/app/api/orders/[id]/proposal/route.ts",
    "src/app/api/orders/[id]/quote/route.ts",
    "src/app/api/orders/[id]/final-review/route.ts",
    "src/app/api/webhooks/stripe/route.ts",
  ]) assert.match(read(path), /notifyOrderStaff/);
});
