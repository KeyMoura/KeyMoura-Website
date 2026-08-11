import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { APPEARANCE_TASK_SECTIONS, APPEARANCE_TASKS, searchAppearanceTasks } from "../src/theme/appearanceTasks.ts";
import { PRIMARY_STAFF_NAV_ITEMS, visibleStaffNav } from "../src/lib/staffNavigation.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/* ---------------------------------------------------------------- settings */

test("the Sentry connection test is not a setting", () => {
  const settings = read("src/app/staff/settings/page.tsx");
  /*
   * It used to render as a ninth block on the settings directory, under four
   * headings of real configuration — a button whose entire job is to throw an
   * error, beside "Commerce" and "Appearance". It is a diagnostic, so it lives
   * on Integration health, the page that already answers "is this external
   * service actually working" for every other service.
   */
  assert.doesNotMatch(settings, /SentryTestPanel/, "diagnostics must not appear on the settings index");

  const integrations = read("src/app/staff/integrations/page.tsx");
  assert.match(integrations, /SentryTestPanel/, "the test moved to Integration health, it was not deleted");
  // Its gate is unchanged, so the move grants nobody new access.
  assert.match(integrations, /permissions\.has\("security\.view"\)/);
});

test("Sentry monitoring itself is untouched", () => {
  // The panel is UI. Removing it from settings must not remove error reporting.
  assert.match(read("src/components/staff/SentryTestPanel.tsx"), /@sentry\/nextjs/);
  for (const file of ["sentry.server.config.ts", "sentry.edge.config.ts", "instrumentation.ts"]) {
    assert.ok(read(file).length > 0, `${file} must still exist`);
  }
});

test("settings pages name themselves before their data arrives", () => {
  /*
   * Measured on the running pages: Email, Commerce and Automation each rendered
   * a bare `LoadingState` from an early return placed *above* their
   * `PageHeader`, so for the whole load the document had no `<h1>` — while
   * Audit and Reconciliation, which return their header first, did.
   *
   * The header may only be drawn after the permission check, so each page now
   * has an access gate, then a titled loading state.
   */
  for (const [path, title] of [
    ["src/app/staff/settings/commerce/page.tsx", "Commerce"],
    ["src/app/staff/settings/automation/page.tsx", "Automation"],
    ["src/app/staff/emails/page.tsx", "Email"],
  ] as const) {
    const source = read(path);
    const header = source.indexOf("<PageHeader");
    const denied = source.indexOf("AccessDeniedCard message");
    assert.ok(header > 0, `${path} must render a PageHeader`);
    assert.ok(denied > 0 && denied < header, `${path} must check access before naming itself`);
    assert.match(source, new RegExp(`title="${title}"`));
    // The description is written once and shared by both headers.
    assert.match(source, /_DESCRIPTION\b/, `${path} must not duplicate its description string`);
  }
});

/* -------------------------------------------------------------- appearance */

test("the appearance editor groups by where a setting appears, not by token family", () => {
  /*
   * The token map's own axis (`APPEARANCE_GROUPS`: brand / buttons / badges /
   * surfaces / text / navbar) is an implementation grouping and is read only by
   * `appearance-token-map.test.ts`. The editor renders task *sections*, which
   * are named after places on the storefront.
   */
  const ids = APPEARANCE_TASK_SECTIONS.map((section) => section.id);
  for (const expected of ["brand", "buttons", "cards", "navigation", "forms"]) {
    assert.ok(ids.includes(expected as never), `the editor must keep a "${expected}" section`);
  }
  // Every section has something in it — an empty heading is worse than none.
  for (const section of APPEARANCE_TASK_SECTIONS) {
    assert.ok(
      APPEARANCE_TASKS.some((task) => task.section === section.id),
      `the "${section.id}" section renders nothing`
    );
  }
  // Every task is filed under a section that exists.
  for (const task of APPEARANCE_TASKS) {
    assert.ok(ids.includes(task.section), `task ${task.id} is filed under an unknown section`);
  }
});

