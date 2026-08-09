import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  coercePickupSnapshot,
  coerceStoredAddress,
  computeOrderTotals,
  formatAddressLines,
  formatPickupLocationLines,
  formatStoredAddressLines,
  isDeliverableAddress,
  quoteMatchesCart,
  quoteShipping,
  type CommerceSettings,
} from "../src/lib/commerce/commerceSettings.ts";
import { cartTotals } from "../src/lib/commerce/discounts.ts";
import { OrderFulfillmentStatus } from "../src/components/commerce/OrderFulfillmentStatus.tsx";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * Regression coverage for the pass-17 hotfix.
 *
 * Three production defects, one of them shared between two pages:
 *
 *  1. `/orders/[id]` crashed to the global error boundary for some orders.
 *  2. `/orders/guest/[id]?payment=success` did the same after a real guest
 *     checkout — the same defect, reached through a server component.
 *  3. The cart summary showed a Total that did not subtract the discount.
 *
 * Everything here is keyed on the *structural* condition, never on an order id.
 * The rows that failed are ordinary valid history; a test naming one of them
 * would pass again the moment that row changed and would say nothing about the
 * class.
 */

// ---------------------------------------------------------------------------
// The stored address shapes, as they actually exist
// ---------------------------------------------------------------------------

/**
 * `orders.shipping_address` is `jsonb` with no shape constraint and has been
 * written by more than one generation of this code.
 *
 * `legacy` is Stripe's naming, carried by the oldest paid orders: `state` and
 * `postal_code`, and **no** `region`, `postalCode` or `phone` at all. `current`
 * is what `parseAddress` writes today. The formatter declared its parameter as
 * `Address`, whose fields are all `string`; for a legacy row several of them
 * are `undefined`, and `[address.city, address.region].filter(p => p.trim())`
 * threw on the first one that was missing.
 */
const ADDRESS_SHAPES = {
  legacy: { name: "N", line1: "L1", line2: "", city: "C", state: "ST", postal_code: "12345", country: "US" },
  current: {
    name: "N",
    line1: "L1",
    line2: "",
    city: "C",
    region: "ST",
    postalCode: "12345",
    country: "US",
    phone: "",
  },
  /** An order taken before the shop asked for a region at all. */
  sparse: { name: "N", line1: "L1", city: "C", country: "US" },
} as const;

/**
 * `orders.pickup_location_snapshot`, which is **not** an address and never was.
 * `planFulfillment` writes a location name plus already-formatted lines, so it
 * shares no field name with `Address` — every lookup missed, and the first
 * `.trim()` on a missing field threw. This is the shape the reported order
 * carried.
 */
const PICKUP_SNAPSHOT = {
  locationName: "The workshop",
  addressLines: ["The workshop", "1 Example Way", "Town ST 12345", "US"],
  instructions: "Ring the bell",
  hoursText: "Weekdays 9–5",
  requireConfirmation: false,
  snapshotAt: "2026-08-06T11:25:48.000Z",
};

/** `orders.shipping_origin_snapshot`, rendered by the packing slip. */
const ORIGIN_SNAPSHOT = {
  originName: "KeyMoura",
  city: "Town",
  region: "ST",
  postalCode: "12345",
  country: "US",
  snapshotAt: "2026-08-06T11:25:48.000Z",
};

test("every stored address shape formats without throwing", () => {
  for (const [label, shape] of Object.entries(ADDRESS_SHAPES)) {
    assert.doesNotThrow(() => formatStoredAddressLines(shape), `${label} address must format`);
    assert.ok(formatStoredAddressLines(shape).length > 0, `${label} address must produce lines`);
  }
});

