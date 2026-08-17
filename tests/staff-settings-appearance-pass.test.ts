import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  APPEARANCE_SEARCH_INDEX,
  APPEARANCE_SECTIONS,
  searchAppearance,
  sectionForTask,
} from "../src/theme/appearanceSections.ts";
import { SECTION_TOGGLES } from "../src/theme/homepage.ts";
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

test("the uncommon controls are filed by subject, not hidden behind a disclosure", () => {
  /*
   * ## What changed in 5.0, and why the old assertion had to go
   *
   * `APPEARANCE_TASKS` still files seven tasks under an `advanced` section, and
   * that is still the right call *for the task data*: the page fade, body links,
   * navbar hover, the two utility-button tasks, the count badge and the menu
   * panels genuinely are the rarely-touched ones.
   *
   * What was wrong was the editor treating "rare" as a place. Five of those
   * seven are navbar states, and filing them behind a collapsed disclosure in a
   * different section is what made the obvious question — what is the
   * difference between a link at rest, under the pointer, and on the page you
   * are on — impossible to answer without knowing to open a `<details>` first.
   *
   * So the *presentation* now files them by subject. `sectionForTask` is the
   * mapping, and this asserts that none of them landed back in a section a
   * shop owner would never think to open.
   */
  const advanced = APPEARANCE_TASKS.filter((task) => task.section === "advanced");
  assert.ok(advanced.length >= 5, "the task data still records which controls are uncommon");

  for (const task of advanced) {
    const section = sectionForTask(task.id);
    assert.notEqual(section, "advanced", `${task.id} must be filed by subject, not by rarity`);
    assert.ok(
      APPEARANCE_SECTIONS.some((entry) => entry.id === section),
      `${task.id} landed in an unknown section`
    );
  }

  // The five navbar states belong with the navbar.
  for (const id of [
    "advanced-navbar-hover",
    "advanced-utility-buttons",
    "advanced-utility-hover",
    "advanced-count-badge",
    "advanced-menus",
  ]) {
    assert.equal(sectionForTask(id), "navigation", `${id} is a navbar control`);
  }

  /*
   * And the Advanced *section* that remains is a read-only reference rather
   * than a drawer of settings. The brief was explicit: the main editor must not
   * be a CSS-variable inspector, and a developer-oriented token reference is
   * welcome behind Advanced. That is exactly what is there.
   */
  const panels = read("src/app/staff/appearance/panels.tsx");
  assert.match(panels, /function AdvancedPanel/);
  assert.match(panels, /setting\.variable/, "the reference must name the CSS variable");
  assert.match(panels, /Read-only/, "and must say that it is not where you edit");
});

test("search takes you to the setting itself, not just to its section", () => {
  /*
   * Widened from the preview's "Edit these" jump to the editor's search, which
   * is where this now matters most. The old search filtered the colour list in
   * place, so the six things this pass was asked to make easy — the
   * announcement message, the logo, the featured product, the hero image, the
   * site-name toggle, Add to cart — matched nothing at all, because none of
   * them is a colour.
   */
  const chrome = read("src/app/staff/appearance/EditorChrome.tsx");
  const page = read("src/app/staff/appearance/page.tsx");

  assert.match(chrome, /export function focusControl/);
  // Each of the three steps that make the jump actually land.
  assert.match(chrome, /closest\("details"\)\?\.setAttribute\("open", ""\)/, "must open a collapsed ancestor");
  assert.match(chrome, /scrollIntoView/);
  assert.match(chrome, /\.focus\(\{ preventScroll: true \}\)/, "must move focus, not only scroll");
  // Choosing a result opens the section that holds the control first; landing
  // on an element that is not rendered is a silent no-op.
  assert.match(page, /setSection\(target\)/);
  assert.match(page, /window\.setTimeout\(\(\) => focusControl\(anchor\), 0\)/);

  // The anchors are focusable, and both ends agree on how the id is built.
  assert.match(chrome, /return `appearance-\$\{anchor\}`/);
  assert.match(chrome, /tabIndex=\{-1\}/);

  /*
   * Every search result points at a control the editor actually renders.
   *
   * This is the assertion that keeps the index honest: an entry naming an
   * anchor nobody draws sends the owner to a section where nothing happens and
   * nothing explains why, which is worse than not matching at all.
   */
  const rendered = new Set<string>();
  const sources = [
    page,
    chrome,
    read("src/app/staff/appearance/sections.tsx"),
    read("src/app/staff/appearance/panels.tsx"),
    read("src/app/staff/appearance/ColorControls.tsx"),
    read("src/app/staff/appearance/LogoUpload.tsx"),
  ].join("\n");

  for (const match of sources.matchAll(/anchor="([a-z0-9-]+)"/g)) rendered.add(match[1]);
  for (const match of sources.matchAll(/anchor=\{"([a-z0-9-]+)"\}/g)) rendered.add(match[1]);
  for (const match of sources.matchAll(/id="appearance-([a-z0-9-]+)"/g)) rendered.add(match[1]);
  // The colour tasks and the homepage toggles are rendered from their lists.
  for (const task of APPEARANCE_TASKS) rendered.add(`task-${task.id}`);
  for (const match of sources.matchAll(/appearance-homepage-section-\$\{toggle\.id\}/g)) {
    void match;
    for (const toggle of SECTION_TOGGLES) rendered.add(`homepage-section-${toggle.id}`);
  }

  const missing = APPEARANCE_SEARCH_INDEX.filter((entry) => !rendered.has(entry.anchor)).map(
    (entry) => entry.anchor
  );
  assert.deepEqual(missing, [], `search offers anchors nothing renders: ${missing.join(", ")}`);
});

test("search finds the things a shop owner actually types", () => {
  /*
   * The concrete cases from the brief. Each of these matched nothing before
   * this pass, because the search was a filter over the colour list.
   */
  const cases: [string, string][] = [
    ["announcement", "announcement-message"],
    ["logo", "brand-primary-logo"],
    ["add to cart", "commerce-cta"],
    ["featured product", "homepage-featured-product"],
    ["hero image", "homepage-hero-image"],
    ["navbar", "task-navbar"],
    ["site name", "brand-show-name"],
    ["favicon", "business-icons"],
    ["typeface", "type-font"],
  ];

  for (const [query, expected] of cases) {
    const results = searchAppearance(query);
    assert.ok(results.length > 0, `"${query}" must find something`);
    assert.ok(
      results.some((entry) => entry.anchor === expected),
      `"${query}" must find ${expected}; got ${results.map((entry) => entry.anchor).join(", ")}`
    );
  }

  // An empty query returns nothing rather than everything: the results are a
  // dropdown over the workspace, and opening it on focus with 60 rows in it
  // would cover the controls the owner is looking at.
  assert.deepEqual(searchAppearance(""), []);
  assert.deepEqual(searchAppearance("   "), []);
  assert.deepEqual(searchAppearance("zzzz-no-such-setting"), []);
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
