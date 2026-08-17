import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  categorySubtree,
  normalizeSuggestQuery,
  rankCategorySuggestions,
  SUGGEST_LIMITS,
  suggestionCount,
  suggestionRows,
  type SuggestResponse,
} from "../src/lib/commerce/catalogSuggest.ts";
import {
  ALL_SCOPE,
  buildSearchScopes,
  categoryScopeId,
  MAX_CATEGORY_SCOPES,
  projectsDestination,
  resolveScope,
  scopeCategorySlug,
  scopeGroups,
  scopePlaceholder,
  scopeSearchLabel,
  searchDestination,
} from "../src/lib/commerce/searchScopes.ts";
import type { StorefrontNav } from "../src/lib/commerce/storefrontNavModel.ts";
import { APPEARANCE_SEARCH_INDEX, APPEARANCE_SECTIONS, searchAppearance, sectionForTask } from "../src/theme/appearanceSections.ts";
import { APPEARANCE_TASKS } from "../src/theme/appearanceTasks.ts";
import { BUTTON_ROLES, buttonRole, configurableButtonRoles } from "../src/theme/buttonRoles.ts";

/**
 * Pass 6 — navbar underline, dropdown consistency, scoped search, the cart's
 * delivery summary, and Appearance discoverability.
 *
 * Source-reading tests throughout, for the reason the rest of this suite gives:
 * there is no DOM here, and the properties being pinned are structural — which
 * component owns a decision, which rule derives from which variable, which
 * amount may reach a customer. Comments are stripped before any
 * `doesNotMatch`, because this codebase habitually names the thing it removed
 * in the comment explaining the removal.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
/** Comments removed. Every `doesNotMatch` in this file runs against this. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const css = read("src/app/globals.css");
const cssRules = code(css);
const header = read("src/components/SiteHeader.tsx");
const search = read("src/components/nav/StorefrontSearch.tsx");
const productsMenu = read("src/components/nav/ProductsMenu.tsx");
const accountMenu = read("src/components/nav/AccountMenu.tsx");
const bell = read("src/components/nav/NotificationBell.tsx");
const cartPage = read("src/app/cart/page.tsx");
const fulfillmentPanel = read("src/components/commerce/CheckoutFulfillmentPanel.tsx");
const suggestRoute = read("src/app/api/public/catalog-suggest/route.ts");
const panels = read("src/app/staff/appearance/panels.tsx");
const preview = read("src/app/staff/appearance/PreviewStage.tsx");

/**
 * A rule body, by selector. Sliced on the closing brace, not on indentation.
 *
 * Read from the **comment-stripped** stylesheet. This file's prose quotes real
 * selectors while explaining what they used to do — there is a note that says
 * `.nav-menu-item { display: flex }` in the middle of a paragraph about a
 * source-order bug — and a search of the raw text finds the paragraph first and
 * asserts against a sentence.
 */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return cssRules.match(new RegExp(`${escaped}\\s*\\{[\\s\\S]*?\\}`))?.[0] ?? "";
}

/* ==========================================================================
 * PART 1 — the navbar underline
 * ======================================================================== */

test("the underline's geometry is derived from the link's own padding", () => {
  /*
   * The property, not the numbers: the rule and the padding must come from one
   * declaration. They were two independent values — a `padding-inline` of
   * 0.625rem and an `inset-inline` of 14% that had no idea what the padding
   * was — which is how the rule ended up a different proportion of every label
   * on the bar.
   */
  const link = rule(".site-header-shell .site-nav-primary-link");
  const after = rule(".site-header-shell .site-nav-primary-link::after");

  assert.match(link, /--nav-link-pad:/, "the padding must be named");
  assert.match(link, /--nav-underline-overhang:/, "and so must the overhang");
  assert.match(link, /padding-inline: var\(--nav-link-pad\) var\(--nav-link-pad-end\)/);
  assert.match(after, /var\(--nav-link-pad\) - var\(--nav-underline-overhang\)/);
  assert.match(after, /var\(--nav-link-pad-end\) - var\(--nav-underline-overhang\)/);
});

test("the underline sits lower and reads heavier than it did", () => {
  const after = rule(".site-header-shell .site-nav-primary-link::after");
  assert.match(after, /height: 4px/);
  assert.match(after, /bottom: 0\.125rem/);
  // The two it has already been. A regression to either is a regression.
  assert.doesNotMatch(code(after), /height: [23]px/);
  assert.doesNotMatch(code(after), /bottom: 0\.3rem/);
});

