import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  chargeableAmountCents,
  checkoutAmountCents,
  netCollectedCents,
  payableHeadroomCents,
} from "../src/lib/paymentMath.ts";
import { snapshotPurchasedOptions, snapshotSelections } from "../src/lib/commerce/orderConfiguration.ts";
import { lineSignature } from "../src/lib/commerce/pricing.ts";

/**
 * The final commerce-correctness pass.
 *
 * Two defects are pinned here, both of which end in money that was taken and
 * never recorded, and one of which ends in an order the customer did not place.
 * The source assertions are as important as the arithmetic ones: the rules only
 * hold while every surface that names a price uses the same helper.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");

const accountCheckout = read("src/app/api/orders/[id]/checkout/route.ts");
const guestCheckout = read("src/app/api/orders/guest/[id]/checkout/route.ts");
const directCheckout = read("src/app/api/cart/checkout/route.ts");
const accountOrderPage = read("src/app/orders/[id]/page.tsx");
const guestAccess = read("src/lib/commerce/guestOrderAccess.ts");
const paymentAccounting = read("supabase/migrations/20260801080000_atomic_payment_accounting.sql");

// ---------------------------------------------------------------------------
// The ledger's own ceiling
// ---------------------------------------------------------------------------

test("record_stripe_order_payment refuses a payment that overshoots the agreed price", () => {
  // The rule the routes now have to respect. Stated here so that a change to
  // the RPC's arithmetic breaks this test rather than silently breaking the
  // clamp built on top of it.
  assert.match(paymentAccounting, /new_paid\s*:=\s*coalesce\(selected_order\.amount_paid_cents,\s*0\)\s*\+\s*p_amount_cents/);
  assert.match(paymentAccounting, /new_net\s*:=\s*new_paid\s*-\s*coalesce\(selected_order\.amount_refunded_cents,\s*0\)/);
  assert.match(paymentAccounting, /if new_net > selected_order\.agreed_price_cents then\s*raise exception 'order_amount_mismatch'/);
});

test("payable headroom is measured from the raw columns, not the payment status", () => {
  // `netCollectedCents` deliberately ignores the amounts on an `unpaid` row so
  // a re-quote is not hidden by stale data. The ledger does no such thing, and
  // the headroom has to agree with the ledger.
  const requoted = {
    agreed_price_cents: 10_000,
    amount_paid_cents: 6_000,
    amount_refunded_cents: 0,
    payment_status: "unpaid",
  };

  assert.equal(netCollectedCents(requoted), 0, "the payment-math view still ignores a stale paid amount");
  assert.equal(payableHeadroomCents(requoted), 4_000, "the headroom must not");
});

test("a refund gives its headroom back", () => {
  assert.equal(
    payableHeadroomCents({
      agreed_price_cents: 10_000,
      amount_paid_cents: 10_000,
      amount_refunded_cents: 2_500,
      payment_status: "partially_refunded",
    }),
    2_500
  );
});

test("a fully paid order has no headroom left", () => {
  assert.equal(
    payableHeadroomCents({
      agreed_price_cents: 5_500,
      amount_paid_cents: 5_500,
      amount_refunded_cents: 0,
      payment_status: "paid",
    }),
    0
  );
});

test("a deposit-paid order reset to unpaid cannot be charged its deposit twice", () => {
  /*
   * The path that loses money.
   *
   * A $100 order with a $60 deposit is paid down to $40 outstanding. The order
   * is then reset to `unpaid` — by a staff re-quote, or, before this pass, by
   * starting a balance checkout at all. `checkoutAmountCents` reads the reset
   * status, concludes nothing has been collected, and offers the $60 deposit a
   * second time. Stripe takes the $60; `record_stripe_order_payment` computes
   * $120 against a $100 order and raises, so the webhook 500s and the customer
   * has paid $120 for an order the application still records as unpaid.
   */
  const order = {
    agreed_price_cents: 10_000,
    amount_paid_cents: 6_000,
    amount_refunded_cents: 0,
    deposit_amount_cents: 6_000,
    payment_status: "unpaid",
  };

  assert.equal(checkoutAmountCents(order), 6_000, "the uncapped figure is still the deposit");
  assert.ok(
    order.amount_paid_cents + checkoutAmountCents(order) > order.agreed_price_cents,
    "and charging it would overshoot the agreed price"
  );

  assert.equal(chargeableAmountCents(order), 4_000, "the capped figure is exactly what remains");
  assert.equal(
    order.amount_paid_cents + chargeableAmountCents(order),
    order.agreed_price_cents,
    "so the ledger settles the order rather than refusing the payment"
  );
});

