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
  /*
   * Both halves moved in pass 4.0. The destinations come from
   * `accountSectionNav` so the header's account menu and these tabs agree, and
   * the treatment comes from `SectionNav` so this reads as navigation rather
   * than as the row of filters directly below it. `aria-label` and
   * `aria-current` still have to be here — they moved into the shared
   * component, so this now asserts they are passed to it.
   */
  assert.match(navigation, /ariaLabel="Customer account"/);
  assert.match(navigation, /accountSectionNav/);
  assert.match(navigation, /SectionNav/);
  assert.doesNotMatch(navigation, /Discord|Karma|Rank/);

  const sectionNav = readFileSync("src/components/ui/SectionNav.tsx", "utf8");
  assert.match(sectionNav, /aria-current=\{current \? "page" : undefined\}/);
  assert.match(sectionNav, /aria-label=\{ariaLabel\}/);
});

test("guest email equality is explicitly not ownership", () => {
  assert.match(overview, /Matching an account email never attaches a guest order/);
  assert.doesNotMatch(overview, /\.eq\([^\n]*email/);
});