test("it stays centred, and every state draws the same shape", () => {
  const after = rule(".site-header-shell .site-nav-primary-link::after");
  assert.match(after, /transform-origin: center/);

  // Only opacity separates hover from active; nothing moves between states.
  const hover = css.match(/\.site-nav-primary-link:hover::after,[\s\S]*?\}/)?.[0] ?? "";
  const active = css.match(/\.site-nav-primary-link\.is-active::after \{[\s\S]*?\}/)?.[0] ?? "";
  for (const state of [hover, active]) {
    assert.match(state, /transform: scaleX\(1\)/);
    assert.doesNotMatch(code(state), /height:|inset-inline:|bottom:/);
  }
  // Focus draws it too — a keyboard user must see what a pointer user sees.
  assert.match(hover, /:focus-visible::after/);
});

test("Products' asymmetric padding moves its underline with it", () => {
  /*
   * The chevron side is tighter than the label side. Under the old symmetric
   * percentage the rule was centred on the control and therefore ~2px off the
   * content; deriving each end from that end's padding puts it back, and keeps
   * the label and the chevron under one rule.
   */
  const trigger = rule('.site-header-shell .products-menu-trigger[data-has-menu="true"]');
  assert.match(trigger, /--nav-link-pad-end: 0\.375rem/);
  assert.doesNotMatch(code(trigger), /padding-inline:/, "a shorthand would not move the rule");
});

test("reduced motion still disables the draw", () => {
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.site-header-shell \.site-nav-primary-link::after \{ transition: none; \}/
  );
});

/* ==========================================================================
 * PART 2 — Products and More are one design system
 * ======================================================================== */

