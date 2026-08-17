import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * Comments in this codebase name what was removed, so a `doesNotMatch` that
 * reads them finds the very string it is asserting the absence of.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const css = read("src/app/globals.css");
const homeSections = read("src/components/home/HomeSections.tsx");

/** Every staff surface that renders a queue with filters. */
const STAFF_QUEUES = [
  "src/app/staff/orders/page.tsx",
  "src/app/staff/fulfillment/page.tsx",
  "src/app/staff/support/page.tsx",
  "src/app/staff/production/page.tsx",
  "src/app/staff/inventory/page.tsx",
  "src/app/staff/users/page.tsx",
  "src/app/staff/audit/page.tsx",
] as const;

// ---------------------------------------------------------------------------
// One control height
// ---------------------------------------------------------------------------

test("there is one derived control height, and it follows density", () => {
  assert.match(css, /--control-height: calc\(1\.5rem \+ \(2 \* var\(--control-pad-y\)\) \+ 2px\);/);
  // Density changes `--control-pad-y`, so a derived height moves with it. A
  // literal `2.875rem` would have frozen every control at comfortable spacing.
  assert.match(css, /\[data-density="compact"\] \{ --control-pad-y: [\d.]+rem; \}/);
});

test("every field-shaped control lands on that height", () => {
  for (const selector of [/\.ui-input \{[^}]*min-height: var\(--control-height\)/, /\.ui-select-trigger \{[^}]*min-height: var\(--control-height\)/]) {
    assert.match(css, selector);
  }
  // The sitewide `select` rule is the one that used to break this: it carried
  // hard-coded geometry with `!important`, so it beat `.ui-input` and rendered
  // 8px shorter and 4px less round than the input beside it.
  const selectRule = css.match(/^\s*select \{[^}]*\}/m)?.[0] ?? "";
  assert.ok(selectRule, "the sitewide select rule must still exist");
  assert.match(selectRule, /min-height: var\(--control-height\)/);
  assert.match(selectRule, /border-radius: var\(--control-radius\)/);
  assert.match(selectRule, /padding: var\(--control-pad-y\)/);
  assert.doesNotMatch(selectRule, /border-radius: 0\.5rem/, "a literal radius ignores the Appearance setting");
  assert.doesNotMatch(selectRule, /padding: 0\.5rem 2rem 0\.5rem 0\.75rem/);
  // The radius must be overridable, so a component can shape its own corners —
  // the navbar's scope selector asks for a left-rounded edge and was overruled.
  assert.doesNotMatch(selectRule, /border-radius: var\(--control-radius\) !important/);
});

