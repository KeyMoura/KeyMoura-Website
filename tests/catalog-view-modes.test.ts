import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CATALOG_DENSITIES,
  CATALOG_VIEWS,
  CATALOG_VIEW_KEY,
  CATALOG_VIEW_LABELS,
  CATALOG_VIEW_SHORT_LABELS,
  catalogViewAttribute,
  catalogViewScript,
  DEFAULT_CATALOG_VIEW,
  FOUR_COLUMN_MIN_WIDTH,
  isCatalogDensity,
  isCatalogView,
  parseCatalogView,
} from "../src/lib/commerce/catalogView.ts";

/**
 * The customer-visible result-layout control: `List | 2 | 3 | 4`.
 *
 * The interesting assertions are the ones about *where the layout decision
 * lives*. Persisting a column count is easy; persisting it without the page
 * reflowing after hydration is the part that goes wrong, and it goes wrong
 * silently — the tests below pin the mechanism (a pre-paint attribute and CSS,
 * never React state) rather than the appearance.
 *
 * That mechanism is what the list view rides on. A second component chosen from
 * the stored preference could not be chosen until hydration, so every visit
 * would paint cards and jump to rows; the rules here are what stop somebody
 * "simplifying" it into exactly that.
 */

const read = (path: string) => readFileSync(path, "utf8");
const globalsCss = read("src/app/globals.css");
const control = read("src/components/catalog/CatalogViewControl.tsx");
const browser = read("src/components/catalog/CatalogBrowser.tsx");
const layout = read("src/app/catalog/layout.tsx");
const card = read("src/components/ProductCard.tsx");

// ---------------------------------------------------------------------------
// The stored preference
// ---------------------------------------------------------------------------