test("the cap never inflates an ordinary deposit", () => {
  // The clamp is a ceiling, not a replacement. A first payment on an untouched
  // order still collects the configured deposit.
  const order = {
    agreed_price_cents: 5_500,
    amount_paid_cents: 0,
    amount_refunded_cents: 0,
    deposit_amount_cents: 2_500,
  };
  assert.equal(chargeableAmountCents(order), 2_500);
  assert.equal(chargeableAmountCents({ ...order, amount_paid_cents: 2_500, payment_status: "partial" }), 3_000);
});

test("an order with nothing left to collect is refused before Stripe is called", () => {
  const settled = {
    agreed_price_cents: 10_000,
    amount_paid_cents: 10_000,
    amount_refunded_cents: 0,
    deposit_amount_cents: 6_000,
    payment_status: "unpaid",
  };
  // Below the 50-cent floor both routes test, so neither creates a session.
  assert.ok(chargeableAmountCents(settled) < 50);
});

// ---------------------------------------------------------------------------
// Every surface that names a price uses the capped figure
// ---------------------------------------------------------------------------

test("both quote-checkout routes charge the capped amount", () => {
  for (const [name, source] of [
    ["account", accountCheckout],
    ["guest", guestCheckout],
  ] as const) {
    assert.match(
      source,
      /const amountDue = chargeableAmountCents\(order\)/,
      `${name} checkout must charge the capped amount`
    );
    assert.doesNotMatch(
      stripComments(source),
      /const amountDue = checkoutAmountCents\(order\)/,
      `${name} checkout must not charge the uncapped amount`
    );
  }
});

test("the pay controls offer the same figure the routes would accept", () => {
  // A button that names an amount the route refuses is a dead end the customer
  // can only discover by pressing it.
  assert.match(accountOrderPage, /chargeableAmountCents\(order\)/);
  assert.match(guestAccess, /chargeableAmountCents\(order\)/);
  assert.doesNotMatch(stripComments(accountOrderPage), /checkoutAmountCents/);
  assert.doesNotMatch(stripComments(guestAccess), /checkoutAmountCents/);
});

test("starting a checkout never resets the payment state of an order that has collected money", () => {
  for (const [name, source] of [
    ["account", accountCheckout],
    ["guest", guestCheckout],
  ] as const) {
    const code = stripComments(source);
    // The reset is conditional on nothing having been collected.
    assert.match(
      code,
      /collectedBeforeCheckout > 0\s*\?\s*\{\}\s*:\s*\{\s*payment_status:\s*"unpaid",\s*status:\s*"awaiting_payment"\s*\}/,
      `${name} checkout must gate the payment-state reset`
    );
    // And is never written unconditionally alongside the session id.
    assert.doesNotMatch(
      code,
      /stripe_checkout_session_id:\s*session\.id,\s*payment_status:\s*"unpaid"/,
      `${name} checkout must not clobber a recorded payment`
    );
  }
});

// ---------------------------------------------------------------------------
// One basket, one canonical order
// ---------------------------------------------------------------------------

