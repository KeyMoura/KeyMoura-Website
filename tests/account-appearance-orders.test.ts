import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SORTS, emptyFilters } from "../src/lib/staff/orderFilters.ts";
import { buildQueryPlan } from "../src/lib/staff/orderQueryPlan.ts";
import { APPEARANCE_SETTINGS } from "../src/theme/appearanceMap.ts";
import { ownedKeys } from "../src/theme/appearanceTasks.ts";

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
  // Section names now describe the subject rather than the editor: "Colours"
  // instead of "Colors & controls", "Business details" instead of "Brand &
  // business". Every colour lives in one searchable section instead of being
  // split between "Colors & controls" and "Navbar".
  for (const label of ["Colours", "Shapes & density", "Business details", "Logos & icons", "Labels & wording"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(page, /Reset this section/);
  assert.match(page, /Publish appearance/);
  assert.match(page, /You have unpublished appearance changes/);
  for (const label of ["Layout & type", "Control shapes", "Tabs", "Cards & panels", "Inputs", "Content width"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(page, /"framed"/);
});

/**
 * Colour controls are no longer written at the call site.
 *
 * This is the assertion the old string matching was reaching for and could not
 * make: a control exists because the map declares it, so the page cannot ship a
 * colour picker with no explanation attached.
 */
test("every colour control is rendered from the declared task list", () => {
  /*
   * Re-pointed, and made stricter.
   *
   * The page used to render one control per colour, straight from
   * `APPEARANCE_SETTINGS`. It now renders one editor per *task* — the thing on
   * the screen — with that thing's two or three colours inside it, and the
   * partition is asserted to be total and disjoint in `appearance-tasks.test.ts`.
   * So "from the declared map" is still the property; the declaration simply
   * gained a layer that speaks the owner's vocabulary.
   */
  const page = read("src/app/staff/appearance/page.tsx");
  assert.match(page, /searchAppearanceTasks/, "the list is filtered by the shared search");
  assert.match(page, /APPEARANCE_TASK_SECTIONS/, "sections come from the declaration, not from the page");
  assert.match(page, /settingFor\(field\.key\)/, "each field resolves to its real map entry");

  // A hand-written colour field beside the declared ones would be a control with
  // no description and no search terms — exactly what these passes removed.
  assert.doesNotMatch(page, /function ColorField/, "there is no second, unexplained colour control");

  // Every colour still reaches a control, and no colour reaches two. Asserted
  // here as well as in the task suite because this is the test that would be
  // deleted if somebody decided the task layer had replaced the map.
  const owned = ownedKeys();
  assert.equal(new Set(owned).size, owned.length, "a colour with two controls");
  assert.equal(owned.length, APPEARANCE_SETTINGS.length, "a colour with no control");
});

test("account tabs use the shared configurable tab system", () => {
  const page = read("src/app/account/page.tsx");
  assert.match(page, /className="ui-tabs/);
  assert.match(page, /className=\{`ui-tab/);
  assert.match(page, /role="tab"/);
  assert.match(page, /aria-selected=/);
});
