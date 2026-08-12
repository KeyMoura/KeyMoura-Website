import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { orderCustomerStatus } from "../src/lib/orderHub.ts";

const overview = readFileSync("src/app/account/page.tsx", "utf8");
const navigation = readFileSync("src/components/account/AccountNav.tsx", "utf8");

test("customer status projection replaces internal production language", () => {
  assert.equal(orderCustomerStatus("awaiting_production"), "Preparing your order");
  assert.equal(orderCustomerStatus("production_active"), "In production");
  assert.equal(orderCustomerStatus("qc"), "Final checks");
  assert.equal(orderCustomerStatus("blocked"), "Order in progress");
  assert.equal(orderCustomerStatus("in_progress", "ready_for_pickup"), "Ready for pickup");
});

test("overview distinguishes failures from empty activity", () => {
  assert.match(overview, /Unable to load your account/);
  assert.match(overview, /has not been counted as zero/);
  assert.match(overview, /Needs your attention/);
  assert.match(overview, /\.limit\(8\)/);
});

test("account navigation is compact and accessible", () => {
  assert.match(navigation, /aria-label="Customer account"/);
  assert.match(navigation, /aria-current/);
  assert.doesNotMatch(navigation, /Discord|Karma|Rank/);
});

test("guest email equality is explicitly not ownership", () => {
  assert.match(overview, /Matching an account email never attaches a guest order/);
  assert.doesNotMatch(overview, /\.eq\([^\n]*email/);
});