test("search still finds a control by what it is called on the storefront", () => {
  // The whole reason the search exists: "I can see the thing, I cannot find the
  // control". These are storefront words, not token names.
  for (const [term, expected] of [
    ["customizable", "customizable-badge"],
    ["cart", "advanced-count-badge"],
    ["price", "product-price"],
  ] as const) {
    const hits = searchAppearanceTasks(term).map((task) => task.id);
    assert.ok(hits.includes(expected), `searching "${term}" must find ${expected}`);
  }
  // An empty query returns everything rather than nothing.
  assert.equal(searchAppearanceTasks("").length, APPEARANCE_TASKS.length);
});

test("Advanced keeps the uncommon raw controls", () => {
  const advanced = APPEARANCE_TASKS.filter((task) => task.section === "advanced");
  assert.ok(advanced.length >= 5, "Advanced must still hold the uncommon controls");
  const page = read("src/app/staff/appearance/page.tsx");
  // Still a disclosure, and still opened by a search that matches inside it.
  assert.match(page, /<details className="ui-card p-4" open=\{searching\}>/);
});

test("the preview can take you to the setting behind what it shows", () => {
  const page = read("src/app/staff/appearance/page.tsx");
  assert.match(page, /function jumpToAppearanceTask/);
  // Each of the three steps that make the jump actually land.
  assert.match(page, /closest\("details"\)\?\.setAttribute\("open", ""\)/, "must open a collapsed ancestor");
  assert.match(page, /scrollIntoView/);
  assert.match(page, /\.focus\(\{ preventScroll: true \}\)/, "must move focus, not only scroll");
  assert.match(page, /setColorQuery\(""\)/, "must clear a filter that could hide the target");
  // The anchors it jumps to exist, and are focusable.
  assert.match(page, /id=\{`appearance-\$\{task\.id\}`\}/);
  assert.match(page, /tabIndex=\{-1\}/);

  // Every declared jump target is a real task id.
  const targets = [...page.matchAll(/jumpTo="([a-z0-9-]+)"/g)].map((match) => match[1]);
  assert.ok(targets.length >= 5, "the preview blocks should offer jumps");
  const known = new Set(APPEARANCE_TASKS.map((task) => task.id));
  for (const target of targets) assert.ok(known.has(target), `jumpTo="${target}" is not a task`);
});

/* -------------------------------------------------------------- navigation */

test("this pass did not disturb the staff navigation", () => {
  /*
   * The sidebar, its scrolling, its collapse behaviour and its permission
   * filtering were built in earlier passes and are deliberately untouched here.
   * This asserts the properties that a careless edit to a nearby file would
   * break.
   */
  /*
   * The ceiling itself is asserted by `tests/staff-navigation.test.ts`, which
   * owns that rule. Restating the number here would be a second source of truth
   * that can disagree with the first — this only checks that the pass did not
   * empty the primary list out.
   */
  assert.ok(PRIMARY_STAFF_NAV_ITEMS.length > 0);

  const nav = read("src/components/staff/StaffNav.tsx");
  assert.match(nav, /staff-nav-groups/, "the group list is still its own scroll container");
  assert.match(nav, /aria-pressed=\{isCompact\}/, "collapse is still a toggle");
  assert.match(nav, /staff-nav-tip/, "collapsed tooltips are still rendered outside the scroller");

  // Permission filtering still refuses everything to a viewer with nothing.
  assert.deepEqual(visibleStaffNav(new Set()), []);
  // And a single-permission viewer sees only what that permission opens.
  const hrefs = visibleStaffNav(new Set(["orders.view"])).flatMap((group) =>
    group.items.map((item) => item.href)
  );
  assert.ok(hrefs.includes("/staff/orders"));
  assert.ok(!hrefs.includes("/staff/appearance"), "navigation visibility is not authorization, but it must not over-offer");
});
