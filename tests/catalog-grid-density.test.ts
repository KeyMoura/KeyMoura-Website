import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CATALOG_DENSITIES,
  CATALOG_DENSITY_KEY,
  CATALOG_DENSITY_LABELS,
  catalogDensityScript,
  DEFAULT_CATALOG_DENSITY,
  FOUR_COLUMN_MIN_WIDTH,
  isCatalogDensity,
  parseCatalogDensity,
} from "../src/lib/commerce/catalogDensity.ts";

/**
 * The customer-visible grid-density control.
 *
 * The interesting assertions are the ones about *where the layout decision
 * lives*. Persisting a column count is easy; persisting it without the page
 * reflowing after hydration is the part that goes wrong, and it goes wrong
 * silently — the tests below pin the mechanism (a pre-paint attribute and CSS,
 * never React state) rather than the appearance.
 */

const read = (path: string) => readFileSync(path, "utf8");
const globalsCss = read("src/app/globals.css");
const control = read("src/components/catalog/CatalogDensityControl.tsx");
const browser = read("src/components/catalog/CatalogBrowser.tsx");
const layout = read("src/app/catalog/layout.tsx");

test("desktop defaults to three columns", () => {
  assert.equal(DEFAULT_CATALOG_DENSITY, 3);
  assert.match(globalsCss, /\.catalog-grid \{ grid-template-columns: repeat\(var\(--catalog-columns, 3\)/);
});

test("two, three and four are the offered densities", () => {
  assert.deepEqual([...CATALOG_DENSITIES], [2, 3, 4]);
  for (const columns of CATALOG_DENSITIES) {
    assert.ok(isCatalogDensity(columns));
    assert.match(globalsCss, new RegExp(`\\[data-catalog-density="${columns}"\\] \\{ --catalog-columns: ${columns}; \\}`));
  }
});

test("each density has a spoken label, not just a number", () => {
  assert.deepEqual(CATALOG_DENSITY_LABELS, {
    2: "Two columns",
    3: "Three columns",
    4: "Four columns",
  });
  for (const label of Object.values(CATALOG_DENSITY_LABELS)) {
    assert.ok(control.includes("CATALOG_DENSITY_LABELS"), "labels must come from the shared map");
    assert.ok(label.length > 3, `${label} must be a phrase a screen reader can read`);
  }
  // The icon is decorative and the name is the sr-only text beside it.
  assert.match(control, /aria-hidden="true"/);
  assert.match(control, /<span className="sr-only">\{CATALOG_DENSITY_LABELS\[columns\]\}<\/span>/);
});

test("a stored preference is parsed, and anything else falls back", () => {
  assert.equal(parseCatalogDensity("2"), 2);
  assert.equal(parseCatalogDensity("4"), 4);
  // `useStoredPreference` writes through JSON.stringify, so the quoted form has
  // to round-trip as well as the bare one.
  assert.equal(parseCatalogDensity('"4"'), 4);
  assert.equal(parseCatalogDensity("  3 "), 3);

  for (const corrupt of ["", "0", "1", "5", "99", "three", "{}", "null"]) {
    assert.equal(parseCatalogDensity(corrupt), DEFAULT_CATALOG_DENSITY, corrupt);
  }
});

test("the preference is applied before first paint, not after hydration", () => {
  // The layout inlines the script; without it the grid renders three columns
  // and then reflows to the customer's four on every visit.
  assert.ok(layout.includes("catalogDensityScript"));
  assert.match(layout, /dangerouslySetInnerHTML=\{\{ __html: catalogDensityScript \}\}/);
  assert.ok(catalogDensityScript.includes(CATALOG_DENSITY_KEY));
  assert.ok(catalogDensityScript.startsWith("try{"), "a throw here must not take the catalog down");
  assert.ok(catalogDensityScript.includes("catch(e){}"));
  // It only ever writes one of the three known values.
  assert.ok(catalogDensityScript.includes("v==='2'||v==='3'||v==='4'"));
});

test("the grid never reads React state for its column count", () => {
  // The control writes an attribute; CSS does the layout. If the grid ever took
  // a style prop or a class from state, the pre-paint script would be pointless.
  assert.ok(browser.includes('className="catalog-grid"'));
  assert.ok(!/catalog-grid[^"]*\$\{/.test(browser), "the grid class must be static");
  assert.ok(!browser.includes("catalog-columns"), "the browser must not set the column variable itself");
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

test("the control is hidden where the choice is meaningless", () => {
  assert.match(globalsCss, /\.catalog-density \{ display: none; \}/);
  assert.match(globalsCss, /@media \(min-width: 1024px\) \{\s*\.catalog-density \{\s*display: inline-flex;/);
  // And the fourth option only exists at the width that honours it.
  assert.match(globalsCss, /\.catalog-density-option\[data-columns="4"\] \{ display: none; \}/);
  assert.match(
    globalsCss,
    /@media \(min-width: 1280px\) \{\s*\.catalog-density-option\[data-columns="4"\] \{ display: inline-flex; \}/
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

test("option ids are generated, so two instances cannot collide", () => {
  // The catalog mounts the browser inside a Suspense boundary, and a second
  // instance in the tree put duplicate `catalog-density-3` ids in the document
  // — which breaks getElementById and aria wiring in ways that fail silently.
  assert.match(control, /const groupId = useId\(\)/);
  assert.match(control, /const optionId = \(columns: CatalogDensity\) => `\$\{groupId\}-\$\{columns\}`/);
  assert.ok(!control.includes("`catalog-density-${"), "ids must not be derived from the column count alone");
  // And focus is looked up inside this group, not across the document.
  assert.match(control, /groupRef\s*\n?\s*\?\.querySelector|groupRef\.current\s*\n?\s*\?\.querySelector/);
  assert.ok(!control.includes("document.getElementById"));
  // The keyboard handler rebuilds the id from `groupId` rather than depending on
  // the render-scoped `optionId` helper, which the React Compiler refuses
  // because it would defeat the callback's memoization.
  assert.match(control, /\$\{groupId\}-\$\{next\}/);
});

test("it is a radio group with one tab stop and arrow-key movement", () => {
  assert.match(control, /role="radiogroup"/);
  assert.match(control, /aria-label="Products per row"/);
  assert.match(control, /role="radio"/);
  assert.match(control, /aria-checked=\{checked\}/);
  assert.match(control, /tabIndex=\{checked \? 0 : -1\}/);
  assert.ok(control.includes("ArrowRight") && control.includes("ArrowLeft"));
});

test("the selected state is not colour alone", () => {
  const rule = globalsCss.slice(globalsCss.indexOf(".catalog-density-option.is-selected {"));
  const body = rule.slice(0, rule.indexOf("}"));
  assert.ok(body.includes("background"), body);
  assert.ok(body.includes("border-color"), body);
});

test("density sits with sorting, not with the category filters", () => {
  const toolbar = browser.slice(browser.indexOf("catalog-filter-controls"));
  assert.ok(toolbar.indexOf("<CatalogDensityControl />") > 0);
  const rail = browser.slice(browser.indexOf("catalog-rail"), browser.indexOf("catalog-main"));
  assert.ok(!rail.includes("CatalogDensityControl"), "density is not a filter and must not join the rail");
});