test("desktop defaults to three columns", () => {
  assert.equal(DEFAULT_CATALOG_VIEW, 3);
  assert.match(globalsCss, /\.catalog-grid \{ grid-template-columns: repeat\(var\(--catalog-columns, 3\)/);
});

test("the offered views are List, 2, 3 and 4 — in that order", () => {
  assert.deepEqual([...CATALOG_VIEWS], ["list", 2, 3, 4]);
  // `list` is a view, not a density: it has a layout rather than a column count.
  assert.deepEqual([...CATALOG_DENSITIES], [2, 3, 4]);
  assert.ok(!(CATALOG_DENSITIES as readonly unknown[]).includes("list"));
  for (const columns of CATALOG_DENSITIES) {
    assert.ok(isCatalogDensity(columns));
    assert.match(globalsCss, new RegExp(`\\[data-catalog-density="${columns}"\\] \\{ --catalog-columns: ${columns}; \\}`));
  }
  assert.ok(isCatalogView("list"));
  assert.ok(!isCatalogDensity("list"));
});

test("one-across is called List, never 1", () => {
  // "1" describes a grid with one column, which is a card with empty space
  // beside it. The list view is a different layout and has to say so.
  assert.equal(CATALOG_VIEW_LABELS.list, "List view");
  assert.equal(CATALOG_VIEW_SHORT_LABELS.list, "List");
  assert.ok(!Object.values(CATALOG_VIEW_SHORT_LABELS).includes("1"));
  assert.ok(!Object.values(CATALOG_VIEW_LABELS).includes("One column"));
  // And the word is on screen, not only in the accessible name.
  assert.match(control, /className="catalog-view-word"/);
});

test("every option has a spoken label, not just a picture", () => {
  for (const value of [...CATALOG_VIEWS, "grid"]) {
    const label = CATALOG_VIEW_LABELS[String(value)];
    assert.ok(label && label.length > 3, `${value} needs a phrase a screen reader can read`);
  }
  assert.match(control, /<span className="sr-only">\{CATALOG_VIEW_LABELS\[key\]\}<\/span>/);
  assert.match(control, /aria-hidden="true"/);
});

test("a stored preference is parsed, and anything else falls back", () => {
  assert.equal(parseCatalogView("2"), 2);
  assert.equal(parseCatalogView("4"), 4);
  assert.equal(parseCatalogView("list"), "list");
  // `useStoredPreference` writes through JSON.stringify, so the quoted form has
  // to round-trip as well as the bare one.
  assert.equal(parseCatalogView('"4"'), 4);
  assert.equal(parseCatalogView('"list"'), "list");
  assert.equal(parseCatalogView("  3 "), 3);

  for (const corrupt of ["", "0", "1", "5", "99", "three", "grid", "{}", "null"]) {
    assert.equal(parseCatalogView(corrupt), DEFAULT_CATALOG_VIEW, corrupt);
  }
});

test("the key is unchanged, so an existing choice survives the upgrade", () => {
  // A customer who already picked 4 must not be silently reset by shipping a
  // list view. Same slot, one new value in it.
  assert.equal(CATALOG_VIEW_KEY, "km.catalog.density");
  assert.equal(parseCatalogView("4"), 4);
});

test("the preference is applied before first paint, not after hydration", () => {
  assert.ok(layout.includes("catalogViewScript"));
  assert.match(layout, /dangerouslySetInnerHTML=\{\{ __html: catalogViewScript \}\}/);
  assert.ok(catalogViewScript.includes(CATALOG_VIEW_KEY));
  assert.ok(catalogViewScript.startsWith("try{"), "a throw here must not take the catalog down");
  assert.ok(catalogViewScript.includes("catch(e){}"));
  // It only ever writes one of the four known values.
  assert.ok(catalogViewScript.includes("v==='list'||v==='2'||v==='3'||v==='4'"));
  assert.equal(catalogViewAttribute("list"), "list");
  assert.equal(catalogViewAttribute(4), "4");
});

test("the layout never reads React state for its shape", () => {
  // The control writes an attribute; CSS does the layout. If the results ever
  // took a class or a component choice from state, the pre-paint script would
  // be pointless and the list view would flash cards on every visit.
  assert.ok(browser.includes('className="catalog-grid"'));
  assert.ok(!/catalog-grid[^"]*\$\{/.test(browser), "the grid class must be static");
  assert.ok(!browser.includes("catalog-columns"), "the browser must not set the column variable itself");
  assert.ok(
    !/useStoredPreference|CATALOG_VIEW/.test(browser),
    "the browser must not read the view preference; only the control does"
  );
  // One card component for both layouts. A `view === "list" ? <A/> : <B/>` here
  // is the exact swap the attribute exists to avoid.
  assert.equal((browser.match(/<ProductCard/g) ?? []).length, 1);
});

test("four columns is clamped below 1280 rather than discarded", () => {
  assert.equal(FOUR_COLUMN_MIN_WIDTH, 1280);
  assert.match(
    globalsCss,
    /@media \(min-width: 1024px\) and \(max-width: 1279\.98px\) \{\s*\[data-catalog-density="4"\] \{ --catalog-columns: 3; \}/
  );
  // Clamped in CSS only: nothing rewrites the stored value, so widening the
  // window brings the fourth column back.
  assert.ok(!control.includes("innerWidth"), "the control must not second-guess the media query");
  assert.ok(!control.includes("matchMedia"));
});

// ---------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------

test("column counts are hidden where the grid has no choice, but List never is", () => {
  assert.match(
    globalsCss,
    /\.catalog-view-option\[data-view="2"\],\s*\.catalog-view-option\[data-view="3"\],\s*\.catalog-view-option\[data-view="4"\] \{ display: none; \}/
  );
  assert.match(globalsCss, /@media \(min-width: 1024px\) \{[\s\S]*?\.catalog-view-option\[data-view="3"\] \{ display: inline-flex; \}/);
  // The fourth option only exists at the width that honours it.
  assert.match(
    globalsCss,
    /@media \(min-width: 1280px\) \{\s*\.catalog-view-option\[data-view="4"\] \{ display: inline-flex; \}/
  );
  // `List` carries no width gate at all: one readable result at a time is most
  // useful precisely where a column count is meaningless.
  assert.ok(
    !/\.catalog-view-option\[data-view="list"\][^{]*\{[^}]*display:\s*none/.test(globalsCss),
    "List must be reachable at every width"
  );
});

test("below lg the group is a two-way switch that can be turned off again", () => {
  // A radio group whose only visible member is `List` is a switch with no way
  // back. `Grid` is the other half, and it swaps out from lg where the density
  // buttons say the same thing more precisely.
  assert.match(control, /data-view="grid"/);
  assert.match(globalsCss, /@media \(min-width: 1024px\) \{\s*\.catalog-view-option\[data-view="grid"\] \{ display: none; \}/);
  // It is not a fifth stored value.
  assert.ok(!(CATALOG_VIEWS as readonly unknown[]).includes("grid"));
  assert.equal(parseCatalogView("grid"), DEFAULT_CATALOG_VIEW);
  // Pressing it when a density is already stored keeps that density.
  assert.match(control, /onClick=\{\(\) => setView\(isGrid \? view : DEFAULT_CATALOG_VIEW\)\}/);
});

test("it is a radio group with one tab stop and arrow-key movement", () => {
  assert.match(control, /role="radiogroup"/);
  assert.match(control, /aria-label="Result layout"/);
  assert.match(control, /role="radio"/);
  assert.match(control, /aria-checked=\{checked\}/);
  assert.match(control, /tabIndex=\{checked \? 0 : -1\}/);
  assert.ok(control.includes("ArrowRight") && control.includes("ArrowLeft"));
});

test("arrows step over the options that are hidden at this width", () => {
  // Half the group is `display: none` at any width. Walking the static list
  // would move the selection onto a button that cannot take focus, leaving the
  // ring behind on the previous one.
  assert.match(control, /offsetParent !== null/);
  assert.ok(
    !/CATALOG_VIEWS\.indexOf\(view\)/.test(control),
    "movement must be read from the layout, not from the full list"
  );
});

test("option ids are generated, so two instances cannot collide", () => {
  assert.match(control, /const groupId = useId\(\)/);
  assert.ok(!control.includes("`catalog-density-${"), "ids must not be derived from the column count alone");
  assert.match(control, /groupRef\.current/);
  assert.ok(!control.includes("document.getElementById"));
});

test("the selected state is not colour alone", () => {
  const rule = globalsCss.slice(globalsCss.indexOf(".catalog-view-option.is-selected {"));
  const body = rule.slice(0, rule.indexOf("}"));
  assert.ok(body.includes("background"), body);
  assert.ok(body.includes("border-color"), body);
});

test("the view control sits with sorting, not with the category filters", () => {
  const toolbar = browser.slice(browser.indexOf("catalog-filter-controls"));
  assert.ok(toolbar.indexOf("<CatalogViewControl />") > 0);
  const rail = browser.slice(browser.indexOf("catalog-rail"), browser.indexOf("catalog-main"));
  assert.ok(!rail.includes("CatalogViewControl"), "layout is not a filter and must not join the rail");
});

// ---------------------------------------------------------------------------
// The list layout itself
// ---------------------------------------------------------------------------

test("the card is three sibling regions, so one DOM can be two layouts", () => {
  // The footer used to live inside the body. As a sibling it can be lifted into
  // a purchase column of its own without `display: contents` or a subgrid.
  const bodyStart = card.indexOf('<div className="product-card-body">');
  const bodyEnd = card.indexOf('<div className="product-card-footer">');
  assert.ok(bodyStart > 0 && bodyEnd > bodyStart, "the footer must follow the body");
  assert.ok(
    !card.slice(bodyStart, bodyEnd).includes("</div>\n      </div>"),
    "the footer must not be nested inside the body"
  );
});

test("list mode is a horizontal layout, not a one-column grid", () => {
  // `grid-template-columns: 1fr` on the stacked card is the thing this mode
  // exists instead of: a 4:3 photograph the width of the page.
  assert.match(
    globalsCss,
    /\[data-catalog-density="list"\] \.catalog-grid \.product-card \{\s*display: grid;/
  );
  assert.match(globalsCss, /grid-template-areas: "media body" "media footer";/);
  // And three real regions from lg, with the purchase column its own track.
  assert.match(globalsCss, /grid-template-columns: 15rem minmax\(0, 1fr\) minmax\(10rem, 14rem\);/);
  assert.match(globalsCss, /grid-template-areas: "media body footer";/);
});

test("list mode collapses to a stacked card below sm", () => {
  // 375px has no room for an image column and a text column that are both
  // usable, so the horizontal rules start at 640 and not before.
  const listRules = globalsCss.slice(globalsCss.indexOf('[data-catalog-density="list"] .catalog-grid {'));
  const horizontal = listRules.indexOf("grid-template-areas");
  const mediaQuery = listRules.indexOf("@media (min-width: 640px)");
  assert.ok(mediaQuery > 0 && mediaQuery < horizontal, "the horizontal layout must be gated at 640");
});

test("list mode is scoped to the catalog results", () => {
  // The attribute lives on <html> and survives a client-side navigation off the
  // catalog, so an unscoped rule would turn the homepage's featured products
  // into list rows on the way past.
  const rules = globalsCss.match(/\[data-catalog-density="list"\][^{]*\{/g) ?? [];
  assert.ok(rules.length > 0);
  for (const rule of rules) {
    assert.ok(rule.includes(".catalog-grid"), `unscoped list rule: ${rule}`);
  }
});

test("the description is the thing list mode shows more of", () => {
  assert.match(globalsCss, /\.product-card-description \{[^}]*line-clamp: 2;/);
  assert.match(
    globalsCss,
    /\[data-catalog-density="list"\] \.catalog-grid \.product-card-description \{\s*-webkit-line-clamp: 4;\s*line-clamp: 4;\s*\}/
  );
});

test("responsive fallbacks below the rail", () => {
  // One card on a phone, two on a tablet — neither is a density the customer
  // picks, because neither has room for an alternative.
  assert.match(globalsCss, /\.catalog-grid \{\s*display: grid;\s*gap: 1\.25rem;\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(globalsCss, /@media \(min-width: 640px\) \{\s*\.catalog-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
});

test("no track can overflow its row", () => {
  // Every column is `minmax(0, 1fr)`. A bare `1fr` has a min-content floor, so
  // one long product name would widen its track and push the grid into
  // horizontal overflow.
  const gridRules = globalsCss.match(/\.catalog-grid \{[^}]*grid-template-columns:[^;]*;/g) ?? [];
  assert.ok(gridRules.length >= 3, "expected the base, tablet and desktop rules");
  for (const rule of gridRules) {
    assert.ok(rule.includes("minmax(0, 1fr)"), rule);
  }
});
