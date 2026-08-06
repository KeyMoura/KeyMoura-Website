import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { FULFILLMENT_STATES } from "../src/lib/commerce/orderLifecycle.ts";
import {
  ACTIVE_FULFILLMENT_BUCKETS,
  FULFILLMENT_BUCKETS,
  FULFILLMENT_BUCKET_COPY,
  attentionQueue,
  fulfillmentBucket,
  fulfillmentNextAction,
  groupByFulfillmentBucket,
  missingTracking,
  outstandingBalanceCents,
  type QueueOrder,
} from "../src/lib/staff/operationsQueues.ts";
import {
  ORDER_DOCUMENTS,
  ORDER_DOCUMENT_META,
  documentsForMethod,
  formatCents,
  invoiceLines,
  isOrderDocument,
} from "../src/lib/staff/orderDocuments.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
/** Source with comments removed, for assertions that a call is absent. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const NOW = new Date("2026-08-05T12:00:00.000Z");

function order(overrides: Partial<QueueOrder> = {}): QueueOrder {
  return {
    id: "o1",
    order_number: "KM-0001",
    customer_id: "c1",
    product_name: "Shift knob",
    status: "in_progress",
    quantity: 1,
    agreed_price_cents: 10_000,
    amount_paid_cents: 10_000,
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
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fulfillment buckets
// ---------------------------------------------------------------------------

test("every fulfillment state lands in a bucket", () => {
  for (const state of FULFILLMENT_STATES) {
    const bucket = fulfillmentBucket(order({ fulfillment_status: state }));
    assert.ok(FULFILLMENT_BUCKETS.includes(bucket), `${state} produced "${bucket}"`);
  }
});

test("an order is in exactly one bucket, so the counts add up", () => {
  const orders = FULFILLMENT_STATES.map((state, index) =>
    order({ id: `o${index}`, fulfillment_status: state })
  );
  const grouped = groupByFulfillmentBucket(orders);
  const total = FULFILLMENT_BUCKETS.reduce((sum, bucket) => sum + grouped[bucket].length, 0);
  assert.equal(total, orders.length);
  const ids = FULFILLMENT_BUCKETS.flatMap((bucket) => grouped[bucket].map((row) => row.id));
  assert.equal(new Set(ids).size, ids.length, "an order appeared in two buckets");
});

test("a paid, unstarted order is work to be picked", () => {
  assert.equal(fulfillmentBucket(order()), "to_prepare");
  assert.equal(fulfillmentBucket(order({ fulfillment_status: "processing" })), "in_progress");
  assert.equal(fulfillmentBucket(order({ fulfillment_status: "ready_to_fulfill" })), "ready");
  assert.equal(fulfillmentBucket(order({ fulfillment_status: "ready_for_pickup" })), "ready");
  assert.equal(fulfillmentBucket(order({ fulfillment_status: "shipped" })), "in_transit");
  assert.equal(fulfillmentBucket(order({ fulfillment_status: "delivered" })), "settled");
  assert.equal(fulfillmentBucket(order({ fulfillment_status: "picked_up" })), "settled");
});

test("an unpaid order is chasing an invoice, not work on the bench", () => {
  assert.equal(fulfillmentBucket(order({ amount_paid_cents: 0 })), "awaiting_payment");
  assert.equal(fulfillmentBucket(order({ amount_paid_cents: 4_000 })), "awaiting_payment");
});

test("a shipped order that was later partly refunded does not return to the bench", () => {
  // Payment is tested after the departed states on purpose: the goods have
  // already gone, so an outstanding balance is a debt, not packing work.
  const partlyRefunded = order({ fulfillment_status: "shipped", amount_refunded_cents: 5_000 });
  assert.equal(outstandingBalanceCents(partlyRefunded), 5_000);
  assert.equal(fulfillmentBucket(partlyRefunded), "in_transit");
});

test("a cancelled order needs no delivery", () => {
  assert.equal(fulfillmentBucket(order({ fulfillment_status: "canceled" })), "not_applicable");
  assert.equal(fulfillmentBucket(order({ fulfillment_status: "not_required" })), "not_applicable");
  assert.equal(fulfillmentBucket(order({ status: "cancelled" })), "not_applicable");
});

test("a cancelled order that had already shipped keeps its real delivery state", () => {
  // Otherwise a parcel in the post disappears from the queue that would have
  // confirmed it arrived.
  assert.equal(fulfillmentBucket(order({ status: "cancelled", fulfillment_status: "shipped" })), "in_transit");
});

test("every active bucket has copy, and settled ones are not offered as queues", () => {
  for (const bucket of FULFILLMENT_BUCKETS) {
    assert.ok(FULFILLMENT_BUCKET_COPY[bucket].label);
    assert.ok(FULFILLMENT_BUCKET_COPY[bucket].description.length > 20);
  }
  assert.ok(!ACTIVE_FULFILLMENT_BUCKETS.includes("settled"));
  assert.ok(!ACTIVE_FULFILLMENT_BUCKETS.includes("not_applicable"));
});

test("missing tracking is only ever reported for a shipped shipping order", () => {
  assert.equal(missingTracking(order({ fulfillment_status: "shipped" })), true);
  assert.equal(missingTracking(order({ fulfillment_status: "shipped", tracking_number: "1Z" })), false);
  assert.equal(missingTracking(order({ fulfillment_status: "shipped", tracking_number: "   " })), true);
  assert.equal(
    missingTracking(order({ fulfillment_status: "picked_up", fulfillment_method: "pickup" })),
    false
  );
  assert.equal(missingTracking(order({ fulfillment_status: "processing" })), false);
});

test("the next action differs by delivery method", () => {
  assert.match(fulfillmentNextAction(order({ fulfillment_status: "processing" })), /Pack and ship/);
  assert.match(
    fulfillmentNextAction(order({ fulfillment_status: "processing", fulfillment_method: "pickup" })),
    /ready for collection/
  );
});

// ---------------------------------------------------------------------------
// Attention queue
// ---------------------------------------------------------------------------

test("an open cancellation outranks packing work", () => {
  const items = attentionQueue(
    [order({ id: "a", cancellation_status: "requested" }), order({ id: "b" })],
    NOW
  );
  assert.equal(items[0].kind, "cancellation");
});

test("one order can raise more than one piece of work", () => {
  const items = attentionQueue([order({ return_status: "received", target_date: "2026-07-01" })], NOW);
  const kinds = items.map((item) => item.kind);
  assert.ok(kinds.includes("return"));
  assert.ok(kinds.includes("overdue"));
});

test("a closed order still surfaces an open return", () => {
  // A cancelled order with a return in flight is real work; skipping closed
  // orders wholesale is how that return gets forgotten.
  const items = attentionQueue([order({ status: "cancelled", return_status: "requested" })], NOW);
  assert.deepEqual(
    items.map((item) => item.kind),
    ["return"]
  );
});

test("a completed, delivered order raises nothing", () => {
  const items = attentionQueue(
    [order({ status: "completed", fulfillment_status: "delivered", target_date: null })],
    NOW
  );
  assert.deepEqual(items, []);
});

test("shipped without tracking is reported once, not twice", () => {
  const items = attentionQueue([order({ fulfillment_status: "shipped" })], NOW);
  assert.deepEqual(
    items.map((item) => item.kind),
    ["tracking"]
  );
});

test("every attention item points at a real order and says what to do", () => {
  const items = attentionQueue(
    [order({ cancellation_status: "requested", amount_paid_cents: 0, target_date: "2026-01-01" })],
    NOW
  );
  assert.ok(items.length > 0);
  for (const item of items) {
    assert.equal(item.orderId, "o1");
    assert.ok(item.title.length > 5);
    assert.ok(item.detail.length > 5);
  }
});

// ---------------------------------------------------------------------------
// Printable documents
// ---------------------------------------------------------------------------

test("only the four known documents are accepted", () => {
  for (const slug of ORDER_DOCUMENTS) assert.ok(isOrderDocument(slug));
  assert.equal(isOrderDocument("../../secrets"), false);
  assert.equal(isOrderDocument("packing_slip"), false);
  assert.equal(isOrderDocument(""), false);
});

test("delivery documents are offered only for the method they suit", () => {
  const shipping = documentsForMethod("shipping").map((meta) => meta.slug);
  assert.ok(shipping.includes("packing-slip"));
  assert.ok(!shipping.includes("pickup-slip"));

  const pickup = documentsForMethod("pickup").map((meta) => meta.slug);
  assert.ok(pickup.includes("pickup-slip"));
  assert.ok(!pickup.includes("packing-slip"));

  // An unrecognised method falls back to shipping, matching the transition
  // graph's own fallback rather than offering nothing.
  assert.deepEqual(documentsForMethod("nonsense").map((m) => m.slug), shipping);
});

test("the refund record is the only internal sheet", () => {
  const internal = ORDER_DOCUMENTS.filter((slug) => !ORDER_DOCUMENT_META[slug].reachesCustomer);
  assert.deepEqual(internal, ["refund-record"]);
});

test("only the internal sheet carries the internal stamp and internal notes", () => {
  const page = read("src/app/staff/orders/[id]/print/[doc]/page.tsx");
  // The stamp is rendered from the flag, not decided per template.
  assert.match(page, /!meta\.reachesCustomer \? <InternalStamp \/>/);
  // Internal notes appear only inside the refund-record branch.
  const refundBranch = page.slice(page.indexOf('doc === "refund-record"'));
  assert.match(refundBranch, /staff_notes/);
  const beforeRefund = page.slice(0, page.indexOf('doc === "refund-record"'));
  assert.ok(!beforeRefund.includes("order.staff_notes"), "a customer-facing sheet renders internal staff notes");
});

test("prices never print on a sheet that travels with the goods", () => {
  const page = read("src/app/staff/orders/[id]/print/[doc]/page.tsx");
  for (const marker of ["{/* Packing slip", "{/* Pickup slip"]) {
    const start = page.indexOf(marker);
    assert.ok(start > 0, `${marker} section not found`);
    const section = page.slice(start, start + 2500);
    assert.match(section, /showPrices=\{false\}/);
  }
  assert.match(page.slice(page.indexOf("{/* Invoice")), /<ItemTable lines=\{lines\} showPrices \/>/);
});

test("the invoice never recomputes the total the customer was charged", () => {
  const lines = invoiceLines({
    subtotal_cents: 9_000,
    discount_cents: 1_000,
    shipping_cents: 500,
    tax_cents: 0,
    // Deliberately inconsistent with the components: the agreed price is what
    // was actually charged, and the printed total must be that.
    agreed_price_cents: 12_345,
    amount_paid_cents: 0,
    amount_refunded_cents: 0,
  });
  const total = lines.find((line) => line.label === "Order total");
  assert.equal(total?.cents, 12_345);
});

test("a quoted custom order prints one line rather than an invented breakdown", () => {
  const lines = invoiceLines({
    subtotal_cents: null,
    discount_cents: null,
    shipping_cents: null,
    tax_cents: null,
    agreed_price_cents: 25_000,
    amount_paid_cents: 25_000,
    amount_refunded_cents: 0,
  });
  assert.deepEqual(
    lines.map((line) => line.label),
    ["Order total", "Paid", "Balance"]
  );
  assert.equal(lines[lines.length - 1].cents, 0);
});

test("the invoice shows a balance that accounts for refunds", () => {
  const lines = invoiceLines({
    subtotal_cents: 10_000,
    discount_cents: 0,
    shipping_cents: 0,
    tax_cents: 0,
    agreed_price_cents: 10_000,
    amount_paid_cents: 10_000,
    amount_refunded_cents: 4_000,
  });
  assert.equal(lines.find((line) => line.label === "Refunded to customer")?.cents, 4_000);
  assert.equal(lines.find((line) => line.label === "Balance due")?.cents, 4_000);
});

test("money is formatted with a real minus sign and two decimals", () => {
  assert.equal(formatCents(0), "$0.00");
  assert.equal(formatCents(12_345), "$123.45");
  assert.equal(formatCents(-500), "−$5.00");
});

test("the printable documents are staff-gated and never leak on refusal", () => {
  const page = read("src/app/staff/orders/[id]/print/[doc]/page.tsx");
  assert.match(page, /getServerActorAccess/);
  assert.match(page, /fulfillment\.view/);
  assert.match(page, /orders\.view/);
  // The refusal returns before any order is loaded.
  const refusal = page.indexOf("<AccessDenied");
  const load = page.indexOf('.from("orders")');
  assert.ok(refusal > 0 && load > refusal, "the order is loaded before the permission is checked");
});

test("the fulfillment panel offers exactly the documents the route accepts", () => {
  const panel = read("src/components/staff/OrderFulfillmentPanel.tsx");
  assert.match(panel, /documentsForMethod\(order\.fulfillmentMethod\)/);
  assert.doesNotMatch(panel, /print\/packing-slip/);
});

// ---------------------------------------------------------------------------
// The fulfillment API and the panel that drives it
// ---------------------------------------------------------------------------

const fulfillmentRoute = read("src/app/api/staff/orders/[id]/fulfillment/route.ts");

test("the staff order page drives the fulfillment state machine, not the legacy action", () => {
  const page = read("src/app/staff/orders/[id]/page.tsx");
  assert.match(page, /<OrderFulfillmentPanel/);
  // Comments stripped: the page explains what it replaced, and an assertion
  // that a call is gone must read the code, not the prose about it.
  const code = stripComments(page);
  // `shipment_action` set shipped_at and moved orders.status but never wrote
  // fulfillment_status, so every rule that reads that column saw "unfulfilled".
  assert.doesNotMatch(code, /shipment_action/);
});

test("the panel sends the state it rendered from, so a stale page is refused", () => {
  const panel = read("src/components/staff/OrderFulfillmentPanel.tsx");
  assert.match(panel, /expectedStatus: order\.fulfillmentStatus/);
  assert.match(fulfillmentRoute, /expected && expected !== current/);
  assert.match(fulfillmentRoute, /status: 409/);
});

test("goods do not leave against an unpaid balance", () => {
  assert.match(fulfillmentRoute, /RELEASES_GOODS: readonly FulfillmentState\[\] = \["shipped", "ready_for_pickup", "picked_up", "delivered"\]/);
  assert.match(fulfillmentRoute, /if \(RELEASES_GOODS\.includes\(to\)\) \{[\s\S]{0,400}status: 409/);
  // Packing early is normal; only the handover is guarded.
  assert.doesNotMatch(fulfillmentRoute, /RELEASES_GOODS[^\n]*"processing"/);
});

test("reaching the customer's hands completes a ready order", () => {
  // `transition_order_fulfillment` writes only fulfillment_status. Without
  // this, a delivered order still reads "Ready" to its customer forever.
  assert.match(fulfillmentRoute, /COMPLETES_ORDER: readonly FulfillmentState\[\] = \["delivered", "picked_up"\]/);
  assert.match(fulfillmentRoute, /status: "completed", completed_at: stamp/);
  // Conditional on both sides, so a concurrent change matches zero rows.
  assert.match(fulfillmentRoute, /\.eq\("status", "ready"\)/);
});

test("the transition list tells the page why a button is unavailable", () => {
  assert.match(fulfillmentRoute, /blockedReason/);
  const panel = read("src/components/staff/OrderFulfillmentPanel.tsx");
  assert.match(panel, /option\.blockedReason/);
  // The server decides; the disabled button is a courtesy.
  assert.match(panel, /disabled=\{disabled\}/);
});

test("the panel previews the exact email each step sends", () => {
  const panel = read("src/components/staff/OrderFulfillmentPanel.tsx");
  assert.match(panel, /EMAIL_SUMMARY/);
  assert.match(panel, /option\.emailTemplate/);
  assert.match(fulfillmentRoute, /emailTemplate: FULFILLMENT_CUSTOMER_EMAIL\[to\]/);
});

test("the customer's delivery section reads the state field, not timestamps", () => {
  const component = read("src/components/commerce/OrderFulfillmentStatus.tsx");
  assert.match(component, /order\.fulfillment_status/);
  assert.match(component, /FULFILLMENT_LABELS/);
  const page = read("src/app/orders/[id]/page.tsx");
  assert.match(page, /<OrderFulfillmentStatus order=\{order\} \/>/);
});

test("the customer never sees an internal fulfillment note", () => {
  const component = read("src/components/commerce/OrderFulfillmentStatus.tsx");
  assert.match(component, /customer_shipment_note/);
  assert.doesNotMatch(component, /fulfillment_notes/);
  // And the route only ever routes the customer-facing one into an email.
  assert.match(fulfillmentRoute, /detail: input\.customerNote \|\| ""/);
});

// ---------------------------------------------------------------------------
// The dashboard never presents a failure as a zero
// ---------------------------------------------------------------------------

const dashboard = read("src/app/staff/page.tsx");

test("a refused query is not turned into an empty result set", () => {
  // Keeping `data ?? []` on a refused query is how "0 open, 0 overdue" ends up
  // beside an error banner — the pass-5a mistake, in a new place.
  assert.match(dashboard, /orderResult\.error \? \[\] : \(orderResult\.data \?\? \[\]\)/);
  assert.match(dashboard, /productResult\.error \? \[\] : \(productResult\.data \?\? \[\]\)/);
});

test("failures are tracked per source, not as one banner over healthy-looking panels", () => {
  assert.match(dashboard, /const \[ordersError, setOrdersError\] = useState\(""\)/);
  assert.match(dashboard, /const \[productsError, setProductsError\] = useState\(""\)/);
  assert.match(dashboard, /const ordersUsable = canViewOrders && !ordersError/);
});

test("no derived figure is computed from a failed load", () => {
  // `buildDashboardSummary([])` happily reports $0 and zero overdue, which is a
  // confident wrong answer rather than a missing one.
  assert.match(dashboard, /now && ordersUsable\s*\n?\s*\? buildDashboardSummary/);
  assert.match(dashboard, /attentionQueue\(orders, now\) : \[\]\), \[now, orders, ordersUsable\]/);
});

test("every panel that depends on orders shows the failure rather than a count", () => {
  // The attention list, the fulfillment cards and the revenue panel each refuse
  // to render a number when the orders query failed.
  assert.match(dashboard, /\{ordersError \? \(\s*<Notice tone="danger" className="mt-5">\s*Open work could not be loaded/);
  assert.match(dashboard, /\{ordersError \? \(\s*<Notice tone="danger" className="mt-4">\s*The fulfillment queues could not be counted/);
  assert.match(dashboard, /\{canViewOrders && ordersError \? \(/);
  // The count badge disappears rather than reading 0.
  assert.match(dashboard, /\{ordersUsable \? \(\s*<Badge tone=\{attention\.length \? "warning" : "neutral"\}>/);
});

test("the fulfillment queue makes no claim about the shop when its load failed", () => {
  const queue = read("src/app/staff/fulfillment/page.tsx");
  assert.match(queue, /result\.error \? \[\] : \(result\.data \?\? \[\]\)/);
  // Bucket counts, the summary line and the reassuring empty state are all
  // withheld, not rendered as zero.
  assert.match(queue, /\{!error \? \(\s*<section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"/);
  assert.match(queue, /\{!error \? \(\s*<p className="text-xs text-brand-textMuted" aria-live="polite">/);
  assert.match(queue, /!loading && !error && shown\.length === 0/);
});

test("stock does not report itself healthy when it could not be read", () => {
  assert.match(dashboard, /\{productsError \? \(\s*<Notice tone="danger" className="mt-5">\s*Stock could not be read/);
  // The cheerful empty state is now the *else* branch, not the default.
  assert.match(dashboard, /\) : !loading && !lowStock\.length \? \(\s*<EmptyState className="mt-5">Stock levels look healthy/);
});

// ---------------------------------------------------------------------------
// Product delivery fields
// ---------------------------------------------------------------------------

test("the product editor exposes every delivery column that checkout reads", () => {
  const editor = read("src/components/staff/ProductShippingEditor.tsx");
  for (const column of [
    "requires_shipping",
    "pickup_eligible",
    "fulfillment_required",
    "is_returnable",
    "package_weight_grams",
    "package_length_mm",
    "package_width_mm",
    "package_height_mm",
  ]) {
    assert.match(editor, new RegExp(column), `${column} has no control`);
  }
  const checkout = read("src/lib/commerce/checkoutFulfillment.ts");
  assert.match(checkout, /requires_shipping/);
});

test("saving a product cannot silently flip its delivery flags off", () => {
  // `Boolean(undefined)` is false. A product whose row was loaded before these
  // columns existed would have been marked unshippable by the first save of an
  // unrelated field.
  const page = read("src/app/staff/catalog/page.tsx");
  for (const column of ["requires_shipping", "pickup_eligible", "fulfillment_required", "is_returnable"]) {
    assert.match(page, new RegExp(`${column}: draft\\.${column} \\?\\? true`), `${column} is not defaulted to true`);
  }
});

test("a blank measurement is stored as unset rather than zero", () => {
  // A 0-gram package would be priced as weightless instead of falling back to
  // the configured default.
  const editor = read("src/components/staff/ProductShippingEditor.tsx");
  assert.match(editor, /if \(!trimmed\) return null/);
  const page = read("src/app/staff/catalog/page.tsx");
  assert.match(page, /package_weight_grams: draft\.package_weight_grams \?\? null/);
});

test("the editor warns when a product can be bought but never delivered", () => {
  const editor = read("src/components/staff/ProductShippingEditor.tsx");
  assert.match(editor, /fulfillmentRequired && !requiresShipping && !pickupEligible/);
  assert.match(editor, /cannot be delivered right now/);
});

test("a duplicated product keeps its delivery configuration", () => {
  const page = read("src/app/staff/catalog/page.tsx");
  const duplicate = page.slice(page.indexOf("async function duplicateProduct"));
  for (const column of ["requires_shipping", "pickup_eligible", "package_weight_grams", "is_returnable"]) {
    assert.match(duplicate, new RegExp(column), `duplicate drops ${column}`);
  }
});