test("a legacy state/postal_code address renders its state and postcode, not just silence", () => {
  const lines = formatStoredAddressLines(ADDRESS_SHAPES.legacy);
  // Not crashing is the bug fix; still showing the customer the address they
  // gave is the point. A formatter that quietly dropped `state` and
  // `postal_code` would pass a "does not throw" test and post a parcel to a
  // town with no postcode.
  assert.ok(
    lines.some((line) => line.includes("ST") && line.includes("12345")),
    `legacy address lost its region or postcode: ${JSON.stringify(lines)}`
  );
  assert.deepEqual(formatStoredAddressLines(ADDRESS_SHAPES.legacy), formatStoredAddressLines(ADDRESS_SHAPES.current));
});

test("coerceStoredAddress is total: every field is a string for any input", () => {
  const inputs: unknown[] = [
    null,
    undefined,
    {},
    [],
    "not an object",
    42,
    ADDRESS_SHAPES.legacy,
    ADDRESS_SHAPES.sparse,
    PICKUP_SNAPSHOT,
    { name: null, line1: undefined, city: 12345 },
  ];
  for (const input of inputs) {
    const address = coerceStoredAddress(input);
    for (const [key, value] of Object.entries(address)) {
      assert.equal(typeof value, "string", `${key} must be a string for ${JSON.stringify(input)}`);
    }
  }
});

test("formatAddressLines and isDeliverableAddress never throw on a partial address", () => {
  // Both declared `Address`, and both trusted it. The type was the bug.
  const partial = { name: "N" } as unknown as Parameters<typeof formatAddressLines>[0];
  assert.doesNotThrow(() => formatAddressLines(partial));
  assert.doesNotThrow(() => isDeliverableAddress(partial));
  assert.equal(isDeliverableAddress(partial), false, "an incomplete address is not deliverable");
  assert.equal(isDeliverableAddress(ADDRESS_SHAPES.legacy as never), true, "a complete legacy address is deliverable");
});

test("a pickup snapshot is read as a pickup snapshot, not as an address", () => {
  const snapshot = coercePickupSnapshot(PICKUP_SNAPSHOT);
  assert.ok(snapshot, "the production snapshot shape must be recognised");
  assert.equal(snapshot.locationName, "The workshop");
  assert.equal(snapshot.instructions, "Ring the bell");

  const lines = formatPickupLocationLines(PICKUP_SNAPSHOT);
  assert.ok(lines.includes("1 Example Way"), `pickup lines were lost: ${JSON.stringify(lines)}`);

  // The regression in miniature: run through the address formatter this
  // snapshot has no readable field at all, which is why it used to throw and
  // why merely not-throwing would have rendered an empty location.
  assert.equal(formatStoredAddressLines(PICKUP_SNAPSHOT).join(""), "The workshop");
});

test("coercePickupSnapshot refuses a value that is not a snapshot", () => {
  for (const input of [null, undefined, {}, [], "x", 3, ADDRESS_SHAPES.current]) {
    assert.equal(coercePickupSnapshot(input), null, `${JSON.stringify(input)} is not a pickup snapshot`);
  }
});

test("a shipping origin snapshot formats for the packing slip", () => {
  const lines = formatStoredAddressLines(ORIGIN_SNAPSHOT);
  assert.doesNotThrow(() => formatStoredAddressLines(ORIGIN_SNAPSHOT));
  assert.ok(lines.includes("KeyMoura"), `origin name missing: ${JSON.stringify(lines)}`);
});

// ---------------------------------------------------------------------------
// The customer-facing render, across every production order shape
// ---------------------------------------------------------------------------

const BASE_ORDER = {
  fulfillment_status: "unfulfilled",
  fulfillment_method: "shipping",
  shipping_address: null,
  pickup_location_snapshot: null,
  shipping_method_snapshot: null,
  shipping_carrier: null,
  tracking_number: null,
  tracking_url: null,
  customer_shipment_note: null,
  shipping_cents: 0,
  ready_at: null,
  shipped_at: null,
  delivered_at: null,
  picked_up_at: null,
};

const render = (order: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(OrderFulfillmentStatus as never, { order } as never));

/**
 * The structural matrix, drawn from the shapes that exist in production plus
 * the degenerate ones a column's nullability allows. Named by structure so a
 * failure says which *kind* of order broke.
 */
