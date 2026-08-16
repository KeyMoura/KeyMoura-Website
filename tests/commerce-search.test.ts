import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import CommerceSearch from "../src/components/catalog/CommerceSearch.tsx";
import {
  applyCatalogFilters,
  catalogFilterQuery,
  DEFAULT_FILTERS,
  parseCatalogFilters,
} from "../src/lib/commerce/catalogBrowse.ts";

/**
 * Search as the storefront's primary control.
 *
 * The catalog filtered as you typed long before this pass, so nothing here is
 * about *whether* search works. It is about the difference between a filter
 * field and a shopping control: a label, an icon, a submit, a clear, and a
 * result line that says what was searched for — the things that make a box on
 * a shop look like a box you are meant to type a sentence into.
 */

const read = (path: string) => readFileSync(path, "utf8");
const browser = read("src/components/catalog/CatalogBrowser.tsx");
const drawer = read("src/components/catalog/CatalogBrowseDrawer.tsx");
const globalsCss = read("src/app/globals.css");

const markup = renderToStaticMarkup(
  createElement(CommerceSearch, {
    value: "",
    onChange: () => {},
    onSubmit: () => {},
    onClear: () => {},
    inputId: "test-search",
  })
);

const withText = renderToStaticMarkup(
  createElement(CommerceSearch, {
    value: "shift knob",
    onChange: () => {},
    onSubmit: () => {},
    onClear: () => {},
    inputId: "test-search",
  })
);

// ---------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------

test("it is a search landmark with a name of its own", () => {
  assert.match(markup, /role="search"/);
  assert.match(markup, /aria-label="Search products"/);
  // A form, so Enter submits without a keydown handler pretending to be one.
  assert.match(markup, /^<form/);
});

test("the input is labelled, not merely placeheld", () => {
  assert.match(markup, /<label class="sr-only" for="test-search">Search products<\/label>/);
  assert.match(markup, /id="test-search"/);
  assert.match(markup, /type="search"/);
  // The id is passed in rather than hard-coded, so two instances on one page
  // cannot produce duplicate ids and a label pointing at the wrong box.
  assert.match(read("src/components/catalog/CommerceSearch.tsx"), /inputId: string/);
  assert.match(browser, /const searchId = useId\(\)/);
});