test("a purchased-option snapshot round-trips back to the selections it was built from", () => {
  const line = {
    optionLabels: [
      { groupId: "g1", groupKey: "finish", group: "Finish", valueId: "v1", value: "satin", label: "Satin", adjustmentCents: 500 },
      { groupId: "g2", groupKey: "colour", group: "Colour", valueId: "v2", value: "red", label: "Red", adjustmentCents: 0 },
    ],
  };

  const selections = snapshotSelections(snapshotPurchasedOptions(line));
  assert.deepEqual(selections, { finish: "satin", colour: "red" });
  // Which is what lets a stored order line be matched against a live cart line.
  assert.equal(lineSignature("p1", selections), lineSignature("p1", { colour: "red", finish: "satin" }));
});

test("snapshot selections survive a malformed or empty snapshot", () => {
  assert.deepEqual(snapshotSelections(null), {});
  assert.deepEqual(snapshotSelections("nope"), {});
  assert.deepEqual(snapshotSelections([1, 2]), {});
  assert.deepEqual(snapshotSelections({ finish: null, colour: { value: "red" } }), { colour: "red" });
});

test("two configurations of one product stay distinct lines", () => {
  // The property the reuse check leans on: a fingerprint built from
  // `lineSignature` cannot collapse Red and Blue into one line.
  assert.notEqual(lineSignature("p1", { colour: "red" }), lineSignature("p1", { colour: "blue" }));
  assert.equal(lineSignature("p1", { a: "1", b: "2" }), lineSignature("p1", { b: "2", a: "1" }));
});

test("direct checkout reuses an in-flight order rather than writing another", () => {
  const code = stripComments(directCheckout);

  // The check happens before anything is written — before the hold is taken and
  // well before the order insert.
  const reuseAt = code.indexOf("inFlightCheckout({");
  const reserveAt = code.indexOf("reserveCartInventory({");
  const insertAt = code.search(/\.from\("orders"\)\s*\.insert\(/);
  assert.ok(reuseAt > 0, "the reuse check must exist");
  assert.ok(reserveAt > reuseAt, "the reuse check must run before stock is held");
  assert.ok(insertAt > reuseAt, "the reuse check must run before a second order is written");

  // And it returns the existing session rather than a new one.
  assert.match(code, /if \(inFlight\) return NextResponse\.json\(\{ url: inFlight\.url, orderId: inFlight\.orderId \}\)/);
});

test("order reuse is refused unless the owner, basket, total and session all match", () => {
  const code = stripComments(directCheckout);

  // Nothing that has been paid, or is not this kind of order, is reusable.
  assert.match(code, /order\.order_kind !== "direct_purchase"/);
  assert.match(code, /order\.status !== "awaiting_payment"/);
  assert.match(code, /order\.payment_status !== "unpaid"/);
  assert.match(code, /order\.agreed_price_cents !== input\.totalCents/);

  // An account order must belong to this account; a guest order must be one
  // this browser still holds the credential for.
  assert.match(code, /order\.customer_id === input\.userId/);
  assert.match(code, /guestTokenMatches\(/);
  assert.match(code, /if \(!ownerMatches\) return null/);

  // The basket itself is compared, not merely its total — swapping one item for
  // another at the same price leaves the total identical.
  assert.match(code, /storedBasket !== basketFingerprint\(input\.lines\)/);

  // Stripe has the last word on whether the session can still be paid.
  assert.match(code, /session\.status === "open" && session\.amount_total === input\.totalCents/);
});

test("direct checkout still takes no monetary field from the client", () => {
  // The property the reuse work must not have eroded: the total it compares
  // against is the server's own, never a number the browser sent.
  const code = stripComments(directCheckout);
  for (const field of ["amount", "total", "price", "discountCents", "shippingCents", "totals", "subtotal"]) {
    assert.doesNotMatch(code, new RegExp(`body\\.${field}\\b`), `checkout must not read ${field} from the client`);
  }
  assert.match(code, /const totalCents = plan\.totals\.totalCents/);
});
