import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { OrderHistoryCard } from "../src/components/commerce/OrderHistoryCard.tsx";
import {
  filterOrderHistoryTab,
  orderHistoryActions,
  orderHistoryBalanceCents,
  orderHistoryCanAskForHelp,
  orderHistoryDate,
  orderHistoryFulfillment,
  orderHistoryItems,
  orderHistoryOptionSummary,
  orderHistoryRepurchaseSlug,
  orderHistoryStatus,
  orderHistoryStatusDate,
  orderHistoryTabOf,
  ORDER_HISTORY_SORTS,
  searchOrderHistory,
  sortOrderHistory,
  type OrderHistoryOrder,
} from "../src/lib/commerce/orderHistory.ts";

/**
 * The customer's order history.
 *
 * Everything here is keyed on the *structural* condition, never on an order id.
 * The rules that matter are about what a card is permitted to say — a date only
 * from a column named after the event, a status only from the shared customer
 * projection, an action only from state the order itself carries — because the
 * failure mode of this page is not a broken layout, it is a confident sentence
 * about somebody's money that is not true.
 */

const read = (path: string) => readFileSync(path, "utf8");
const page = read("src/app/account/orders/page.tsx");
const card = read("src/components/commerce/OrderHistoryCard.tsx");
const globalsCss = read("src/app/globals.css");

/**
 * The page's select list, isolated from its prose.
 *
 * Searching the whole file for "production" finds the paragraph explaining why
 * production data is not selected, which is the opposite of a leak. What must
 * be checked is the column list itself.
 */
const selectedColumns = page.slice(page.indexOf("const ORDER_COLUMNS ="), page.indexOf("type ViewState"));

const base: OrderHistoryOrder = {
  id: "00000000-0000-0000-0000-000000000001",
  order_number: "KM-0012",
  product_name: "Billet Shift Knob",
  quantity: 1,
  status: "ready",
  payment_status: "paid",
  fulfillment_method: "shipping",
  fulfillment_status: "shipped",
  cancellation_status: "none",
  return_status: "none",
  agreed_price_cents: 6100,
  amount_paid_cents: 6100,
  amount_refunded_cents: 0,
  tracking_url: null,
  tracking_number: null,
  shipping_carrier: null,
  shipping_address: { name: "Ethan Moura" },
  pickup_location_snapshot: null,
  created_at: "2026-08-11T15:00:00.000Z",
  ready_at: null,
  shipped_at: "2026-08-12T17:30:00.000Z",
  delivered_at: null,
  picked_up_at: null,
  order_items: [
    {
      id: "i1",
      product_id: "p1",
      product_name: "Billet Shift Knob",
      product_slug: "billet-shift-knob",
      quantity: 1,
      unit_price_cents: 6100,
      line_subtotal_cents: 6100,
      selected_options: { color: "Blue", size: "Large" },
    },
  ],
};

const order = (patch: Partial<OrderHistoryOrder>): OrderHistoryOrder => ({ ...base, ...patch });
const keys = (o: OrderHistoryOrder) => orderHistoryActions(o).map((action) => action.key);

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

test("status comes from the shared customer projection", () => {
  assert.equal(orderHistoryStatus(order({})).label, "Shipped");
  assert.equal(orderHistoryStatus(order({ status: "in_progress", fulfillment_status: "processing" })).label, "In production");
  assert.equal(
    orderHistoryStatus(order({ status: "ready", fulfillment_method: "pickup", fulfillment_status: "ready_for_pickup" })).label,
    "Ready for pickup"
  );
  assert.equal(
    orderHistoryStatus(order({ status: "awaiting_payment", payment_status: "unpaid", fulfillment_status: "unfulfilled" })).label,
    "Payment needed"
  );
});

test("fulfillment outranks the commercial status, both ways round", () => {
  // An order still marked `awaiting_payment` that has physically shipped is
  // shipped, and saying "Payment needed" over the top of a parcel in transit is
  // how a customer pays twice. The shared projection already reads fulfillment
  // first; this pins that it keeps doing so.
  assert.equal(
    orderHistoryStatus(order({ status: "awaiting_payment", payment_status: "unpaid", fulfillment_status: "shipped" })).label,
    "Shipped"
  );
});

