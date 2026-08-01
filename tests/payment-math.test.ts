import assert from "node:assert/strict";
import test from "node:test";
import {
  checkoutAmountCents,
  remainingBalanceCents,
} from "../src/lib/paymentMath.ts";

test("uses the full remaining balance when a stale deposit is negative", () => {
  const order = {
    agreed_price_cents: 100,
    amount_paid_cents: 0,
    amount_refunded_cents: 0,
    deposit_amount_cents: -2400,
  };

  assert.equal(remainingBalanceCents(order), 100);
  assert.equal(checkoutAmountCents(order), 100);
});

test("an unpaid $1 order ignores a stale paid amount and remains payable", () => {
  const order = {
    agreed_price_cents: 100,
    amount_paid_cents: 2500,
    amount_refunded_cents: 0,
    deposit_amount_cents: -2400,
    payment_status: "unpaid",
  };

  assert.equal(remainingBalanceCents(order), 100);
  assert.equal(checkoutAmountCents(order), 100);
});

test("uses a valid deposit for the first payment", () => {
  const order = {
    agreed_price_cents: 5500,
    amount_paid_cents: 0,
    amount_refunded_cents: 0,
    deposit_amount_cents: 2500,
  };

  assert.equal(checkoutAmountCents(order), 2500);
});

test("collects only the remaining balance after a deposit", () => {
  const order = {
    agreed_price_cents: 5500,
    amount_paid_cents: 2500,
    amount_refunded_cents: 0,
    deposit_amount_cents: 2500,
  };

  assert.equal(checkoutAmountCents(order), 3000);
});