test("every header dropdown takes its chrome from one rule", () => {
  /*
   * The border, radius, shadow and background used to be Tailwind utilities
   * repeated at three call sites, so More carried `shadow-2xl` and an
   * 80%-opacity border against the Products panel's full-strength one. Three
   * copies of a decision is three chances to disagree, and they had.
   */
  const panel = rule(".nav-menu-panel");
  const products = rule(".products-menu-panel");

  for (const property of ["border-radius: 1rem", "overflow: hidden"]) {
    assert.match(panel, new RegExp(property), `.nav-menu-panel must declare ${property}`);
    assert.match(products, new RegExp(property), `.products-menu-panel must declare ${property}`);
  }
  assert.match(panel, /border: 1px solid var\(--km-nav-border/);
  assert.match(panel, /box-shadow: 0 24px 60px rgba\(0, 0, 0, 0\.45\)/);
  assert.match(products, /box-shadow: 0 24px 60px rgba\(0, 0, 0, 0\.45\)/);
  // Same background token *and* the same fallback — the fallback was the tell.
  assert.match(panel, /background: var\(--km-nav-mobile-bg, var\(--panel-strong/);
  assert.match(products, /background: var\(--km-nav-mobile-bg, var\(--panel-strong/);
});

test("no caller re-declares the chrome it now inherits", () => {
  for (const [name, source] of [["More", header], ["account", accountMenu], ["notifications", bell]] as const) {
    const stripped = code(source);
    for (const utility of ["rounded-2xl", "shadow-2xl"]) {
      assert.ok(
        !stripped.includes(utility),
        `the ${name} panel must not re-declare ${utility}; .nav-menu-panel owns it`
      );
    }
  }
  // What a caller may still pass is a width, because that genuinely differs.
  assert.match(header, /panelClassName="w-72 p-2"/);
  assert.match(accountMenu, /panelClassName="w-64 p-2"/);
});

test("a More row and a Products row are the same row", () => {
  const item = rule(".nav-menu-item");
  // The Products rows are declared on one grouped selector, so it is found by
  // its last member rather than by reproducing the whole list and its newlines.
  const productsRow =
    cssRules.match(/\.products-menu-all,[\s\S]*?\.products-menu-child \{[\s\S]*?\}/)?.[0] ?? "";
  assert.ok(productsRow, "the Products row rule must be found");

  for (const [name, body] of [["More", item], ["Products", productsRow]] as const) {
    assert.match(body, /min-height: 2\.75rem/, `${name}: 44px, the same touch floor`);
    assert.match(body, /border-radius: 0\.5rem/, `${name}: the same corner`);
    assert.match(body, /font-size: 0\.875rem/, `${name}: the same size`);
  }

  // And they answer the pointer in the same colour.
  const itemHover = css.match(/\.nav-menu-item:hover,[\s\S]*?\}/)?.[0] ?? "";
  assert.match(itemHover, /color: var\(--km-nav-active/);
});

test("both triggers turn their chevron from aria-expanded, not from state", () => {
  assert.match(css, /\[aria-expanded="true"\] > \.nav-menu-chevron \{ transform: rotate\(180deg\); \}/);
  assert.match(header, /nav-menu-chevron/, "More must opt in");
  assert.match(productsMenu, /nav-menu-chevron/, "and so must Products");
  // The inline style computed from `open` is gone: a second source of truth for
  // a fact `aria-expanded` already carries is what let More never turn at all.
  assert.doesNotMatch(code(productsMenu), /transform: open \?/);
});

test("hover intent is untouched — both navigation menus still open on a pointer", () => {
  assert.match(header, /hoverIntent/, "More opts into the shared hook");
  assert.match(productsMenu, /useNavHoverIntent/);
  // And the personal controls deliberately still do not.
  assert.doesNotMatch(code(accountMenu), /hoverIntent/);
});

/* ==========================================================================
 * PARTS 5–6 — the scoped global search
 * ======================================================================== */

const NAV: StorefrontNav = {
  totalCount: 9,
  categories: [
    {
      name: "Interior",
      slug: "interior",
      href: "/catalog/interior",
      count: 6,
      children: [{ name: "Shift Knobs", slug: "shift-knobs", href: "/catalog/interior/shift-knobs", count: 4 }],
    },
    { name: "Kitchen", slug: "kitchen", href: "/catalog/kitchen", count: 3, children: [] },
  ],
};

test("the scope list is the catalog's own hierarchy, plus All and Projects", () => {
  const scopes = buildSearchScopes(NAV);
  assert.deepEqual(
    scopes.map((scope) => scope.id),
    ["all", "products", "category:interior", "category:shift-knobs", "category:kitchen", "projects"]
  );
  // Subcategories are offered and are marked as nested, so the dropdown can
  // indent them rather than listing a shelf beside a department.
  assert.equal(scopes.find((scope) => scope.id === "category:shift-knobs")?.depth, 1);
  assert.equal(scopes.find((scope) => scope.id === "category:interior")?.depth, 0);
  // Every category scope points at a route the nav itself supplied.
  assert.equal(scopes.find((scope) => scope.id === "category:kitchen")?.basePath, "/catalog/kitchen");
});

test("a shop with no categories still gets a working scope list", () => {
  const scopes = buildSearchScopes({ categories: [], totalCount: 0 });
  assert.deepEqual(scopes.map((scope) => scope.id), ["all", "products", "projects"]);
});

test("the default scope is All", () => {
  assert.equal(ALL_SCOPE.id, "all");
  assert.match(search, /useState\(ALL_SCOPE\.id\)/, "the box must open on All");
});

test("a scope id that names nothing widens to All rather than breaking", () => {
  const scopes = buildSearchScopes(NAV);
  assert.equal(resolveScope(scopes, "category:deleted-last-week").id, "all");
  assert.equal(resolveScope(scopes, "").id, "all");
  assert.equal(resolveScope(scopes, "category:interior").id, "category:interior");
  assert.equal(scopeCategorySlug(categoryScopeId("interior")), "interior");
  assert.equal(scopeCategorySlug("projects"), null);
});

test("each scope narrows to the groups that can answer it", () => {
  const scopes = buildSearchScopes(NAV);
  const groups = (id: string) => scopeGroups(resolveScope(scopes, id));

  assert.deepEqual(groups("all"), { products: true, categories: true, projects: true });
  assert.deepEqual(groups("products"), { products: true, categories: true, projects: false });
  assert.deepEqual(groups("category:interior"), { products: true, categories: true, projects: false });
  // The rule the brief asked for: a scoped search must not still surface
  // irrelevant groups.
  assert.deepEqual(groups("projects"), { products: false, categories: false, projects: true });
});

test("Enter respects the scope, and every destination already reads ?q=", () => {
  const scopes = buildSearchScopes(NAV);
  const go = (id: string, query: string) => searchDestination(resolveScope(scopes, id), query);

  assert.equal(go("all", "shift knob"), "/catalog?q=shift%20knob");
  assert.equal(go("products", "shift knob"), "/catalog?q=shift%20knob");
  assert.equal(go("category:interior", "knob"), "/catalog/interior?q=knob");
  assert.equal(go("category:shift-knobs", "knob"), "/catalog/interior/shift-knobs?q=knob");
  assert.equal(go("projects", "cnc"), "/projects?q=cnc");
  // An empty query is the section itself, not a `?q=` with nothing in it.
  assert.equal(go("category:kitchen", "   "), "/catalog/kitchen");
  assert.equal(go("projects", ""), "/projects");
  assert.equal(projectsDestination("cnc mill"), "/projects?q=cnc%20mill");
});

test("the routes those destinations name really do read the query", () => {
  // `/catalog` and every category route beneath it share one filter parser.
  assert.match(read("src/components/catalog/CatalogBrowser.tsx"), /parseCatalogFilters\(searchParams\)/);
  // `/projects` seeds its chip search from `?q=` on first render.
  assert.match(read("src/app/projects/ProjectsIndexClient.tsx"), /searchParams\.get\("q"\)/);
});

test("a category scope searches only inside that category", () => {
  const inside = rankCategorySuggestions(NAV.categories, "knob", "interior");
  assert.deepEqual(inside.map((entry) => entry.trail), ["Interior / Shift Knobs"]);
  // Unscoped, the same query is allowed to reach anything.
  assert.ok(rankCategorySuggestions(NAV.categories, "kitchen").length > 0);
  // Scoped to a sibling, it finds nothing rather than leaking across.
  assert.deepEqual(rankCategorySuggestions(NAV.categories, "knob", "kitchen"), []);

  assert.deepEqual(categorySubtree(NAV.categories, "interior").map((entry) => entry.slug), ["interior"]);
  assert.deepEqual(categorySubtree(NAV.categories, "shift-knobs")[0]?.children, []);
  assert.deepEqual(categorySubtree(NAV.categories, "nope"), []);
});

test("the scope selector is a native select, and is labelled", () => {
  /*
   * Not a styled listbox. A second custom dropdown inches from the Products one
   * is two panels that can be open at once, competing for the same corner and
   * the same Escape key — the collision the brief asked to avoid. The native
   * control renders in the platform layer and cannot collide with either.
   */
  assert.match(search, /<select/);
  assert.match(search, /className="storefront-search-scope"/);
  assert.match(search, /<label className="sr-only" htmlFor=\{scopeSelectId\}>/);
  assert.doesNotMatch(code(search), /<optgroup/, "an optgroup label is not selectable, and a department must be");
  // 44px-friendly on touch, and it keeps its slot at phone widths rather than
  // being hidden — a scope you cannot set on a phone is a scope phone customers
  // never have.
  assert.match(css, /\.site-header-mobile-search \.storefront-search-scope,/);
  assert.match(css, /\.mobile-nav-search-field \.storefront-search-scope/);
});

test("suggestions are requested for the scope, and a stale scope's answer is discarded", () => {
  assert.match(search, /scope=\$\{encodeURIComponent\(scope\.id\)\}/);
  assert.match(search, /\[query, canSuggest, scope\.id\]/, "changing the scope must re-request");
  // The response says which scope it answers, and rows are only built when it
  // matches — so the panel never shows the previous scope's products under the
  // new scope's heading.
  assert.match(search, /results\.scope === scope\.id/);
  assert.match(suggestRoute, /scope: scope\.id/);
});

test("results are grouped, and every row says what kind of thing it is", () => {
  assert.match(search, /role="group"/);
  assert.match(search, /aria-labelledby=\{headingId\}/);
  assert.match(search, /GROUP_LABELS = \{ product: "Products", category: "Categories", project: "Projects" \}/);
  assert.match(search, /KIND_LABELS = \{ product: "Product", category: "Category", project: "Project" \}/);
});

test("keyboard selection indexes one flat row list across all three groups", () => {
  /*
   * The old arithmetic was `index - results.products.length`, which only stayed
   * correct while there were exactly two groups. `suggestionRows` is the one
   * ordering, and the arrow keys, `aria-activedescendant` and Enter all index
   * into it.
   */
  const response: SuggestResponse = {
    query: "knob",
    scope: "all",
    products: [{ id: "p1", name: "Shift Knob", slug: "shift-knob", category: "Interior", image: null, price: "$40" }],
    categories: [{ name: "Shift Knobs", href: "/catalog/interior/shift-knobs", trail: "Interior / Shift Knobs", count: 4 }],
    projects: [{ id: "j1", title: "Knurling a knob", slug: "knurling-a-knob" }],
  };

  const rows = suggestionRows(response);
  assert.equal(suggestionCount(response), 3);
  assert.deepEqual(rows.map((row) => row.kind), ["product", "category", "project"]);
  assert.deepEqual(rows.map((row) => row.href), [
    "/catalog/shift-knob",
    "/catalog/interior/shift-knobs",
    "/projects/knurling-a-knob",
  ]);

  assert.match(search, /role="combobox"/);
  assert.match(search, /role="listbox"/);
  assert.match(search, /role="option"/);
  assert.match(search, /aria-activedescendant/);
  // Enter follows the highlight. The submit handler reads the row at `active`
  // and uses its href, falling back to the scope's results page only when
  // nothing is highlighted — `active` being -1 is a real position in the cycle.
  assert.match(search, /const chosen = rows\[active\]/, "Enter must read the highlighted row");
  assert.match(search, /chosen\?\.href \?\? searchDestination\(scope, value\)/, "…and follow it");
});

test("the placeholder and the landmark name say which scope is active", () => {
  const scopes = buildSearchScopes(NAV);
  assert.equal(scopePlaceholder(ALL_SCOPE), "Search products and projects…");
  assert.equal(scopePlaceholder(resolveScope(scopes, "projects")), "Search projects…");
  assert.equal(scopePlaceholder(resolveScope(scopes, "category:interior")), "Search Interior…");
  assert.equal(scopeSearchLabel(resolveScope(scopes, "category:interior")), "Search products in Interior");
  assert.match(search, /aria-label=\{searchLabel\}/);
});

test("the suggest route validates the scope against the real category tree", () => {
  // Resolving through `buildSearchScopes` is what turns an invented
  // `category:anything` into All rather than into an unfiltered query.
  assert.match(suggestRoute, /resolveScope\(buildSearchScopes\(nav\), requestedScope\)/);
  // A category scope constrains by id, not by the denormalized name on the row.
  assert.match(suggestRoute, /\.in\("category_id", categoryIds\)/);
  // A group that is switched off is not queried at all.
  assert.match(suggestRoute, /groups\.products\n?\s*\?/);
  assert.match(suggestRoute, /groups\.projects\n?\s*\?/);
  // Projects are only ever the approved ones.
  assert.match(suggestRoute, /\.eq\("status", "approved"\)/);
});

test("the search reads the same nav the Products dropdown does", () => {
  // One hierarchy, two controls. A second list of categories is how a navbar
  // starts pointing at a 404.
  assert.match(header, /<StorefrontSearch className="site-header-search" nav=\{productsNav\}/);
  assert.match(header, /<ProductsMenu\s+nav=\{productsNav\}/);
  assert.match(read("src/components/nav/MobileNavDrawer.tsx"), /nav=\{productsNav\}/);
  assert.doesNotMatch(code(read("src/lib/commerce/searchScopes.ts")), /loadStorefrontNav|supabase/);
});

test("the category scope list is bounded", () => {
  const many = {
    totalCount: 0,
    categories: Array.from({ length: MAX_CATEGORY_SCOPES + 10 }, (_, index) => ({
      name: `C${index}`,
      slug: `c${index}`,
      href: `/catalog/c${index}`,
      count: 1,
      children: [],
    })),
  };
  const scopes = buildSearchScopes(many);
  assert.equal(scopes.filter((scope) => scope.kind === "category").length, MAX_CATEGORY_SCOPES);
  // It degrades to the high-level scopes, not to a broken control.
  assert.equal(scopes[0].id, "all");
  assert.equal(scopes[scopes.length - 1].id, "projects");
});

test("the suggest limits stay bounded on the server", () => {
  assert.equal(SUGGEST_LIMITS.products, 5);
  assert.equal(SUGGEST_LIMITS.categories, 3);
  assert.equal(SUGGEST_LIMITS.projects, 4);
  assert.equal(normalizeSuggestQuery("x".repeat(500)).length, SUGGEST_LIMITS.maxLength);
});

/* ==========================================================================
 * PART 4 — local search that duplicated the global one
 * ======================================================================== */

test("the catalog's box is the page's filter, not a second site search", () => {
  const commerceSearch = read("src/components/catalog/CommerceSearch.tsx");
  const browser = read("src/components/catalog/CatalogBrowser.tsx");

  // Kept, because it narrows in place per keystroke and the navbar navigates —
  // genuinely different actions. Renamed, because two `search` landmarks called
  // "Search products" on one page is one of them lying.
  assert.match(commerceSearch, /const label = scopeName \? `Filter \$\{scopeName\}` : "Filter products"/);
  assert.doesNotMatch(code(commerceSearch), /aria-label="Search products"/);
  assert.match(browser, /scopeName=\{scopeName\}/, "inside a department it must say which");
  assert.match(browser, /aria-label="Filter and arrange products"/);
});

test("the surfaces whose local search is genuinely scoped still have one", () => {
  /*
   * These search things the navbar does not index, or index privately: a
   * customer's own orders, and the project write-ups by tag and chassis with
   * chips and a "did you mean". Removing them would lose a capability rather
   * than remove a duplicate.
   */
  assert.match(read("src/app/account/orders/page.tsx"), /commerce-search/);
  assert.match(read("src/app/projects/ProjectsIndexClient.tsx"), /content-search/);
  assert.match(read("src/app/projects/category/[slug]/page.tsx"), /content-search/);
});

/* ==========================================================================
 * PARTS 7–9 — the cart's delivery summary
 * ======================================================================== */

test("there is no separate Delivery card left on the cart", () => {
  const stripped = code(cartPage);
  // One mount, and it is inside the summary.
  assert.equal(
    (stripped.match(/<CheckoutFulfillmentPanel/g) ?? []).length,
    1,
    "the panel must be mounted exactly once"
  );
  const summaryStart = stripped.indexOf('aria-labelledby="cart-summary"');
  const panelAt = stripped.indexOf("<CheckoutFulfillmentPanel");
  const totalAt = stripped.indexOf("cart-total");
  assert.ok(summaryStart > -1 && panelAt > summaryStart, "the panel must be inside the summary");
  assert.ok(panelAt < totalAt, "and above the Total it changes");

  // The panel no longer draws a card or a heading of its own.
  assert.doesNotMatch(code(fulfillmentPanel), /<h2 className="text-lg font-semibold">Delivery<\/h2>/);
  assert.doesNotMatch(code(fulfillmentPanel), /className="ui-card"/);
  assert.match(fulfillmentPanel, /className="cart-delivery"/);
});

test("the delivery line is named after the method, and pickup is not called shipping", () => {
  assert.match(cartPage, /fulfillment\.method === "pickup"\s*\?\s*"Pickup"/);
  assert.match(cartPage, /:\s*fulfillment\.method === "shipping"\s*\n?\s*\?\s*"Shipping"/);
  assert.match(cartPage, /data-testid="cart-delivery-line"/);
});

test("the delivery amount is only ever the server's, and says so when there is none", () => {
  /*
   * The one property this pass must not break. No branch may produce a currency
   * amount from anything but `liveQuote`, and `liveQuote` is the quote only
   * while it still describes this cart.
   */
  // `;\r?\n`: these files are CRLF, and an anchor written `;\n` matches nothing,
  // falls back to "" and passes a test that checked nothing.
  const amount = cartPage.match(/const deliveryAmount = [\s\S]*?;\r?\n/)?.[0] ?? "";
  assert.ok(amount, "the delivery amount must be derived in one place");
  assert.match(amount, /liveQuote\s*\n?\s*\?/, "a figure requires a live quote");
  assert.match(amount, /formatCents\(liveQuote\.shippingCents\)/);
  assert.match(amount, /"Calculated at checkout"/, "an unpriced shipping selection must say so");
  // And no fallback invents one.
  assert.doesNotMatch(code(amount), /formatCents\((?!liveQuote)/);
  assert.match(cartPage, /const liveQuote = quoteMatchesCart\(quoted, cart\) \? quoted : null/);
});

test("the Total includes the delivery charge, and updates when the method changes", () => {
  assert.match(cartPage, /formatCents\(liveQuote\?\.totalCents \?\? cart\?\.totalCents \?\? 0\)/);
  // `totalCents` comes from the same server response as `shippingCents`, so the
  // two cannot disagree; and the quote is re-requested whenever the selection
  // or the cart's pricing basis moves.
  assert.match(fulfillmentPanel, /\[method, selection, onChange, requestQuote, pricingBasis\]/);
  assert.match(fulfillmentPanel, /const pricingBasis = /);
});

test("the browser never sends a shipping amount, and checkout re-prices anyway", () => {
  const checkout = read("src/app/api/cart/checkout/route.ts");
  // The page sends a method id, an address and — for a guest — an email.
  assert.match(cartPage, /\.\.\.\(fulfillment\.selection \?\? \{\}\)/);
  assert.doesNotMatch(code(cartPage), /shippingCents:/, "the cart must never post a price");
  assert.doesNotMatch(code(fulfillmentPanel), /shippingCents:\s*[^}]*\bbody\b/);
  // And the server computes the total it charges.
  assert.match(checkout, /const totalCents = plan\.totals\.totalCents/);
  assert.match(checkout, /unit_amount: totalCents/);
});

test("choosing a method is still a real radio group, keyboard and touch", () => {
  assert.match(fulfillmentPanel, /<fieldset className="cart-delivery-methods">/);
  assert.match(fulfillmentPanel, /<legend className="cart-delivery-legend">/);
  assert.match(fulfillmentPanel, /type="radio"/);
  assert.match(fulfillmentPanel, /name="fulfillment-method"/);
  // Visually hidden, not removed: it is still the control.
  assert.match(fulfillmentPanel, /className="sr-only"/);
  const choice = rule(".cart-delivery-choice");
  assert.match(choice, /min-height: 2\.75rem/, "44px on the control that gates checkout");
  assert.match(css, /\.cart-delivery-choice:has\(input:focus-visible\)/, "the label must draw the ring");
  assert.match(css, /\.cart-delivery-choice:has\(input:checked\)/);
});

test("the pointer to the delivery controls points at where they now are", () => {
  assert.doesNotMatch(code(cartPage), /delivery option below/, "they are above the button now");
  assert.match(cartPage, /above to continue/);
});

/* ==========================================================================
 * PARTS 10–18 — Appearance
 * ======================================================================== */

test("the section is called Colors", () => {
  const colors = APPEARANCE_SECTIONS.find((section) => section.id === "colors");
  assert.ok(colors, "the section id is `colors`");
  assert.equal(colors.label, "Colors");
  assert.ok(!APPEARANCE_SECTIONS.some((section) => section.label.includes("Colour")));
});

test("no owner-facing string in the editor is spelled the British way", () => {
  /*
   * String literals and JSX text only — comments are stripped first, because
   * this codebase names what it replaced in the comment explaining the
   * replacement, and prose about a past decision is not something an owner
   * reads.
   */
  const surfaces = [
    ["panels.tsx", panels],
    ["sections.tsx", read("src/app/staff/appearance/sections.tsx")],
    ["page.tsx", read("src/app/staff/appearance/page.tsx")],
    ["ColorControls.tsx", read("src/app/staff/appearance/ColorControls.tsx")],
    ["appearanceSections.ts", read("src/theme/appearanceSections.ts")],
    ["appearanceTasks.ts", read("src/theme/appearanceTasks.ts")],
    // The map's `description` and `usedBy` prose is drawn under every swatch,
    // which makes it the largest owner-facing surface in the editor — and the
    // one this test missed on its first pass, so the rename was still visible
    // on screen while every file it did check was clean.
    ["appearanceMap.ts", read("src/theme/appearanceMap.ts")],
    ["buttonRoles.ts", read("src/theme/buttonRoles.ts")],
    ["staffNavigation.ts", read("src/lib/staffNavigation.ts")],
  ] as const;

  for (const [name, source] of surfaces) {
    /*
     * Keyword lists are excluded, and deliberately.
     *
     * They are never displayed — they are the haystack the editor's search
     * matches against — and an owner who types "colour" should still find the
     * control. Carrying both spellings there is the forgiving behaviour;
     * carrying both in a *label* is the inconsistency this pass removed.
     */
    const stripped = code(source).replace(/keywords: \[[\s\S]*?\]/g, "");
    /*
     * Three shapes, and the third is the one that matters.
     *
     * The first cut matched double-quoted literals and single-line JSX text,
     * and passed while the editor still said "Shared — this colour is used in
     * more than one place" and "it is coloured like the catalog's…" on screen:
     * both are JSX text that *wraps*, so a line-bounded pattern never saw them.
     * Matching across newlines is what makes this an assertion about what an
     * owner reads rather than about how the source happens to be wrapped.
     */
    const strings = [
      ...(stripped.match(/"[^"\n]*"/g) ?? []),
      ...(stripped.match(/'[^'\n]*'/g) ?? []),
      ...(stripped.match(/>[^<>{}]+</g) ?? []),
    ];
    const offenders = strings
      .filter((value) => /colour/i.test(value))
      .map((value) => value.replace(/\s+/g, " ").trim().slice(0, 80));
    assert.deepEqual(offenders, [], `${name} shows an owner "colour": ${offenders.join(" | ")}`);
  }

  // And the forgiving half is real: the British spelling still finds things.
  assert.ok(searchAppearance("colour").length > 0, "a British-spelling query must still work");
});

test("every colour in the editor is reachable from Colors", () => {
  /*
   * Part 12's rule: if you think "I want to change a colour", Colors is where
   * you look — and Colors held four of the twenty. The index closes that
   * without a second control writing the same value.
   */
  const indexed = new Set<string>();
  for (const match of panels.matchAll(/taskIds: \[([\s\S]*?)\]/g)) {
    for (const id of match[1].matchAll(/"([a-z0-9-]+)"/g)) indexed.add(id[1]);
  }

  const editedInColors = APPEARANCE_TASKS.filter((task) => sectionForTask(task.id) === "colors").map(
    (task) => task.id
  );
  const missing = APPEARANCE_TASKS.map((task) => task.id).filter(
    (id) => !indexed.has(id) && !editedInColors.includes(id)
  );
  assert.deepEqual(missing, [], `colours reachable from nowhere in Colors: ${missing.join(", ")}`);

  // Every indexed task is a real one, and none of them is also edited here —
  // which would be the duplicate control the rule forbids.
  for (const id of indexed) {
    assert.ok(
      APPEARANCE_TASKS.some((task) => task.id === id),
      `the colour index names a task that does not exist: ${id}`
    );
    assert.ok(!editedInColors.includes(id), `${id} would be rendered twice`);
  }
});

test("no colour is persisted by two controls", () => {
  // The partition test in `appearance-tasks.test.ts` owns the one-home rule;
  // this asserts the index did not quietly break it by adding a second run.
  const runs = [...panels.matchAll(/tasks=\{(tasksForSection\("([a-z]+)"\)|pick\([^)]*\)|brand|surfaces)\}/g)];
  assert.ok(runs.length > 0, "the workspaces must still render colour runs");
  assert.doesNotMatch(code(panels), /<ColorRun[\s\S]{0,400}COLOR_INDEX/, "the index must be links, not controls");
  assert.match(panels, /appearance-index-link/, "the index rows are links");
});

test("every button on the site has a documented semantic role", () => {
  assert.deepEqual(BUTTON_ROLES.map((role) => role.id), ["primary", "secondary", "quiet", "danger"]);

  for (const role of BUTTON_ROLES) {
    assert.ok(role.label.length > 2, role.id);
    assert.ok(role.description.length > 10, `${role.id} must say what it is for`);
    assert.ok(role.surfaces.length >= 3, `${role.id} must name where it is used`);
    assert.ok(role.usedFor.length > 20, `${role.id} must state the fact an owner needs`);
    for (const surface of role.surfaces) {
      assert.ok(surface.label.length > 1 && surface.where.length > 3, `${role.id}: ${surface.label}`);
    }
  }

  // The two that can be changed, and the two that deliberately cannot.
  assert.deepEqual(configurableButtonRoles().map((role) => role.id), ["primary", "secondary"]);
  assert.equal(buttonRole("quiet").colorTaskId, null);
  assert.equal(buttonRole("danger").colorTaskId, null);
});

test("the roles name classes the storefront really paints with", () => {
  for (const role of BUTTON_ROLES) {
    for (const className of role.classNames) {
      assert.match(
        cssRules,
        new RegExp(`\\.${className}\\b`),
        `${role.id} claims ${className}, which the stylesheet does not define`
      );
    }
  }
  // And each configurable role points at a colour task that exists.
  for (const role of configurableButtonRoles()) {
    assert.ok(
      APPEARANCE_TASKS.some((task) => task.id === role.colorTaskId),
      `${role.id} points at a missing task`
    );
  }
});

test("the mapping is rendered, and the preview is captioned from it", () => {
  assert.match(panels, /function ButtonRoleMap/);
  assert.match(panels, /appearance-button-role-\$\{role\.id\}/);
  assert.match(panels, /Used on/);
  assert.match(panels, /BUTTON_ROLES\.map/);
  // The preview draws each role with the class it names, so it is the button
  // rather than a picture of one, and says what it is used for.
  assert.match(preview, /BUTTON_ROLES\.map/);
  assert.match(preview, /role\.surfaces\.slice\(0, 2\)/);
});

test("the roles do not become per-route theming", () => {
  const roles = read("src/theme/buttonRoles.ts");
  // No route in the model at all — a role is a role everywhere it appears.
  assert.doesNotMatch(code(roles), /pathname|route:|href:/);
  assert.doesNotMatch(code(panels), /setTheme\("[a-zA-Z]+", *`?\/(catalog|orders|cart)/);
});

test("/orders/new says which roles it consumes, and each is reachable", () => {
  assert.match(panels, /anchor="component-request-flow"/);
  assert.match(panels, /The custom request page/);
  for (const label of ["Continue, Submit request", "Review answers", "Back", "The step you are on"]) {
    assert.ok(panels.includes(label), `the request mapping must name ${label}`);
  }
  // And the wizard really does use those roles.
  const wizard = read("src/components/orders/CustomRequestWizard.tsx");
  assert.match(wizard, /className="ui-btn ui-btn-primary request-submit"/);
  assert.match(wizard, /onClick=\{back\} className="ui-btn ui-btn-ghost"/);
  // The stepper and the selected card follow the brand colour, not a hardcoded
  // gold — the low-contrast behaviour this must not reintroduce.
  assert.match(rule(".request-step-chip.is-current"), /var\(--brand-primary\)/);
  assert.match(rule(".request-choice.is-selected"), /var\(--brand-/);
});

test("search finds a control from the words an owner would type", () => {
  const cases: [string, string][] = [
    ["checkout", "button-role-primary"],
    ["submit request", "button-role-primary"],
    ["add to cart", "button-role-primary"],
    ["back", "button-role-quiet"],
    ["orders/new", "component-request-flow"],
    ["custom request", "component-request-flow"],
    ["navbar", "task-navbar"],
    ["active accent", "task-navbar-active"],
  ];

  for (const [query, anchor] of cases) {
    const anchors = searchAppearance(query).map((entry) => entry.anchor);
    assert.ok(anchors.includes(anchor), `"${query}" should reach ${anchor}; got ${anchors.slice(0, 5).join(", ")}`);
  }

  // "button" leads with the roles rather than with a colour token.
  assert.match(searchAppearance("button")[0]?.anchor ?? "", /^button-role-/);
});

test("the button-role entries are generated, not restated", () => {
  const entries = APPEARANCE_SEARCH_INDEX.filter((entry) => entry.anchor.startsWith("button-role-"));
  assert.equal(entries.length, BUTTON_ROLES.length);
  for (const entry of entries) {
    assert.equal(entry.section, "components");
    assert.ok(entry.context.startsWith("Button role — used on "), entry.anchor);
  }
});