test("no internal workflow vocabulary reaches the customer", () => {
  // Production statuses, staff queue states and lifecycle enum values must not
  // appear as a card's headline just because a new one was added upstream.
  const forbidden = [
    "qc",
    "production_active",
    "awaiting_production",
    "ready_to_fulfill",
    "unfulfilled",
    "needs_information",
    "customer_review",
    "final_review",
  ];
  for (const status of ["qc", "production_active", "awaiting_production", "needs_information", "customer_review", "final_review"]) {
    const label = orderHistoryStatus(order({ status, fulfillment_status: "unfulfilled" })).label;
    assert.ok(!forbidden.includes(label), `${status} leaked as "${label}"`);
    assert.ok(!label.includes("_"), `${status} leaked a raw enum: "${label}"`);
  }
});

test("where the parcel got to outranks where the paperwork got to", () => {
  // An order that is both `completed` and `delivered` is described as
  // "Complete" by the shared projection, which is true and is not what the
  // customer wants to read.
  const delivered = order({ status: "completed", fulfillment_status: "delivered", delivered_at: "2026-07-06T14:00:00.000Z" });
  assert.equal(orderHistoryStatus(delivered).label, "Delivered");
  assert.equal(orderHistoryStatus(delivered).tone, "complete");
  const collected = order({ status: "completed", fulfillment_method: "pickup", fulfillment_status: "picked_up" });
  assert.equal(orderHistoryStatus(collected).label, "Picked up");
});

test("cancellation and return work outrank the ordinary flow", () => {
  assert.equal(orderHistoryStatus(order({ cancellation_status: "requested" })).label, "Cancellation requested");
  assert.equal(orderHistoryStatus(order({ cancellation_status: "requested" })).tone, "attention");
  assert.equal(orderHistoryStatus(order({ return_status: "in_transit" })).label, "Return in progress");
  assert.equal(orderHistoryStatus(order({ status: "cancelled" })).label, "Cancelled");
  assert.equal(orderHistoryStatus(order({ status: "cancelled" })).tone, "stopped");
});

test("refund states are stated, without a reason or an internal id", () => {
  assert.equal(orderHistoryStatus(order({ payment_status: "refunded" })).label, "Refunded");
  assert.equal(orderHistoryStatus(order({ payment_status: "partially_refunded" })).label, "Partly refunded");
  const markup = renderToStaticMarkup(
    createElement(OrderHistoryCard, {
      order: order({ status: "cancelled", payment_status: "refunded", amount_refunded_cents: 6100 }),
    })
  );
  // The amount is customer-visible; why it was given back, and which Stripe
  // object carries it, are not.
  assert.match(markup, /Refunded/);
  assert.match(markup, /\$61\.00/);
  for (const field of ["reason_code", "cancellation_reason", "decision_note", "refund_id", "payment_intent"]) {
    assert.ok(!card.includes(field), `${field} is staff information`);
  }
  assert.ok(!selectedColumns.includes("reason"), "no reason column is even read");
});

test("there are four tones, and every one is stated in words too", () => {
  const tones = new Set(
    [
      order({}),
      order({ status: "awaiting_payment", payment_status: "unpaid", fulfillment_status: "unfulfilled" }),
      order({ status: "completed", fulfillment_status: "delivered" }),
      order({ status: "cancelled" }),
    ].map((o) => orderHistoryStatus(o).tone)
  );
  assert.deepEqual([...tones].sort(), ["attention", "complete", "progress", "stopped"]);
  // The dot is decorative; the label carries the meaning.
  assert.match(card, /<span className="order-card-status-dot" aria-hidden="true" \/>/);
  assert.match(card, /className="order-card-status-label">\{status\.label\}/);
  for (const tone of ["progress", "attention", "complete", "stopped"]) {
    assert.match(globalsCss, new RegExp(`\\.order-card\\[data-tone="${tone}"\\] \\{ --order-tone:`));
  }
});

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

test("a status date comes only from a column named after that event", () => {
  assert.equal(orderHistoryStatusDate(order({ delivered_at: "2026-07-06T00:00:00Z" })), "2026-07-06T00:00:00Z");
  assert.equal(orderHistoryStatusDate(order({})), "2026-08-12T17:30:00.000Z");
  // Nothing to say is said as nothing. `updated_at` is not a delivery date and
  // is not even selected by the page.
  assert.equal(
    orderHistoryStatusDate(order({ shipped_at: null, delivered_at: null, picked_up_at: null, ready_at: null })),
    null
  );
  assert.ok(!page.includes("updated_at"), "updated_at must not be read at all");
  assert.ok(!card.includes("updated_at"));
});

