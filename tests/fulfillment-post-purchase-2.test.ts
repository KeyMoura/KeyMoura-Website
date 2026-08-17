import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ACTIVE_FULFILLMENT_BUCKETS,
  FULFILLMENT_BUCKETS,
  FULFILLMENT_BUCKET_COPY,
  attentionQueue,
  fulfillmentBucket,
  fulfillmentNextAction,
  groupByFulfillmentBucket,
  productionComplete,
  requiresProduction,
  type QueueOrder,
} from "../src/lib/staff/operationsQueues.ts";
import { customerOrderProgress } from "../src/lib/commerce/customerOrderView.ts";
import { orderCustomerStatus } from "../src/lib/orderHub.ts";

/**
 * Fulfillment 2.0 — the production handoff.
 *
 * The defect this pass exists to close: **payment was being read as production
 * completion.** `record_stripe_order_payment` moves every paid order to
 * `in_progress` — which means production has *started* — and both the staff
 * fulfillment queue and the customer timeline treated that as the goods
 * existing. The bench was handed work that had not been made, and the customer
 * was shown a ticked "In production" stage at checkout.
 *
 * These tests pin the rule in both directions: production completion hands an
 * order to fulfillment, and nothing short of it does.
 */

const read = (path: string) => readFileSync(path, "utf8");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");

const fulfillmentRoute = read("src/app/api/staff/orders/[id]/fulfillment/route.ts");
const productionRoute = read("src/app/api/staff/production/jobs/[id]/status/route.ts");
const orderRoute = read("src/app/api/staff/orders/[id]/route.ts");
const queuePage = read("src/app/staff/fulfillment/page.tsx");
const panel = read("src/components/staff/OrderFulfillmentPanel.tsx");

/** A paid, made-to-order shipping order that has not been fulfilled. */
const order = (over: Partial<QueueOrder> = {}): QueueOrder => ({
  id: "o1",
  order_number: "KM-0001",
  customer_id: "c1",
  product_name: "Shift knob",
  status: "in_progress",
  order_kind: "direct_purchase",
  quantity: 1,
  agreed_price_cents: 5000,
  amount_paid_cents: 5000,
  amount_refunded_cents: 0,
  payment_status: "paid",
  fulfillment_status: "unfulfilled",
  fulfillment_method: "shipping",
  cancellation_status: "none",
  return_status: "none",
  shipping_carrier: null,
  tracking_number: null,
  ready_at: null,
  shipped_at: null,
  delivered_at: null,
  target_date: null,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
  ...over,
});

// ---------------------------------------------------------------------------
// What needs making, and what is made
// ---------------------------------------------------------------------------

test("a bespoke order always needs production; a catalogue purchase does not", () => {
  assert.equal(requiresProduction({ order_kind: "custom_request", production_status: null }), true);
  assert.equal(requiresProduction({ order_kind: "direct_purchase", production_status: null }), false);
  // Opening a job is the other way an order becomes made-to-order.
  assert.equal(requiresProduction({ order_kind: "direct_purchase", production_status: "in_progress" }), true);
});

test("REGRESSION a paid order in production is not treated as made", () => {
  /*
   * `in_progress` is what a *payment* sets. Reading it as "production finished"
   * is the whole defect: every one of these was sitting in the packing queue.
   */
  assert.equal(
    productionComplete({ status: "in_progress", order_kind: "custom_request", production_status: null }),
    false
  );
  assert.equal(
    productionComplete({ status: "ready", order_kind: "custom_request", production_status: null }),
    true
  );
  assert.equal(
    productionComplete({ status: "completed", order_kind: "custom_request", production_status: null }),
    true
  );
});

test("final review is not production complete, because the part may still be revised", () => {
  assert.equal(
    productionComplete({ status: "final_review", order_kind: "custom_request", production_status: null }),
    false
  );
});

test("a job that exists outranks the order status, and the least advanced job wins", () => {
  // The order says ready; the job says otherwise, and the job is the record of
  // the actual work.
  assert.equal(
    productionComplete({ status: "ready", order_kind: "direct_purchase", production_status: "in_progress" }),
    false
  );
  for (const done of ["completed", "ready_to_ship", "ready_for_pickup"]) {
    assert.equal(
      productionComplete({ status: "in_progress", order_kind: "direct_purchase", production_status: done }),
      true,
      `${done} means the goods exist`
    );
  }
});

test("an order needing no production is fulfillable as soon as it is paid", () => {
  // Preserves how every existing direct purchase already behaves. Gating these
  // on a status nobody sets would strand real stock orders in a queue forever.
  assert.equal(fulfillmentBucket(order()), "to_prepare");
});

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