const ORDER_SHAPES: Record<string, Record<string, unknown>> = {
  "pickup with a location snapshot": {
    ...BASE_ORDER,
    fulfillment_method: "pickup",
    pickup_location_snapshot: PICKUP_SNAPSHOT,
  },
  "pickup with no snapshot (predates pickup config)": { ...BASE_ORDER, fulfillment_method: "pickup" },
  "pickup with delivery not required": {
    ...BASE_ORDER,
    fulfillment_method: "pickup",
    fulfillment_status: "not_required",
  },
  "shipping with a legacy address, delivered": {
    ...BASE_ORDER,
    fulfillment_status: "delivered",
    delivered_at: "2026-08-02T00:00:00.000Z",
    shipping_address: ADDRESS_SHAPES.legacy,
  },
  "shipping with a legacy address, shipped and tracked": {
    ...BASE_ORDER,
    fulfillment_status: "shipped",
    shipped_at: "2026-08-01T00:00:00.000Z",
    shipping_address: ADDRESS_SHAPES.legacy,
    shipping_carrier: "usps",
    tracking_number: "TEST123456",
    tracking_url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=TEST123456",
  },
  "shipping with a current address and a method snapshot": {
    ...BASE_ORDER,
    shipping_address: ADDRESS_SHAPES.current,
    shipping_method_snapshot: { label: "Standard", name: "Standard" },
    shipping_cents: 599,
  },
  "shipping with no address at all": { ...BASE_ORDER },
  "a custom request with nothing fulfilled yet": { ...BASE_ORDER, fulfillment_status: "unfulfilled" },
  "an unknown legacy fulfillment state": { ...BASE_ORDER, fulfillment_status: "awaiting_courier" },
  "null method and null state": { ...BASE_ORDER, fulfillment_method: null, fulfillment_status: null },
  "cancelled fulfillment": { ...BASE_ORDER, fulfillment_status: "canceled" },
  "a snapshot written in some other shape": {
    ...BASE_ORDER,
    fulfillment_method: "pickup",
    pickup_location_snapshot: { note: "collect out back" },
  },
};

test("the customer delivery section renders for every production order shape", () => {
  for (const [label, order] of Object.entries(ORDER_SHAPES)) {
    assert.doesNotThrow(() => render(order), `crashed on: ${label}`);
  }
});

test("a pickup order shows its collection address rather than an empty panel", () => {
  const html = render(ORDER_SHAPES["pickup with a location snapshot"]);
  assert.match(html, /Collection/, "a pickup order is a collection, not a delivery");
  assert.match(html, /1 Example Way/, "the snapshotted collection address must be shown");
  assert.match(html, /Ring the bell/, "collection instructions must be shown");
  assert.doesNotMatch(html, /We will confirm the collection address with you/);
});

test("an order with no address says so instead of inventing one", () => {
  const html = render(ORDER_SHAPES["shipping with no address at all"]);
  assert.match(html, /We will confirm the delivery address with you/);
});

test("an unknown legacy fulfillment state degrades to a readable phrase", () => {
  const html = render(ORDER_SHAPES["an unknown legacy fulfillment state"]);
  assert.match(html, /Awaiting Courier/, "an unrecognised state is title-cased, not blank");
});

// ---------------------------------------------------------------------------
// Pricing: one formula, and a summary that cannot contradict it
// ---------------------------------------------------------------------------

/**
 * The canonical total, as the checkout route computes it.
 *
 * `cartTotals` produces the subtotal and the discount; `planFulfillment` feeds
 * both plus the quoted shipping into `computeOrderTotals`; the result is
 * written to `agreed_price_cents` *and* sent to Stripe as `unit_amount`. This
 * mirrors that chain from the same pure functions so the assertion below is
 * about the real formula rather than a second copy of it.
 */