test("there is a real submit button", () => {
  assert.match(markup, /<button type="submit"/);
  assert.match(markup, /Search<\/span>/);
  // And it stays a labelled control at narrow widths rather than disappearing:
  // the word is swapped for an icon, and the word survives as its name.
  assert.match(globalsCss, /\.commerce-search-submit-icon \{ display: none;/);
  assert.match(globalsCss, /@media \(max-width: 419\.98px\) \{[\s\S]*?\.commerce-search-submit-icon \{ display: inline-block; \}/);
  assert.match(globalsCss, /\.commerce-search-submit-label \{ position: absolute; width: 1px;/);
});

test("clear appears only when there is something to clear, and is named", () => {
  assert.ok(!markup.includes("commerce-search-clear"), "an empty box has nothing to clear");
  assert.match(withText, /class="commerce-search-clear" aria-label="Clear search"/);
  // The browser's own cancel cross is suppressed: it is unlabelled, invisible
  // to a screen reader, and sits exactly where ours goes.
  assert.match(globalsCss, /\.commerce-search-input::-webkit-search-cancel-button \{ -webkit-appearance: none; appearance: none; \}/);
});

test("the placeholder is short enough to fit the field it is in", () => {
  const placeholder = markup.match(/placeholder="([^"]*)"/)?.[1] ?? "";
  assert.ok(placeholder.length > 0);
  assert.ok(placeholder.length <= 24, `"${placeholder}" clips at 375px`);
});

test("it does not look like a table's filter field", () => {
  // `.ui-input` is the shared form control the staff tables use. The storefront
  // search is deliberately its own, taller, control.
  assert.ok(!markup.includes("ui-input"));
  assert.match(globalsCss, /\.commerce-search-input \{[\s\S]*?min-height: 2\.875rem;/);
  assert.match(globalsCss, /\.commerce-search-icon \{/);
  assert.match(globalsCss, /\.commerce-search-input:focus-visible \{\s*outline: 2px solid var\(--brand-primary\);/);
});

// ---------------------------------------------------------------------------
// Where it sits, and what it writes
// ---------------------------------------------------------------------------

test("search gets its own row, above the result context", () => {
  const toolbar = browser.slice(browser.indexOf('className="catalog-toolbar"'));
  const search = toolbar.indexOf("<CommerceSearch");
  const results = toolbar.indexOf("catalog-results-bar");
  assert.ok(search > 0 && results > search, "search must lead the toolbar");
  assert.match(globalsCss, /\.catalog-toolbar \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
});

test("there is exactly one search box on the page", () => {
  // The drawer used to carry a second one, from when the toolbar's field was
  // hidden below lg. Two controls writing one query parameter is one too many.
  assert.ok(!drawer.includes('type="search"'), "the filters sheet must not hold a second search");
  assert.equal((browser.match(/<CommerceSearch/g) ?? []).length, 1);
});

test("submitting commits immediately and leaves a history entry", () => {
  // The 350ms debounce exists so a keystroke does not cost an RSC round trip.
  // A deliberate submit is not a keystroke, and a searched-for term is a place
  // Back should return from.
  assert.match(browser, /const submitSearch = \(value: string\) => \{[\s\S]*?router\.push\(/);
  assert.match(browser, /onSubmit=\{submitSearch\}/);
  // The debounced path still replaces, so typing cannot fill the history.
  assert.match(browser, /router\.replace\(`\$\{pathname\}\$\{catalogFilterQuery\(next\)\}`, \{ scroll: false \}\)/);
});

test("the URL is the shareable state", () => {
  assert.equal(catalogFilterQuery({ ...DEFAULT_FILTERS, query: "shift knob" }), "?q=shift+knob");
  assert.equal(parseCatalogFilters({ q: "shift knob" }).query, "shift knob");
  // Defaults are omitted, so one view has one address.
  assert.equal(catalogFilterQuery(DEFAULT_FILTERS), "");
  // And a submitted term is trimmed and bounded the same way the parser bounds
  // it, so the box and the URL cannot disagree about what was searched.
  assert.match(browser, /value\.trim\(\)\.slice\(0, 80\)/);
  assert.equal(parseCatalogFilters({ q: "  spaced  " }).query, "spaced");
  assert.equal(parseCatalogFilters({ q: "x".repeat(200) }).query.length, 80);
});

test("search matches names, descriptions and categories", () => {
  const products = [
    { id: "1", name: "Billet Shift Knob", slug: "a", category: "Interior", short_description: "Knurled" },
    { id: "2", name: "Pedal Spacer", slug: "b", category: "Interior", short_description: "Anodised" },
    { id: "3", name: "Walnut Board", slug: "c", category: "Kitchen", short_description: null },
  ];
  const find = (query: string) =>
    applyCatalogFilters(products, { ...DEFAULT_FILTERS, query }).map((product) => product.id);
  assert.deepEqual(find("knob"), ["1"]);
  assert.deepEqual(find("kitchen"), ["3"]);
  assert.deepEqual(find("anodised"), ["2"]);
  assert.deepEqual(find("interior"), ["1", "2"]);
  assert.deepEqual(find("nothing at all"), []);
});

// ---------------------------------------------------------------------------
// The result context
// ---------------------------------------------------------------------------

test("the count says what was searched for, not just a number", () => {
  // "0 products" is a fact the customer can already see. The useful half is
  // which term produced it.
  assert.match(browser, /\{visible\.length === 1 \? "result" : "results"\} for /);
  assert.match(browser, /className="catalog-results-term"/);
  assert.match(browser, /aria-live="polite"/);
});

test("the search term is removable without losing the category", () => {
  // `clear` resets everything, which throws away the category the customer
  // navigated to on the way here. `clearSearch` is the narrow one.
  assert.match(browser, /const clearSearch = \(\) => \{\s*setTyped\(""\);\s*setFilters\(\{ query: "" \}\);\s*\}/);
  assert.match(browser, /onClick=\{clearSearch\} className="catalog-filter-chip"/);
});

test("an empty result names the term and offers to clear it", () => {
  assert.match(browser, /No products match “\$\{term\}”/);
  /*
   * Discovery 4.0 rewrote the recovery copy and dropped the shared
   * `.ui-empty-state` panel for a `.catalog-empty` block, because a bordered
   * card was the wrong shape for the page's least-decorated moment. It also
   * stopped rendering escape hatches that do nothing: Clear filters is now
   * absent when nothing is set rather than present and disabled, which is the
   * change this assertion follows.
   */
  assert.match(browser, /Check the spelling, try a broader word/);
  const empty = browser.slice(browser.indexOf('className="catalog-empty"'));
  assert.ok(empty.includes("Clear search"), "the empty state must offer the one-press fix");
  assert.match(empty, /\{!isDefault \? \(/, "Clear filters appears only when a filter is set");
  // And the shop's own recovery: a search that found nothing is where custom
  // work is the most useful next step.
  assert.match(empty, /CatalogRecovery variant="empty"/);
});

test("active filters carry a Clear all beside the individual chips", () => {
  assert.match(browser, /catalog-filter-chip catalog-filter-chip-clear/);
  /*
   * Removing everything is still a different act from removing one thing, so
   * it still does not wear the same × the individual chips do. The dashed
   * border became an underline in Discovery 4.0 — the chips gained a brand
   * tint, and a dashed outline beside them read as a disabled control.
   */
  const clearBlock = globalsCss.slice(globalsCss.indexOf(".catalog-filter-chip-clear {"));
  assert.match(clearBlock.slice(0, 260), /text-decoration: underline/);
  assert.match(clearBlock.slice(0, 260), /background: transparent/);
  assert.doesNotMatch(clearBlock.slice(0, 260), /aria-hidden/);
});