test("the navbar scope selector keeps its own height and its own corners", () => {
  const scope = css.match(/\.storefront-search-scope \{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.ok(scope);
  // `align-self: stretch` is what sizes it, so the sitewide floor must not apply.
  assert.match(scope, /align-self: stretch/);
  assert.match(scope, /min-height: 0/);
  assert.match(scope, /border-radius: var\(--control-radius\) 0 0 var\(--control-radius\)/);
});

// ---------------------------------------------------------------------------
// The filter toolbar
// ---------------------------------------------------------------------------

test("the filter toolbar aligns its controls to one bottom edge", () => {
  // `center` put a labelled `Field` and an unlabelled search box on different
  // baselines, which is the misalignment reported on /staff/fulfillment: three
  // bottom edges in one row.
  assert.match(css, /\.staff-toolbar \{[^}]*align-items: flex-end/);
  assert.doesNotMatch(css, /\.staff-toolbar \{[^}]*align-items: center/);
});

test("a button in a filter row is the same height as the fields beside it", () => {
  assert.match(css, /\.staff-toolbar > \.ui-btn,\s*\n\s*\.staff-filter-panel \.ui-btn \{ min-height: var\(--control-height\); \}/);
});

test("every staff queue uses the shared toolbar rather than its own row", () => {
  for (const path of STAFF_QUEUES) {
    assert.match(read(path), /className="staff-toolbar/, `${path} must use .staff-toolbar`);
  }
});

// ---------------------------------------------------------------------------
// Filter pills
// ---------------------------------------------------------------------------

test("every staff queue expresses a saved view as the same pill", () => {
  for (const path of STAFF_QUEUES) {
    const source = read(path);
    assert.match(source, /className="staff-view"/, `${path} must use the .staff-view pill`);
  }
});

test("no staff queue styles a filter as a button any more", () => {
  // /staff/support rendered its seven views as `ui-btn ui-btn-primary` /
  // `ui-btn-secondary` with padding overrides — a filter wearing the treatment
  // every other page reserves for its actions, and shouting when selected.
  for (const path of STAFF_QUEUES) {
    const source = stripComments(read(path));
    assert.doesNotMatch(
      source,
      /ui-btn-(primary|secondary)[^"']*!px-/,
      `${path} styles a filter like an action button`
    );
  }
});

test("the pill's active state is not colour alone", () => {
  // `aria-pressed` carries the state for anyone who cannot see the tint, and
  // the tint is accompanied by a border change.
  const rule = css.match(/\.staff-view\[aria-current="page"\], \.staff-view\[aria-pressed="true"\] \{[^}]*\}/)?.[0] ?? "";
  assert.ok(rule);
  assert.match(rule, /border-color:/);
  assert.match(rule, /background:/);
  for (const path of STAFF_QUEUES) {
    const source = read(path);
    if (!source.includes('className="staff-view"')) continue;
    assert.match(source, /aria-pressed=|aria-current=/, `${path} must carry the state in an attribute`);
  }
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

test("pagination is one family: a named nav on the shared toolbar", () => {
  for (const path of ["src/app/staff/orders/page.tsx", "src/app/staff/inventory/page.tsx", "src/app/staff/support/page.tsx", "src/app/staff/audit/page.tsx"]) {
    const source = read(path);
    assert.match(
      source,
      /<nav className="staff-toolbar justify-between" aria-label="Pagination">/,
      `${path} must use the shared pagination shell`
    );
  }
});

test("support pages by Previous/Next, because its sort is not always time", () => {
  const support = read("src/app/staff/support/page.tsx");
  const stripped = stripComments(support);
  assert.match(stripped, />\s*Previous\s*</);
  assert.match(stripped, />\s*Next\s*</);
  assert.doesNotMatch(stripped, />\s*Newer\s*</);
});

test("audit keeps Newest/Older, which its cursor paging genuinely justifies", () => {
  // The one place the wording differs. The treatment does not.
  const audit = stripComments(read("src/app/staff/audit/page.tsx"));
  assert.match(audit, />\s*Newest\s*</);
  assert.match(audit, />\s*Older\s*</);
});

// ---------------------------------------------------------------------------
// The page header
// ---------------------------------------------------------------------------

test("every staff queue opens with the shared page header", () => {
  for (const path of STAFF_QUEUES) {
    assert.match(read(path), /<PageHeader\b/, `${path} must use PageHeader`);
  }
});

// ---------------------------------------------------------------------------
// Homepage
// ---------------------------------------------------------------------------

test("the footer's lead-in is conditional on what the page ends with", () => {
  assert.match(css, /\.site-footer \{[^}]*margin-top: 4rem/);
  assert.match(css, /main:has\(> \.page-closing-band:last-child\) \+ \.site-footer \{ margin-top: 0; \}/);
});

test("the homepage's last band declares that it closes the page", () => {
  assert.match(homeSections, /className="home-close page-closing-band"/);
  // And it is genuinely last: HomeFinalCta is rendered unconditionally, after
  // every optional band.
  const page = read("src/app/page.tsx");
  const finalCta = page.lastIndexOf("<HomeFinalCta />");
  assert.ok(finalCta > 0, "the closing band must be rendered");
  for (const section of ["HomeRecentWork", "HomeAssurances", "HomeProcess", "HomeMaking"]) {
    assert.ok(page.indexOf(`<${section}`) < finalCta, `${section} must come before the closing band`);
  }
  assert.doesNotMatch(
    page.slice(finalCta + "<HomeFinalCta />".length),
    /<Home[A-Z]/,
    "nothing may render after the closing band"
  );
});

test("the gap is closed by removing it, not by pulling the footer up", () => {
  // An arbitrary negative margin would have hidden the symptom and broken every
  // other page's spacing with it.
  const rule = css.match(/main:has\(> \.page-closing-band:last-child\) \+ \.site-footer \{[^}]*\}/)?.[0] ?? "";
  assert.ok(rule);
  assert.doesNotMatch(rule, /margin-top: -/);
});

test("the closing band still paints its own space, so removing the gap leaves none", () => {
  assert.match(css, /\.home-close \{[^}]*padding-block: clamp\(/);
  assert.match(css, /\.home-close \{[^}]*border-top: 1px solid var\(--border\)/);
});

// ---------------------------------------------------------------------------
// The search field rule
// ---------------------------------------------------------------------------

test("desktop shows the passive icon and drops the submit button", () => {
  const desktop = css.match(/@media \(min-width: 1024px\) \{\s*\.storefront-search-icon,[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.ok(desktop, "the desktop rule must exist");
  assert.match(desktop, /\.storefront-search-icon,\s*\n\s*\.commerce-search-icon \{ --fa-display: block; \}/);
  assert.match(desktop, /\.storefront-search-submit,\s*\n\s*\.commerce-search-submit \{ display: none; \}/);
  // The field takes the width back rather than leaving a hole.
  assert.match(desktop, /\.commerce-search \{ grid-template-columns: minmax\(0, 1fr\); \}/);
});

test("mobile drops the passive icon and keeps the button at a real touch size", () => {
  assert.match(css, /\.storefront-search-icon,\s*\n\s*\.commerce-search-icon \{ --fa-display: none; \}/);
  const submit = css.match(/\.storefront-search-submit \{\s*\n\s*margin: 0;[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.ok(submit, "the mobile submit rule must exist");
  assert.match(submit, /min-width: 2\.75rem/);
  assert.match(submit, /margin: 0;/, "the desktop inset would cap it below 44px");
});

test("Enter still submits: every search field is a form with a real submit control", () => {
  for (const [path, formPattern] of [
    ["src/components/nav/StorefrontSearch.tsx", /<form[\s\S]{0,400}?onSubmit=\{submit\}/],
    ["src/components/catalog/CommerceSearch.tsx", /<form[\s\S]{0,400}?onSubmit=\{\(event\) => \{/],
  ] as const) {
    const source = read(path);
    assert.match(source, formPattern, `${path} must be a form`);
    assert.match(source, /<button\s+type="submit"/, `${path} must keep a submit button in the DOM`);
    // Hidden with CSS, never `disabled` — a disabled default button stops
    // implicit submission, which is the whole behaviour being preserved.
    assert.doesNotMatch(source, /<button\s+type="submit"[^>]*\bdisabled\b/);
  }
});

test("the responsive rule lives in the shared stylesheet, not in a route", () => {
  // The brief's "no route-specific hacks": no page may hide its own search icon.
  for (const path of [
    "src/components/nav/StorefrontSearch.tsx",
    "src/components/catalog/CommerceSearch.tsx",
    "src/app/account/orders/page.tsx",
  ]) {
    const source = stripComments(read(path));
    assert.doesNotMatch(
      source,
      /(lg:hidden|hidden lg:|max-lg:hidden)[^"']*search/i,
      `${path} must not gate its search icon in markup`
    );
  }
});

// ---------------------------------------------------------------------------
// Support and fulfillment as siblings
// ---------------------------------------------------------------------------

test("support and fulfillment share every control primitive", () => {
  const support = read("src/app/staff/support/page.tsx");
  const fulfillment = read("src/app/staff/fulfillment/page.tsx");
  for (const primitive of ["staff-toolbar", "staff-view", "PageHeader"]) {
    assert.match(support, new RegExp(primitive), `support must use ${primitive}`);
    assert.match(fulfillment, new RegExp(primitive), `fulfillment must use ${primitive}`);
  }
  // The row surface reaches both, by two spellings of the same thing: support
  // through the `Rows` component, fulfillment through the class it renders.
  for (const [name, source] of [["support", support], ["fulfillment", fulfillment]] as const) {
    assert.ok(
      /<Rows>/.test(source) || /className="staff-rows"/.test(source),
      `${name} must render the shared row surface`
    );
  }
});

test("support's search is a form, so Enter is a submit rather than a key handler", () => {
  const support = read("src/app/staff/support/page.tsx");
  assert.match(support, /<form\s*\n\s*className="staff-toolbar"/);
  assert.match(support, /<button type="submit" className="ui-btn ui-btn-secondary text-sm">/);
  assert.doesNotMatch(stripComments(support), /event\.key === "Enter"/, "the form does this now");
});

test("fulfillment keeps its labelled selects, which the toolbar now aligns", () => {
  // The fix was the row, not the labels: the brief asked for a shared baseline
  // and explicitly allowed the labels to stay above the selects.
  const fulfillment = read("src/app/staff/fulfillment/page.tsx");
  assert.match(fulfillment, /<Field label="Method"/);
  assert.match(fulfillment, /<Field label="Sort"/);
  // And no pixel nudge was added to paper over the misalignment.
  assert.doesNotMatch(stripComments(fulfillment), /className="[^"]*\bmt-\[|translate-y-/);
});