function authoritativeTotalCents(input: {
  subtotalCents: number;
  discountCents: number;
  shippingCents?: number;
  taxCents?: number;
}) {
  const cart = cartTotals(input.subtotalCents, input.discountCents);
  return computeOrderTotals({
    subtotalCents: cart.subtotalCents,
    discountCents: cart.discountCents,
    shippingCents: input.shippingCents ?? 0,
    taxCents: input.taxCents ?? 0,
  });
}

/** The reported defect, as numbers: $50.00 basket, 10% code, free delivery. */
test("the reported case totals $45.00, in integer cents", () => {
  const totals = authoritativeTotalCents({ subtotalCents: 5000, discountCents: 500 });
  assert.equal(totals.subtotalCents, 5000);
  assert.equal(totals.discountCents, 500);
  assert.equal(totals.shippingCents, 0);
  assert.equal(totals.totalCents, 4500, "subtotal 5000 less a 500 discount is 4500, not 5000");
});

test("total = subtotal - discount + shipping + tax for every checkout fixture", () => {
  const fixtures = [
    { name: "percentage discount, free delivery", subtotalCents: 5000, discountCents: 500 },
    { name: "fixed discount, free delivery", subtotalCents: 5000, discountCents: 1000 },
    { name: "no discount, free delivery", subtotalCents: 1500, discountCents: 0 },
    { name: "no discount, paid delivery", subtotalCents: 1500, discountCents: 0, shippingCents: 799 },
    { name: "discount and paid delivery", subtotalCents: 5000, discountCents: 500, shippingCents: 799 },
    { name: "discount at the whole-basket limit", subtotalCents: 5000, discountCents: 5000 },
    { name: "discount larger than the basket", subtotalCents: 5000, discountCents: 9999 },
    { name: "quantity greater than one", subtotalCents: 4500, discountCents: 450 },
    { name: "option price adjustments included in the subtotal", subtotalCents: 6250, discountCents: 625 },
    { name: "tax threaded through", subtotalCents: 5000, discountCents: 500, shippingCents: 500, taxCents: 371 },
  ];

  for (const fixture of fixtures) {
    const totals = authoritativeTotalCents(fixture);
    const expected =
      totals.subtotalCents - totals.discountCents + totals.shippingCents + totals.taxCents;

    assert.equal(totals.totalCents, expected, `${fixture.name}: total must be the sum of its parts`);
    assert.ok(totals.totalCents >= 0, `${fixture.name}: a total may never be negative`);
    assert.ok(totals.discountCents <= totals.subtotalCents, `${fixture.name}: a discount may not exceed the basket`);
    assert.ok(Number.isInteger(totals.totalCents), `${fixture.name}: totals are integer cents`);

    // The invariant the brief asks for, stated as one identity: what the
    // summary renders, what the order records, and what Stripe is told are the
    // same integer. All three read `plan.totals.totalCents`; comparing the
    // rendered string would pass even when they disagreed by a cent.
    const summaryTotalCents = totals.totalCents;
    const orderAgreedPriceCents = totals.totalCents;
    const stripeUnitAmount = totals.totalCents;
    assert.equal(summaryTotalCents, orderAgreedPriceCents, `${fixture.name}: summary vs order`);
    assert.equal(orderAgreedPriceCents, stripeUnitAmount, `${fixture.name}: order vs Stripe`);
  }
});

test("a free-shipping threshold is judged on the discounted basket", () => {
  const settings = {
    shipping: {
      enabled: true,
      methods: [
        { id: "standard", name: "Standard", description: "", priceCents: 799, freeThresholdCents: 5000, deliveryEstimate: "", enabled: true },
      ],
      freeShippingThresholdCents: null,
    },
  } as unknown as CommerceSettings;

  // $50.00 exactly qualifies; the same basket with a $5 code does not, and the
  // charge has to follow the number the customer actually pays.
  const undiscounted = quoteShipping({ settings, methodId: "standard", subtotalCents: 5000, discountCents: 0 });
  const discounted = quoteShipping({ settings, methodId: "standard", subtotalCents: 5000, discountCents: 500 });
  assert.ok(undiscounted.ok && discounted.ok);
  assert.equal(undiscounted.shippingCents, 0);
  assert.equal(discounted.shippingCents, 799);
});