test("REGRESSION a paid bespoke order in production waits for production, not the packing bench", () => {
  const bespoke = order({ order_kind: "custom_request" });
  assert.equal(fulfillmentBucket(bespoke), "awaiting_production");
  assert.equal(fulfillmentNextAction(bespoke), "Waiting on production to finish");
});

test("production finishing is what moves an order into the packing queue", () => {
  const made = order({ order_kind: "custom_request", status: "ready" });
  assert.equal(fulfillmentBucket(made), "to_prepare");
  assert.equal(fulfillmentNextAction(made), "Start preparing this order");
});

test("money is still checked before production, because an unpaid order is not work", () => {
  const unpaid = order({ order_kind: "custom_request", amount_paid_cents: 0, payment_status: "unpaid" });
  assert.equal(fulfillmentBucket(unpaid), "awaiting_payment");
});

test("work somebody has physically started is reported as started, not as early", () => {
  // Packing ahead of production is allowed and harmless; only the handover is
  // consequential. Hiding started work would be worse than showing it.
  const started = order({ order_kind: "custom_request", fulfillment_status: "processing" });
  assert.equal(fulfillmentBucket(started), "in_progress");
});

test("the production gate never pulls an order backwards out of a departed state", () => {
  for (const [state, bucket] of [
    ["shipped", "in_transit"],
    ["delivered", "settled"],
    ["picked_up", "settled"],
    ["ready_to_fulfill", "ready"],
    ["ready_for_pickup", "ready"],
  ] as const) {
    assert.equal(
      fulfillmentBucket(order({ order_kind: "custom_request", fulfillment_status: state })),
      bucket,
      `${state} must stay in ${bucket} whatever production says`
    );
  }
});

test("a cancelled order is not active fulfillment work", () => {
  assert.equal(
    fulfillmentBucket(order({ status: "cancelled", fulfillment_status: "unfulfilled" })),
    "not_applicable"
  );
  assert.equal(fulfillmentBucket(order({ fulfillment_status: "canceled" })), "not_applicable");
});

test("every order lands in exactly one bucket, so the counts still add up", () => {
  const rows = [
    order(),
    order({ id: "o2", order_kind: "custom_request" }),
    order({ id: "o3", order_kind: "custom_request", status: "ready" }),
    order({ id: "o4", fulfillment_status: "shipped" }),
    order({ id: "o5", fulfillment_status: "delivered" }),
    order({ id: "o6", status: "cancelled" }),
    order({ id: "o7", amount_paid_cents: 0, payment_status: "unpaid" }),
  ];
  const grouped = groupByFulfillmentBucket(rows);
  const total = FULFILLMENT_BUCKETS.reduce((sum, key) => sum + grouped[key].length, 0);
  assert.equal(total, rows.length);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
});

test("every bucket has copy, and the new one leads the live queues", () => {
  for (const bucket of FULFILLMENT_BUCKETS) {
    assert.ok(FULFILLMENT_BUCKET_COPY[bucket]?.label, `${bucket} has no label`);
    assert.ok(FULFILLMENT_BUCKET_COPY[bucket]?.description, `${bucket} has no description`);
  }
  assert.equal(ACTIVE_FULFILLMENT_BUCKETS[0], "awaiting_production");
});

test("an order still being made is not raised as fulfillment work needing a human", () => {
  const items = attentionQueue([order({ order_kind: "custom_request" })], new Date("2026-08-02T00:00:00Z"));
  assert.ok(
    !items.some((item) => item.kind === "unfulfilled"),
    "production work must not be announced as something to pack"
  );
});

// ---------------------------------------------------------------------------
// The handoff
// ---------------------------------------------------------------------------

test("production completion stamps the handoff and tells the fulfillment desk", () => {
  const code = stripComments(productionRoute);
  assert.match(code, /ready_to_fulfill_at: new Date\(\)\.toISOString\(\)/);
  assert.match(code, /kind: "order\.ready_to_fulfill"/);
  // First-write-wins, so a reopened-and-recompleted job does not look newly
  // arrived and jump the queue.
  assert.match(code, /\.is\("ready_to_fulfill_at", null\)/);
});