test("dates are formatted in one place", () => {
  assert.equal(orderHistoryDate("2026-08-11T15:00:00.000Z"), "Aug 11, 2026");
  assert.equal(orderHistoryDate("not a date"), "");
});

// ---------------------------------------------------------------------------
// The header strip
// ---------------------------------------------------------------------------

test("shipping shows a recipient, pickup shows a location, neither shows an address", () => {
  assert.deepEqual(orderHistoryFulfillment(order({})), { label: "Ship to", value: "Ethan" });
  assert.deepEqual(
    orderHistoryFulfillment(order({ fulfillment_method: "pickup", pickup_location_snapshot: { name: "KeyMoura workshop" } })),
    { label: "Pickup", value: "KeyMoura workshop" }
  );
  // A missing address is a dash, not a crash and not a guess.
  assert.deepEqual(orderHistoryFulfillment(order({ shipping_address: null })), { label: "Ship to", value: null });
  // The street never appears: a history page is read in public, and the full
  // address is one click away where it is actually needed.
  const markup = renderToStaticMarkup(
    createElement(OrderHistoryCard, {
      order: order({ shipping_address: { name: "Ethan Moura", line1: "1 Example Way", city: "Austin", postalCode: "78701" } }),
    })
  );
  assert.ok(!markup.includes("Example Way"));
  assert.ok(!markup.includes("78701"));
  assert.ok(!markup.includes("Austin"));
});

test("the order's UUID never appears as text", () => {
  const markup = renderToStaticMarkup(createElement(OrderHistoryCard, { order: order({}) }));
  const visible = markup.replace(/href="[^"]*"|aria-labelledby="[^"]*"|id="[^"]*"/g, "");
  assert.ok(!visible.includes(base.id), "the UUID addresses the route; it is not an order number");
  assert.ok(markup.includes("KM-0012"));
});

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

test("both order shapes render, including the one with no line items", () => {
  assert.equal(orderHistoryItems(order({})).length, 1);
  // A custom request predates `order_items` and carries its product on the
  // order itself. It is real history and is not being migrated.
  const legacy = orderHistoryItems(order({ order_items: [], product_name: "Custom Bracket", quantity: 2 }));
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].product_name, "Custom Bracket");
  assert.equal(legacy[0].quantity, 2);
  assert.equal(orderHistoryItems(order({ order_items: null })).length, 1);
});