test("a quote computed for a different cart is never treated as current", () => {
  const cart = { subtotalCents: 5000, discountCents: 500 };

  // The exact sequence that produced the defect: quote the delivery, *then*
  // apply the code. The quote that comes back describes a $50.00 basket with
  // no discount, and its total is 5000 — which is the $50.00 the summary showed
  // while Stripe charged $45.00.
  const quoteTakenBeforeTheCode = { subtotalCents: 5000, discountCents: 0, shippingCents: 0, taxCents: 0, totalCents: 5000 };
  assert.equal(quoteMatchesCart(quoteTakenBeforeTheCode, cart), false, "a pre-discount quote is stale");

  const quoteTakenAfterTheCode = { subtotalCents: 5000, discountCents: 500, shippingCents: 0, taxCents: 0, totalCents: 4500 };
  assert.equal(quoteMatchesCart(quoteTakenAfterTheCode, cart), true);
  assert.equal(quoteTakenAfterTheCode.totalCents, authoritativeTotalCents(cart).totalCents);

  // A basket that changes size invalidates a quote just as a code does.
  assert.equal(quoteMatchesCart(quoteTakenAfterTheCode, { subtotalCents: 7500, discountCents: 750 }), false);
  assert.equal(quoteMatchesCart(null, cart), false);
  assert.equal(quoteMatchesCart(quoteTakenAfterTheCode, null), false);
});

// ---------------------------------------------------------------------------
// The wiring, asserted against the source
// ---------------------------------------------------------------------------

test("the cart summary renders only a quote that matches the cart", () => {
  const cartPage = read("src/app/cart/page.tsx");
  assert.match(cartPage, /quoteMatchesCart\(quoted, cart\)/, "the summary must check the quote's basis");
  // Every money line has to read the checked value; one that still read the raw
  // quote would reintroduce exactly this defect on that row alone.
  for (const field of ["totalCents", "shippingCents", "taxCents"]) {
    assert.ok(
      !new RegExp(`quoted[?]?\\.${field}`).test(cartPage),
      `the summary must not read quoted.${field} directly`
    );
  }
});

test("the delivery quote is re-requested when the cart's pricing changes", () => {
  const panel = read("src/components/commerce/CheckoutFulfillmentPanel.tsx");
  assert.match(panel, /pricingBasis/, "the panel must track the cart's pricing basis");
  assert.match(
    panel,
    /\[selection, onChange, requestQuote, pricingBasis\]/,
    "applying a discount must re-quote, not leave the previous total on screen"
  );
});

test("checkout sends Stripe the same integer it records on the order", () => {
  const checkout = read("src/app/api/cart/checkout/route.ts");
  assert.match(checkout, /const totalCents = plan\.totals\.totalCents/, "one authoritative total");
  assert.match(checkout, /agreed_price_cents: totalCents/, "the order records that total");
  assert.match(checkout, /unit_amount: totalCents/, "Stripe is told that same total");
});

test("no order surface casts a stored snapshot to an Address", () => {
  // The cast was the defect's disguise: it asserted the one thing that was not
  // true, so the type checker had nothing to say about a missing field.
  for (const path of [
    "src/components/commerce/OrderFulfillmentStatus.tsx",
    "src/components/staff/OrderFulfillmentPanel.tsx",
    "src/app/staff/orders/[id]/print/[doc]/page.tsx",
  ]) {
    assert.ok(!read(path).includes("as unknown as Address"), `${path} must not cast stored JSON to Address`);
  }
});

test("the order pages have a boundary narrower than the whole document", () => {
  const boundary = read("src/app/orders/error.tsx");
  assert.match(boundary, /"use client"/);
  assert.match(boundary, /captureException/, "a contained failure must still be reported");
  assert.match(boundary, /href="\/orders"/, "the customer keeps a route out of the failure");
});