test("REGRESSION a completed guest order still hands over and still alerts", () => {
  /*
   * Both writes used to sit behind `if (!order?.customer_id) return` — a test
   * of whether the *customer* has an account. Neither the handoff stamp nor the
   * staff alert is about the customer, so a guest order told nobody.
   */
  const code = stripComments(productionRoute);
  const handoffAt = code.indexOf("ready_to_fulfill_at:");
  const accountCheck = code.indexOf("order.customer_id");
  assert.ok(handoffAt > 0, "the handoff stamp must exist");
  assert.ok(
    accountCheck < 0 || handoffAt < accountCheck,
    "the handoff must not sit behind a check for a customer account"
  );
});

test("production completion never marks the order shipped, delivered or complete", () => {
  const code = stripComments(productionRoute);
  for (const forbidden of [/fulfillment_status/, /shipped_at/, /delivered_at/, /picked_up_at/, /status: "completed"/]) {
    assert.doesNotMatch(code, forbidden, `production must not write ${forbidden}`);
  }
});

test("the order reaching ready stamps the handoff without touching fulfillment", () => {
  const code = stripComments(orderRoute);
  assert.match(code, /update\.status === "ready" && existing\.status !== "ready"/);
  assert.match(code, /update\.ready_to_fulfill_at = new Date\(\)\.toISOString\(\)/);
  assert.match(code, /kind: "order\.ready_to_fulfill"/);
  assert.doesNotMatch(code, /update\.fulfillment_status\s*=/, "handing over is not fulfilling");
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test("nothing leaves the shop before it has been made", () => {
  const code = stripComments(fulfillmentRoute);
  assert.match(code, /if \(!productionComplete\(/);
  assert.match(code, /still being made/i);
  // Server-side, before the transition — not merely a disabled button.
  assert.ok(
    code.indexOf("productionComplete({ status: order.status") < code.indexOf("transitionFulfillment({"),
    "the production guard must run before the state moves"
  );
});

test("the release guard covers every handover and deliberately excludes packing", () => {
  const releases = /const RELEASES_GOODS[^=]*=\s*\[([^\]]*)\]/.exec(fulfillmentRoute);
  assert.ok(releases, "RELEASES_GOODS must be declared as a literal list");
  const listed = releases[1];
  for (const state of ["shipped", "ready_for_pickup", "picked_up", "delivered"]) {
    assert.match(listed, new RegExp(`"${state}"`), `${state} releases goods`);
  }
  assert.doesNotMatch(listed, /"processing"/, "packing early is normal and must not be gated");
});

test("a parcel is not posted to nowhere", () => {
  const code = stripComments(fulfillmentRoute);
  assert.match(code, /isDeliverableStoredAddress\(order\.shipping_address\)/);
  assert.match(code, /no complete delivery address/i);
  assert.ok(
    code.indexOf("isDeliverableStoredAddress") < code.indexOf("transitionFulfillment({"),
    "the address guard must run before the state moves"
  );
});

test("the button and the route are blocked by the same facts", () => {
  // `blockedReason` is what disables the control; the POST refusals are the
  // control. Both are computed from production, destination and balance.
  assert.match(fulfillmentRoute, /blockedReason/);
  assert.match(fulfillmentRoute, /readiness:\s*\{/);
  assert.match(fulfillmentRoute, /production: \{ complete: made/);
  assert.match(panel, /readiness\.production\.complete/);
  assert.match(panel, /readiness\.destination\.deliverable/);
  assert.match(panel, /readiness\.contact\.reachable/);
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

test("REGRESSION the shop-floor signal is not buried behind a customer email", () => {
  /*
   * `raiseOperationalAlert` used to sit at the foot of `notifyCustomer`, which
   * returns early when a state has no customer template — and `ready_to_fulfill`
   * is exactly such a state, so the packing bench was never told. The pickup
   * alert did fire, but only while customer fulfillment emails were switched on.
   */
  const code = stripComments(fulfillmentRoute);
  assert.match(code, /async function signalShopFloor/);
  assert.match(code, /await signalShopFloor\(/);

  const signal = code.slice(code.indexOf("async function signalShopFloor"));
  assert.doesNotMatch(
    signal,
    /settings\.email\.categories\.fulfillment|notifyWhenReady/,
    "an internal alert must not inherit a customer's mail preference"
  );
  assert.match(signal, /ready_to_fulfill/);
  assert.match(signal, /ready_for_pickup/);
});

test("the customer path and the staff path are called separately", () => {
  const code = stripComments(fulfillmentRoute);
  const customerCall = code.indexOf("await notifyCustomer(");
  const staffCall = code.indexOf("await signalShopFloor(");
  assert.ok(customerCall > 0 && staffCall > 0);
  assert.ok(staffCall > customerCall, "the staff signal follows the customer message");

  // Neither can return early on behalf of the other.
  const notify = code.slice(code.indexOf("async function notifyCustomer"), code.indexOf("async function signalShopFloor"));
  assert.doesNotMatch(notify, /raiseOperationalAlert/);
});

test("a repeated transition still sends nothing twice", () => {
  const code = stripComments(fulfillmentRoute);
  const alreadyAt = code.indexOf("result.already");
  assert.ok(alreadyAt > 0);
  for (const later of ["notifyCustomer(", "signalShopFloor(", "logLifecycleAudit("]) {
    assert.ok(alreadyAt < code.indexOf(later), `an already-applied transition must not re-run ${later}`);
  }
});

test("both handoff alerts key on the order, so one order rings the bell once", () => {
  // `notificationEventKey(kind, subjectId)` with no discriminator, from both the
  // production route and the order route, is the same key — which is what makes
  // "job completed" and "order marked ready" a single notification.
  for (const source of [productionRoute, orderRoute]) {
    const alert = source.slice(source.indexOf('kind: "order.ready_to_fulfill"'));
    assert.match(alert.slice(0, 400), /subjectId: (String\()?(order\.id|id)/);
    assert.doesNotMatch(alert.slice(0, 400), /discriminator/);
  }
});

// ---------------------------------------------------------------------------
// The customer's view
// ---------------------------------------------------------------------------

test("REGRESSION the customer is not told production finished when payment cleared", () => {
  const stages = customerOrderProgress({
    status: "in_progress",
    payment_status: "paid",
    fulfillment_method: "shipping",
    fulfillment_status: "unfulfilled",
    created_at: "2026-08-01T00:00:00Z",
    amount_paid_cents: 5000,
  });
  const production = stages.find((stage) => stage.label === "In production");
  assert.equal(production?.state, "current", "production is where the order actually is");
  assert.ok(
    stages.filter((stage) => stage.state === "complete").every((stage) => stage.label !== "In production")
  );
});

test("a finished order says how it finished rather than a flat complete", () => {
  assert.equal(orderCustomerStatus("completed", "delivered"), "Delivered");
  assert.equal(orderCustomerStatus("completed", "picked_up"), "Picked up");
  assert.equal(orderCustomerStatus("ready", "ready_for_pickup"), "Ready for pickup");
  assert.equal(orderCustomerStatus("in_progress", "shipped"), "Shipped");
});

test("staff vocabulary does not leak into the customer's status", () => {
  const label = orderCustomerStatus("ready", null);
  assert.doesNotMatch(label, /fulfillment/i, "“Ready for fulfillment” is the shop's word, not the customer's");
});

test("a cancelled order never renders as a completed journey", () => {
  const stages = customerOrderProgress({
    status: "cancelled",
    payment_status: "refunded",
    fulfillment_method: "shipping",
    fulfillment_status: "canceled",
    created_at: "2026-08-01T00:00:00Z",
    amount_paid_cents: 0,
  });
  assert.ok(!stages.some((stage) => ["Shipped", "Delivered", "Ready to ship"].includes(stage.label)));
});

// ---------------------------------------------------------------------------
// The queue page
// ---------------------------------------------------------------------------

test("the queue reads the production signal it gates on", () => {
  assert.match(queuePage, /order_kind/, "the bucket rule needs the order kind");
});

test("the queue can be worked oldest-first, and is by default", () => {
  assert.match(queuePage, /oldest_ready/);
  assert.match(queuePage, /isSort\(sortParam\) \? sortParam : "oldest_ready"/);
});

test("age is measured from the handoff, not from the last edit", () => {
  const code = stripComments(queuePage);
  const since = code.slice(code.indexOf("function readySince"), code.indexOf("const SORTS"));
  assert.match(since, /ready_to_fulfill_at/);
  assert.doesNotMatch(since, /updated_at/, "editing a note must not send an order to the back of the queue");
});

test("sorting never mutates the grouped arrays it reads", () => {
  const code = stripComments(queuePage);
  assert.match(code, /\[\.\.\.filtered\]\.sort\(/);
});

test("the worklist flags a shipment it cannot address, and never prints the address", () => {
  const code = stripComments(queuePage);
  assert.match(code, /function addressProblem/);
  assert.match(code, /No address/);
  // The column is read to answer a yes/no question, never rendered.
  assert.doesNotMatch(code, /formatStoredAddressLines/);
});

test("a guest order in the queue is still attributed to somebody", () => {
  const code = stripComments(queuePage);
  assert.match(code, /order\.guest_name/);
  assert.match(code, /\.filter\(Boolean\)/);
});