test("a multi-item order stays one card", () => {
  const multi = order({
    order_items: [
      { id: "a", product_id: "p1", product_name: "Knob", product_slug: "knob", quantity: 1, unit_price_cents: 100, line_subtotal_cents: 100, selected_options: null },
      { id: "b", product_id: "p2", product_name: "Spacer", product_slug: "spacer", quantity: 3, unit_price_cents: 200, line_subtotal_cents: 600, selected_options: null },
      { id: "c", product_id: "p3", product_name: "Insert", product_slug: null, quantity: 1, unit_price_cents: 300, line_subtotal_cents: 300, selected_options: null },
      { id: "d", product_id: null, product_name: "Anodising", product_slug: null, quantity: 1, unit_price_cents: 400, line_subtotal_cents: 400, selected_options: null },
    ],
  });
  const markup = renderToStaticMarkup(createElement(OrderHistoryCard, { order: multi }));
  assert.equal((markup.match(/class="order-card"/g) ?? []).length, 1, "one order is one card");
  assert.equal((markup.match(/order-card-header/g) ?? []).length, 1, "one header");
  assert.equal((markup.match(/order-card-status"/g) ?? []).length, 1, "one status");
  assert.equal((markup.match(/class="order-card-item"/g) ?? []).length, 3, "three shown");
  assert.match(markup, /1 more item in this order/);
});

test("customization is a short line, from the immutable snapshot", () => {
  assert.equal(orderHistoryOptionSummary({ color: "Blue", size: "Large" }), "Blue · Large");
  // Capped, so a ten-option configuration does not become the card.
  assert.equal(orderHistoryOptionSummary({ a: "1", b: "2", c: "3", d: "4" }), "1 · 2 · 3");
  assert.equal(orderHistoryOptionSummary(null), "");
  assert.equal(orderHistoryOptionSummary({ empty: "", n: 5 }), "5");
  // The name and price rendered are the line item's, never a live product's.
  assert.match(card, /\{item\.product_name\}/);
  assert.match(card, /moneyFromCents\(item\.line_subtotal_cents\)/);
});

test("the thumbnail is decorative, because it is not a historical record", () => {
  // There is no image snapshot, so the picture is the product as listed today.
  // An `alt` naming the item would assert this is a photograph of the thing
  // that was actually shipped, and nothing here knows that.
  assert.match(card, /alt=""/);
  assert.ok(!/alt=\{item\.product_name\}/.test(card));
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

test("View order is always there, and is the primary only when nothing else is", () => {
  assert.ok(keys(order({})).includes("view"));
  const quiet = orderHistoryActions(order({ status: "in_progress", fulfillment_status: "processing" }));
  assert.equal(quiet.find((a) => a.key === "view")?.role, "primary");
  assert.equal(quiet.find((a) => a.key === "view")?.href, `/orders/${base.id}`);
  const paying = orderHistoryActions(order({ status: "awaiting_payment", payment_status: "unpaid", amount_paid_cents: 0 }));
  assert.equal(paying.find((a) => a.key === "view")?.role, "secondary");
});

test("at most one primary action per card", () => {
  const cases = [
    order({}),
    order({ tracking_url: "https://example.com/t" }),
    order({ status: "awaiting_payment", payment_status: "unpaid", amount_paid_cents: 0, tracking_url: "https://example.com/t" }),
    order({ status: "customer_review" }),
    order({ status: "final_review" }),
    order({ fulfillment_method: "pickup", fulfillment_status: "ready_for_pickup" }),
    order({ status: "completed", fulfillment_status: "delivered" }),
    order({ status: "cancelled", payment_status: "refunded" }),
  ];
  for (const candidate of cases) {
    const primaries = orderHistoryActions(candidate).filter((a) => a.role === "primary");
    assert.equal(primaries.length, 1, `${candidate.status}/${candidate.fulfillment_status}`);
  }
});

test("tracking is offered only when a real URL was stored", () => {
  assert.ok(!keys(order({})).includes("track"));
  // A carrier and a number are not a link. Guessing the carrier's URL format is
  // how a customer lands on somebody else's 404.
  assert.ok(!keys(order({ tracking_number: "1Z999", shipping_carrier: "UPS" })).includes("track"));
  const tracked = orderHistoryActions(order({ tracking_url: "https://example.com/t" }));
  const track = tracked.find((a) => a.key === "track");
  assert.equal(track?.href, "https://example.com/t");
  assert.equal(track?.external, true);
  // An external destination opens safely.
  assert.match(card, /target="_blank"/);
  assert.match(card, /rel="noopener noreferrer"/);
});

test("pickup orders get collection details and no shipping controls", () => {
  const pickup = order({
    fulfillment_method: "pickup",
    fulfillment_status: "ready_for_pickup",
    pickup_location_snapshot: { name: "KeyMoura workshop" },
    tracking_url: null,
  });
  assert.ok(keys(pickup).includes("pickup"));
  assert.ok(!keys(pickup).includes("track"));
  assert.equal(orderHistoryActions(pickup).find((a) => a.key === "pickup")?.href, `/orders/${base.id}#fulfillment`);
  // And that anchor exists on the order page.
  assert.match(read("src/components/commerce/OrderFulfillmentStatus.tsx"), /id="fulfillment"/);
});

test("Pay now appears exactly when a balance remains", () => {
  assert.ok(keys(order({ status: "awaiting_payment", payment_status: "unpaid", amount_paid_cents: 0 })).includes("pay"));
  assert.ok(!keys(order({})).includes("pay"), "a paid order must never ask for money again");
  // The trap `orderHub` documents: a settled order that was partly refunded.
  assert.equal(orderHistoryBalanceCents(order({ payment_status: "partially_refunded", amount_refunded_cents: 1000 })), 0);
  assert.equal(orderHistoryBalanceCents(order({ payment_status: "refunded" })), 0);
  assert.equal(orderHistoryBalanceCents(order({ payment_status: "not_required" })), 0);
  // A quote with no price yet owes nothing.
  assert.equal(orderHistoryBalanceCents(order({ agreed_price_cents: null, payment_status: "unpaid" })), 0);
  // A deposit leaves the remainder.
  assert.equal(
    orderHistoryBalanceCents(order({ status: "accepted", payment_status: "partial", amount_paid_cents: 2000 })),
    4100
  );
  // A cancelled order is not chased for money.
  assert.equal(orderHistoryBalanceCents(order({ status: "cancelled", payment_status: "unpaid", amount_paid_cents: 0 })), 0);
});

test("a cancelled order offers nothing but the order and help", () => {
  const dead = order({ status: "cancelled", payment_status: "refunded", tracking_url: "https://example.com/t" });
  assert.deepEqual(keys(dead), ["view", "support"]);
});

test("returns are never offered from the card", () => {
  // Eligibility is a server decision made against fresh rows by
  // `evaluateReturn`; inferring it here from a date and a status is exactly the
  // thing that must not happen. The card links to the page that computes it.
  const delivered = order({ status: "completed", fulfillment_status: "delivered", delivered_at: "2026-07-06T00:00:00Z" });
  assert.ok(!keys(delivered).includes("return"));
  const source = read("src/lib/commerce/orderHistory.ts");
  assert.ok(!source.includes("evaluateReturn"), "eligibility must not be reimplemented here");
  assert.ok(!source.includes("windowDays"));
  assert.ok(!card.includes("Request return") && !card.includes("Start a return"));
});

test("help is offered where a customer might have a problem, and carries the order", () => {
  assert.ok(orderHistoryCanAskForHelp(order({ status: "completed", fulfillment_status: "delivered" })));
  assert.ok(orderHistoryCanAskForHelp(order({ status: "cancelled" })));
  // Mid-production, the order's own chat keeps the conversation attached to the
  // order rather than opening a second thread about it.
  assert.ok(!orderHistoryCanAskForHelp(order({ status: "in_progress", fulfillment_status: "processing" })));
  const support = orderHistoryActions(order({ status: "completed", fulfillment_status: "delivered" })).find(
    (a) => a.key === "support"
  );
  assert.equal(support?.href, `/support?order=${base.id}`);
  assert.equal(support?.role, "quiet");
  // The support page reads that parameter.
  assert.match(read("src/app/support/page.tsx"), /searchParams: Promise<\{ order\?: string/);
});

test("Buy it again links to the product rather than re-adding a stale configuration", () => {
  // The cart prices live against the product's *current* option groups, so a
  // group removed since the purchase is dropped silently and the customer is
  // sold a similar object missing what distinguished theirs.
  const done = order({ status: "completed", fulfillment_status: "delivered" });
  assert.equal(orderHistoryRepurchaseSlug(done), "billet-shift-knob");
  assert.equal(orderHistoryActions(done).find((a) => a.key === "buy-again")?.href, "/catalog/billet-shift-knob");
  // Not while it is still being made.
  assert.equal(orderHistoryRepurchaseSlug(order({})), null);
  // Not on a multi-item order: "buy it again" does not say which again.
  assert.equal(
    orderHistoryRepurchaseSlug(
      order({
        status: "completed",
        fulfillment_status: "delivered",
        order_items: [...(base.order_items ?? []), { id: "z", product_id: "p2", product_name: "Spacer", product_slug: "spacer", quantity: 1, unit_price_cents: 1, line_subtotal_cents: 1, selected_options: null }],
      })
    ),
    null
  );
  // Not on a legacy order with no product to link to.
  assert.equal(orderHistoryRepurchaseSlug(order({ status: "completed", fulfillment_status: "delivered", order_items: [] })), null);
  // And nothing here writes to a cart.
  assert.ok(!card.includes("useCart") && !card.includes("/api/cart"));
});

test("every action link is individually named", () => {
  // Twelve cards each with a "View order" link need twelve distinguishable
  // names, or a screen reader's link list is twelve identical rows.
  const markup = renderToStaticMarkup(
    createElement(OrderHistoryCard, { order: order({ tracking_url: "https://example.com/t" }) })
  );
  assert.match(markup, /View order<span class="sr-only"> KM-0012<\/span>/);
  assert.match(markup, /Track package<span class="sr-only"> for order KM-0012 \(opens in a new tab\)<\/span>/);
});

// ---------------------------------------------------------------------------
// Filtering, searching, sorting
// ---------------------------------------------------------------------------

test("orders land in exactly one tab", () => {
  assert.equal(orderHistoryTabOf(order({})), "active");
  assert.equal(orderHistoryTabOf(order({ status: "completed" })), "completed");
  assert.equal(orderHistoryTabOf(order({ status: "cancelled" })), "cancelled");
  assert.equal(orderHistoryTabOf(order({ status: "declined" })), "cancelled");
  assert.equal(orderHistoryTabOf(order({ payment_status: "refunded" })), "cancelled");
  assert.equal(orderHistoryTabOf(order({ cancellation_status: "completed" })), "cancelled");

  const all = [order({}), order({ id: "b", status: "completed" }), order({ id: "c", status: "cancelled" })];
  assert.equal(filterOrderHistoryTab(all, "all").length, 3);
  assert.equal(filterOrderHistoryTab(all, "active").length, 1);
  assert.equal(filterOrderHistoryTab(all, "completed").length, 1);
  assert.equal(filterOrderHistoryTab(all, "cancelled").length, 1);
});

test("search finds an order by its number or by what was in it", () => {
  const rows = [
    order({}),
    order({ id: "b", order_number: "KM-0099", product_name: "Walnut Board", order_items: [] }),
  ];
  assert.deepEqual(searchOrderHistory(rows, "KM-0012").map((o) => o.id), [base.id]);
  assert.deepEqual(searchOrderHistory(rows, "walnut").map((o) => o.id), ["b"]);
  // The line item's name counts, not only the order's own.
  assert.deepEqual(searchOrderHistory(rows, "billet").map((o) => o.id), [base.id]);
  // Hyphen and case are not the customer's problem.
  assert.deepEqual(searchOrderHistory(rows, "km0012").map((o) => o.id), [base.id]);
  assert.deepEqual(searchOrderHistory(rows, "  KM-0099 ").map((o) => o.id), ["b"]);
  assert.equal(searchOrderHistory(rows, "").length, 2);
  assert.equal(searchOrderHistory(rows, "nothing").length, 0);
});

test("sorting is by the date on the card, and there are only two of them", () => {
  // `updated_at` was the default and is not a property of the order: a staff
  // note reshuffles the list under a customer who has done nothing, and the
  // position stops agreeing with the only date they can see.
  assert.deepEqual([...ORDER_HISTORY_SORTS], ["newest", "oldest"]);
  const rows = [
    order({ id: "old", created_at: "2026-01-01T00:00:00Z" }),
    order({ id: "new", created_at: "2026-08-01T00:00:00Z" }),
  ];
  assert.deepEqual(sortOrderHistory(rows, "newest").map((o) => o.id), ["new", "old"]);
  assert.deepEqual(sortOrderHistory(rows, "oldest").map((o) => o.id), ["old", "new"]);
  // Pure: the input is not reordered in place.
  assert.deepEqual(rows.map((o) => o.id), ["old", "new"]);
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

test("ownership is the query and RLS is the control", () => {
  assert.match(page, /\.eq\("customer_id", auth\.data\.user\.id\)/);
  // A matching email address is not ownership, and knowing a UUID is not access.
  assert.ok(!page.includes("guest_email"));
  assert.ok(!page.includes("guest_token"));
  assert.ok(!/\.eq\("email"/.test(page));
});

test("no staff or production data is selected at all", () => {
  // A better guarantee than remembering not to render it. Checked against the
  // select list rather than the file, because the file's own prose explains why
  // these are absent.
  for (const forbidden of [
    "internal",
    "staff",
    "production",
    "cost",
    "margin",
    "assigned",
    "machine",
    "operator",
    "stripe",
    "payment_intent",
    "note",
    "customer_id",
  ]) {
    assert.ok(!selectedColumns.toLowerCase().includes(forbidden), `${forbidden} must not be selected`);
  }
  // And nothing else queries a staff table.
  for (const table of ["production_jobs", "order_messages", "user_staff_notes", "order_status_history"]) {
    assert.ok(!page.includes(table), `${table} is not a customer's to read`);
  }
});

test("a failed read is an error, never an empty history", () => {
  assert.match(page, /if \(result\.error\) \{\s*setState\("error"\);/);
  assert.match(page, /Unable to load your orders/);
  assert.ok(!/No orders yet[\s\S]{0,200}state === "error"/.test(page));
  // Signed out is its own state, not an error notice.
  assert.match(page, /setState\("signed-out"\)/);
  assert.match(page, /Sign in to see your orders/);
});

test("the empty state invites, and the filtered-empty state explains", () => {
  assert.match(page, /No orders yet/);
  assert.match(page, /Browse the catalog to find your first KeyMoura product\./);
  assert.match(page, /No orders match “\$\{term\}”/);
});

test("the query is bounded and the images are not N+1", () => {
  assert.match(page, /const PAGE_SIZE = 25/);
  assert.match(page, /\.limit\(PAGE_SIZE \+ 1\)/);
  assert.match(page, /rows\.length > PAGE_SIZE/);
  // Line items arrive nested; photographs are one further `in (…)`, not one
  // query per card and not one per line.
  assert.match(page, /order_items\(id,product_id,product_name/);
  assert.match(page, /\.in\("id", productIds\)/);
  assert.equal((page.match(/\.from\("products"\)/g) ?? []).length, 1);
  assert.ok(!/for \([\s\S]{0,120}await supabase/.test(page), "no query inside a loop");
});

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

test("the card is a named region, not a giant link", () => {
  // An order has several genuinely different actions; a card-wide anchor
  // swallowing the clicks around them is the trap ProductCard documents.
  assert.match(card, /<article className="order-card" aria-labelledby=\{headingId\}/);
  const markup = renderToStaticMarkup(
    createElement(OrderHistoryCard, { order: order({ tracking_url: "https://example.com/t" }) })
  );
  assert.match(markup, /aria-labelledby="order-[^"]+-heading"/);
  assert.match(markup, /id="order-[^"]+-heading">KM-0012/);
  // Every anchor is its own control. A card-wide overlay would make the count
  // of hit targets one, whatever the DOM says.
  assert.ok(!markup.includes("product-card-link"), "no stretched-link overlay");
  const anchors = markup.match(/<a /g) ?? [];
  assert.ok(anchors.length >= 3, `expected several independent links, saw ${anchors.length}`);
});

test("items left and actions right on a wide screen, stacked below it", () => {
  assert.match(globalsCss, /@media \(min-width: 900px\) \{\s*\.order-card-body \{ grid-template-columns: minmax\(0, 1fr\) minmax\(11rem, 13rem\);/);
  assert.match(globalsCss, /\.order-card-body \{\s*display: grid;\s*gap: 1\.25rem;/);
  // Header columns collapse to two on a phone rather than staying at four.
  assert.match(globalsCss, /\.order-card-header \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(globalsCss, /@media \(min-width: 768px\) \{\s*\.order-card-header \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); \}/);
});

test("the header strip is a surface, not another card", () => {
  // Card inside card inside card is how an order list stops reading as a list.
  const rule = globalsCss.slice(globalsCss.indexOf(".order-card-header {"));
  const body = rule.slice(0, rule.indexOf("}"));
  assert.ok(body.includes("border-bottom"), body);
  assert.ok(!body.includes("border-radius"), "a nested radius would make it a card");
  assert.ok(body.includes("background"), body);
});

test("long values cannot break the card", () => {
  const long = order({
    order_number: "KM-000000000000000000012",
    agreed_price_cents: 129900000,
    order_items: [
      {
        id: "x",
        product_id: "p1",
        product_name: "Adjustable Rear Subframe Alignment Fixture With Extended Arms And A Very Long Name",
        product_slug: "subframe",
        quantity: 999,
        unit_price_cents: 129900000,
        line_subtotal_cents: 129900000,
        selected_options: { a: "Raw aluminium", b: "Extended", c: "Stainless", d: "Dropped" },
      },
    ],
  });
  const markup = renderToStaticMarkup(createElement(OrderHistoryCard, { order: long }));
  assert.match(markup, /\$1,299,000\.00/);
  assert.match(markup, /Qty 999/);
  // Only three option values, never the fourth.
  assert.match(markup, /Raw aluminium · Extended · Stainless/);
  assert.ok(!markup.includes("Dropped"));
  for (const selector of ["order-card-fact dd", "product-card-title"]) void selector;
  assert.match(globalsCss, /\.order-card-fact dd \{[\s\S]*?overflow-wrap: anywhere;/);
  assert.match(globalsCss, /\.order-card-item-name \{ font-weight: 600; overflow-wrap: anywhere; \}/);
});
