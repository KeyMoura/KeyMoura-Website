import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

function tsxFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? tsxFiles(path) : entry.name.endsWith(".tsx") ? [path] : [];
  });
}

test("dashboard analytics and staff navigation use shared themed controls", () => {
  const dashboard = read("src/app/staff/page.tsx");
  const analytics = read("src/components/staff/AnalyticsWorkspace.tsx");
  const navigation = read("src/components/staff/StaffNav.tsx");

  /*
   * The dashboard no longer carries a range picker or metric tiles.
   *
   * Its revenue chart and four `MetricCard`s answered "how did the month go",
   * which is the Analytics page's question, and they sat above the stock list —
   * so a published product at zero stock was below the fold behind a decorative
   * graph. The dashboard now states its four workload numbers through `Facts`,
   * and links to Analytics for the trend.
   *
   * The invariant is unchanged and is what this test is for: both surfaces are
   * built from the shared, themed vocabulary and neither hard-codes a colour.
   */
  assert.match(dashboard, /from "@\/components\/staff\/StaffPage"/);
  assert.match(dashboard, /<Facts>/);
  assert.match(analytics, /Date range/);
  assert.match(analytics, /MetricCard/);
  for (const page of [dashboard, analytics]) {
    assert.doesNotMatch(page, /bg-red-\d+/);
  }
  assert.match(navigation, /className="staff-nav/);
  assert.match(navigation, /className="staff-nav-link/);
});

test("catalog actions use the shared primary secondary and destructive hierarchy", () => {
  const catalog = read("src/app/staff/catalog/page.tsx");

  /*
   * The editor's single save moved into the shared `SaveBar`, which owns the
   * primary button, so the page no longer declares a `primary` constant of its
   * own. The three-level hierarchy is still exactly the requirement: one
   * primary action, ghost secondaries, and a destructive class that is only
   * used for destruction.
   */
  assert.match(catalog, /<SaveBar/);
  assert.match(catalog, /const subtle = "ui-btn ui-btn-ghost/);
  assert.match(catalog, /ui-btn ui-btn-primary/);
  assert.match(catalog, /ui-btn ui-btn-danger/);
  assert.doesNotMatch(catalog, /const primary = .*text-brand-primary/);
  // Exactly one destructive control: "Delete permanently".
  assert.equal((catalog.match(/ui-btn ui-btn-danger/g) ?? []).length, 1);
});

test("customer and staff request flows share the same progress language", () => {
  // `/orders/new/page.tsx` is a server shell since Custom Project Request 3.0;
  // the stepper it renders lives in the wizard component.
  const customerRequest = read("src/components/orders/CustomRequestWizard.tsx");
  const staffProposal = read("src/app/staff/orders/new/page.tsx");

  for (const page of [customerRequest, staffProposal]) {
    assert.match(page, /ui-stepper/);
    assert.match(page, /ui-step/);
    assert.match(page, /ui-btn ui-btn-primary/);
  }
});

test("appearance offers visual choices and previews the complete component system", () => {
  const appearance = read("src/app/staff/appearance/page.tsx");
  const panels = read("src/app/staff/appearance/panels.tsx");
  const stage = read("src/app/staff/appearance/PreviewStage.tsx");
  const sections = read("src/app/staff/appearance/sections.tsx");

  /*
   * "Advanced palette" is long gone — it hid eleven colours including both
   * button texts behind a collapsed <details>, which is why nobody could find
   * the one that colours the catalog's custom-project button.
   *
   * 5.0 also retired the permanent preview column. The preview is now one
   * toggleable stage showing the surface the open section edits, so the things
   * asserted here moved from "all visible at once, always" to "reachable from
   * the section that owns them".
   */
  for (const expected of ["Corner shape", "Button shape", "Typeface"]) {
    assert.ok(panels.includes(expected), `missing appearance control: ${expected}`);
  }
  for (const expected of ["Add to Cart", "Customizable", "In stock", "Sold out"]) {
    assert.ok(
      stage.includes(expected) || panels.includes(expected),
      `missing appearance preview: ${expected}`
    );
  }
  for (const source of [appearance, panels, stage]) {
    assert.doesNotMatch(source, /Advanced palette/, "no colour may be hidden behind a disclosure");
    assert.doesNotMatch(source, /<MenuSelect/);
  }
  // Choice controls are still pressed buttons with an announced state.
  assert.match(sections, /aria-pressed=\{value === option\.value\}/);
});

test("every tab list and the linked info queues use the shared themed tab system", () => {
  const sources = tsxFiles("src").map((path) => ({ path, source: read(path) }));
  const tabLists = sources.filter(({ source }) => source.includes('role="tablist"'));

  assert.ok(tabLists.length > 0);
  for (const { path, source } of tabLists) {
    assert.match(source, /ui-tabs/, `${path} contains a one-off tab list`);
    assert.match(source, /ui-tab/, `${path} contains a one-off tab item`);
  }

  for (const path of ["src/app/staff/info/pending/page.tsx", "src/app/staff/info/updates/page.tsx"]) {
    const source = read(path);
    assert.match(source, /LinkTabs/);
    assert.doesNotMatch(source, /rounded-full border border-amber-400\/40/);
  }
});

test("staff action buttons no longer use the old amber mini-theme", () => {
  for (const path of tsxFiles("src/app/staff")) {
    const source = read(path);
    assert.doesNotMatch(source, /bg-amber-500\/20/, `${path} still contains a legacy amber action`);
    assert.doesNotMatch(source, /bg-brand-primary\/20/, `${path} still contains a legacy brand action`);
  }
});

test("every design-system class used in markup is actually defined", () => {
  // A `ui-btn-subtle` that never existed in globals.css rendered the
  // access-denied action as an unstyled link. Nothing should reference a
  // ui-* variant the stylesheet does not define.
  const css = read("src/app/globals.css");
  const defined = new Set(Array.from(css.matchAll(/\.(ui-[a-z-]+)/g), (match) => match[1]));
  const undefinedClasses = new Set<string>();

  for (const file of tsxFiles("src")) {
    for (const match of read(file).matchAll(/\b(ui-[a-z]+-[a-z-]+)\b/g)) {
      if (!defined.has(match[1])) undefinedClasses.add(`${match[1]} (${file})`);
    }
  }

  assert.deepEqual([...undefinedClasses], [], "markup references undefined design-system classes");
});

test("access-denied shells share one component", () => {
  const denied = read("src/components/AccessDenied.tsx");
  const card = read("src/components/AccessDeniedCard.tsx");
  assert.match(card, /import \{ AccessDenied \} from "@\/components\/AccessDenied"/);
  assert.match(denied, /role="alert"/);
  assert.match(denied, /backHref = "\/staff"/, "a generic component needs a generic default destination");
});
