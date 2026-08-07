import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SORTS, emptyFilters } from "../src/lib/staff/orderFilters.ts";
import { buildQueryPlan } from "../src/lib/staff/orderQueryPlan.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("staff order queue supports useful independent sort modes", () => {
  const page = read("src/app/staff/orders/page.tsx");
  for (const label of ["Recently updated", "Newest orders", "Oldest orders", "Highest priority", "Target date", "Highest price"]) {
    assert.match(page, new RegExp(label));
  }
  /*
   * Sorting is server-authoritative now, so `.toSorted(` — which this used to
   * pin — is the wrong property: it could only ever have sorted the rows the
   * browser happened to hold, which was the whole page's worth of orders.
   *
   * Re-pointed and made stricter: every offered sort must resolve to a real
   * database ordering, and each must carry a stable tiebreak. Sorting a page at
   * a time without one lets two rows sharing a sort key swap places between
   * page 1 and page 2, so a row can be seen twice and another never.
   */
  assert.doesNotMatch(page, /\.toSorted\(/, "sorting a single page in the browser reorders only that page");
  for (const sort of SORTS) {
    const order = buildQueryPlan({ ...emptyFilters(), sort }).order;
    assert.ok(order.length >= 1, `${sort} produces no database ordering`);
    assert.equal(order.at(-1)?.column, "id", `${sort} has no stable tiebreak`);
  }
});

test("customer order hub supports customer-safe sort modes", () => {
  const page = read("src/app/orders/page.tsx");
  for (const label of ["Recently updated", "Newest request", "Oldest request", "Needs attention first", "Price: high to low", "Price: low to high"]) {
    assert.match(page, new RegExp(label));
  }
  assert.doesNotMatch(page, /Highest priority/);
  assert.match(page, /created_at,updated_at/);
});

test("primary order and notification controls adapt for mobile", () => {
  const orders = read("src/app/orders/page.tsx");
  const notifications = read("src/app/notifications/page.tsx");
  assert.match(orders, /sm:w-auto/);
  assert.match(orders, /min-w-0 flex-1/);
  assert.match(notifications, /aria-pressed=\{showUnreadOnly\}/);
  assert.match(notifications, /min-h-11/);
});

test("account security exposes safe Supabase identity linking", () => {
  const page = read("src/app/account/page.tsx");
  assert.match(page, /getUserIdentities\(\)/);
  assert.match(page, /linkIdentity\(/);
  assert.match(page, /unlinkIdentity\(/);
  assert.match(page, /identities\.length < 2/);
  // The offered provider list moved into `connectedMethods` when Discord was
  // replaced by Facebook, so that an already-linked provider stays visible even
  // once it stops being offered. Asserted in `auth-providers.test.ts`, which
  // owns that rule now.
  assert.match(page, /connectedMethods/);
  assert.match(page, /`Connect \$\{label\}`/);
});

test("appearance is organized into focused sections with explicit publishing", () => {
  const page = read("src/app/staff/appearance/page.tsx");
  for (const label of ["Brand & business", "Logos & icons", "Labels & wording", "Colors & controls"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(page, /Reset this section/);
  assert.match(page, /Publish appearance/);
  assert.match(page, /You have unpublished appearance changes/);
  for (const label of ["Layout & type", "Components", "Tabs", "Cards & panels", "Inputs", "Navigation", "Content width"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(page, /"framed"/);
});

test("account tabs use the shared configurable tab system", () => {
  const page = read("src/app/account/page.tsx");
  assert.match(page, /className="ui-tabs/);
  assert.match(page, /className=\{`ui-tab/);
  assert.match(page, /role="tab"/);
  assert.match(page, /aria-selected=/);
});
