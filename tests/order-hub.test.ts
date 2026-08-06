import assert from "node:assert/strict";
import test from "node:test";
import { orderNeedsCustomerAction, orderNextStep, orderProgressIndex } from "../src/lib/orderHub.ts";
import { readFileSync } from "node:fs";

const ordersPage = readFileSync(new URL("../src/app/orders/page.tsx", import.meta.url), "utf8");
const orderDetailPage = readFileSync(new URL("../src/app/orders/[id]/page.tsx", import.meta.url), "utf8");

test("flags payment, information, and review actions", () => {
  assert.equal(orderNeedsCustomerAction({ status: "awaiting_payment", payment_status: "unpaid", agreed_price_cents: 2500 }), true);
  assert.equal(orderNeedsCustomerAction({ status: "needs_information", payment_status: "not_required", agreed_price_cents: null }), true);
  assert.equal(orderNeedsCustomerAction({ status: "customer_review", payment_status: "paid", agreed_price_cents: 2500 }), true);
  assert.equal(orderNeedsCustomerAction({ status: "final_review", payment_status: "paid", agreed_price_cents: 2500 }), true);
  assert.equal(orderNeedsCustomerAction({ status: "in_progress", payment_status: "paid", agreed_price_cents: 2500 }), false);
});

test("describes the next customer-facing step", () => {
  assert.equal(orderNextStep({ status: "requested", payment_status: "not_required", agreed_price_cents: null }), "Waiting for KeyMoura to review your request");
  assert.equal(orderNextStep({ status: "awaiting_payment", payment_status: "unpaid", agreed_price_cents: 1000 }), "Payment is ready");
  assert.equal(orderNextStep({ status: "ready", payment_status: "paid", agreed_price_cents: 1000, fulfillment_method: "pickup" }), "Ready for pickup");
});

test("maps exceptional statuses into the progress track", () => {
  assert.equal(orderProgressIndex("needs_information"), 0);
  assert.equal(orderProgressIndex("in_progress"), 4);
  assert.equal(orderProgressIndex("completed"), 7);
});

test("customer hub exposes actions, activity, fulfillment, files, and chat", () => {
  assert.match(ordersPage, /Needs attention/);
  assert.match(ordersPage, /Start a new request/);
  assert.match(orderDetailPage, /What happens next/);
  assert.match(orderDetailPage, /RequestSpecifications/);
  // The tracking control moved into `OrderFulfillmentStatus`, which renders for
  // every state rather than only once a tracking number exists. Asserting the
  // mount here and the button in its own suite keeps this test about the hub's
  // composition, which is what it is for.
  assert.match(orderDetailPage, /<OrderFulfillmentStatus/);
  assert.match(orderDetailPage, /Order chat/);
  assert.match(orderDetailPage, /Activity/);
});
