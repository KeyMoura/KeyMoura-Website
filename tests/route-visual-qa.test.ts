import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Route-level visual QA (pass 3.1).
 *
 * The 3.0 pass fixed shared systems. This one went route by route and found
 * that consuming a corrected shared component is not the same as being
 * correct: several pages predate the framework and draw their own borders,
 * their own pills and their own page chrome, so an owner who changes the
 * Border colour sees most of the application move and a few screens stay put.
 *
 * Each assertion below is a defect that was measured in the browser, not a
 * style preference.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const globalsCss = read("src/app/globals.css");

/** Colours that bypass the theme entirely. */
const THEME_BYPASS = /border-white\/|divide-white\/|bg-white\/5\b|border-zinc-\d|divide-zinc-\d/;

// ---------------------------------------------------------------------------
// Theme reach
// ---------------------------------------------------------------------------

test("audited routes draw their lines with the themed border, not a fixed one", () => {
  /*
   * Each of these rendered a rule the Border appearance setting could not
   * move: the production queue used `white/10` over a `white/5` header, the
   * audit log used `zinc-800`, the order lifecycle panel and the analytics
   * workspace used `divide-white/10`.
   */
  const routes = [
    "src/app/staff/production/page.tsx",
    "src/app/staff/audit/page.tsx",
    "src/components/staff/OrderLifecyclePanel.tsx",
    "src/components/staff/AnalyticsWorkspace.tsx",
    "src/components/account/AccountNav.tsx",
  ];
  for (const route of routes) {
    const source = read(route);
    const offenders = (source.match(new RegExp(THEME_BYPASS, "g")) ?? []).slice(0, 4);
    assert.deepEqual(offenders, [], `${route} still paints a line the theme cannot reach`);
  }
});

test("the support conversation keeps its themed surfaces and its distinct internal note", () => {
  const source = read("src/app/staff/support/[id]/page.tsx");
  // Customer and system messages follow the theme…
  assert.match(source, /border-\[var\(--border\)\] bg-\[var\(--panel\)\]/);
  assert.doesNotMatch(source, /border-zinc-800 bg-black\/20/, "customer messages must not be fixed-colour again");
  // …while the internal note stays amber. Visual distinctness here is a
  // safety property, not decoration: a note that reads like a reply is a note
  // somebody eventually sends to a customer.
  assert.match(source, /border-amber-500\/40 bg-amber-500\/\[\.07\]/, "the internal note must stay visibly different");
  assert.match(source, /ui-badge ui-badge-warning/, "its label should be a real badge, not a hand-rolled pill");
});

// ---------------------------------------------------------------------------
// Shared primitives actually used
// ---------------------------------------------------------------------------

test("screen tables share one treatment", () => {
  assert.match(globalsCss, /\.ui-table\s*\{/, "there must be a single table rule to share");
  assert.match(globalsCss, /\.ui-table thead th\s*\{[^}]*border-bottom: 1px solid var\(--border\)/);
  assert.match(globalsCss, /\.ui-table tbody td\s*\{[^}]*border-top: 1px solid var\(--border\)/);
  assert.match(globalsCss, /\.ui-table :where\(th, td\)\.is-numeric\s*\{[^}]*tabular-nums/);

  for (const route of ["src/app/staff/production/page.tsx", "src/app/account/profile/page.tsx"]) {
    assert.match(read(route), /className="ui-table/, `${route} should use the shared table`);
  }
});

test("the audit log is built from the staff framework like every other staff page", () => {
  const source = read("src/app/staff/audit/page.tsx");
  assert.match(source, /from "@\/components\/staff\/StaffPage"/);
  assert.match(source, /<StaffPage>/);
  assert.match(source, /<PageHeader title="Audit log"/);
  // The shell already provides the container; the page must not add a second.
  assert.doesNotMatch(source, /mx-auto w-full max-w-6xl p-4/, "the page must not re-constrain inside the shell");
  // Statuses are badges, not bespoke 10px pills.
  assert.match(source, /<Badge tone="warning">Security<\/Badge>/);
  assert.doesNotMatch(source, /rounded border border-zinc-700/, "the actor pill must be a real badge");
});

test("a list entry whose control is nested still gets the shared separator", () => {
  assert.match(globalsCss, /\.staff-row-plain\s*\{[^}]*border-top: 1px solid var\(--border\)/);
  assert.match(globalsCss, /\.staff-row-plain:first-child\s*\{[^}]*border-top: 0/);
  assert.match(read("src/app/staff/audit/page.tsx"), /className="staff-row-plain"/);
});

// ---------------------------------------------------------------------------
// Geometry defects measured in the browser
// ---------------------------------------------------------------------------

test("the identity column stops stretching, so a status stays near what it describes", () => {
  /*
   * Measured on the production board, the support inbox and the fulfillment
   * queue: with a `1fr` identity track the status badges sat 795–1025px from
   * their title at 1440px, and drifted further on every wider screen. Capping
   * the track holds the distance constant — 456px at 1024, 1280 and 1440 —
   * and lands every status on the same x down the page.
   */
  assert.match(globalsCss, /@container staff-rows \(min-width: 46rem\)/, "the cap must engage from tablet widths up");
  const block = /@container staff-rows \(min-width: 46rem\) \{([\s\S]*?)\n  \}/.exec(globalsCss);
  assert.ok(block, "the wide-container block must exist");
  assert.match(block![1], /grid-template-columns: minmax\(0, 34rem\) auto/, "identity is capped rather than 1fr");
  assert.match(block![1], /justify-content: start/, "the columns group instead of spreading to the edges");
  // Every optional-slot combination needs its own cap, or it falls back to 1fr.
  for (const selector of ["staff-row-media", "staff-row-figure"]) {
    assert.ok(block![1].includes(selector), `${selector} needs a capped template too`);
  }
});

test("truncated directory text can actually truncate", () => {
  /*
   * `overflow` and `text-overflow` do not apply to a non-replaced inline box,
   * and both of these are `<span>`s — so the ellipsis silently did nothing. A
   * long name measured 374px inside a 267px column at 375px and was hard-clipped
   * mid-character by the list's own `overflow: hidden`.
   */
  for (const rule of ["staff-person-name", "staff-person-email"]) {
    const match = new RegExp(`\\.${rule}\\s*\\{([^}]*)\\}`).exec(globalsCss);
    assert.ok(match, `${rule} must have a rule`);
    assert.match(match![1], /display: block/, `${rule} must not be inline, or its ellipsis does nothing`);
    assert.match(match![1], /text-overflow: ellipsis/);
  }
});

test("the harness renders the real page compositions, not lookalikes", () => {
  const surfaces = read("src/app/dev/visual/surfaces.tsx");
  // It must import the real components rather than re-implementing them.
  assert.match(surfaces, /from "@\/components\/staff\/StaffPage"/);
  assert.match(surfaces, /from "@\/components\/ui\/DesignSystem"/);
  // And it must stay dev-only, like the harness page it belongs to.
  assert.match(read("src/app/dev/visual/page.tsx"), /process\.env\.NODE_ENV === "production"\) notFound\(\)/);
  for (const probe of ["production-board", "production-table", "audit", "directory", "support-inbox", "support-thread", "analytics", "automation", "fulfillment"]) {
    assert.ok(surfaces.includes(probe), `the harness must cover ${probe}`);
  }
});
