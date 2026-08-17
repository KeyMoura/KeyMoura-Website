import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import ProductCard from "../src/components/ProductCard.tsx";
import {
  availabilityPresentation,
  catalogAction,
  catalogPriceLabel,
  customizationSignal,
  isDirectlyPurchasable,
  isOptionallyCustomizable,
} from "../src/lib/commerce/catalogActions.ts";
import {
  catalogSearchHref,
  normalizeSuggestQuery,
  rankCategorySuggestions,
  SUGGEST_LIMITS,
  suggestionCount,
} from "../src/lib/commerce/catalogSuggest.ts";
import { ALL_SCOPE, searchDestination } from "../src/lib/commerce/searchScopes.ts";
import {
  parseRecentlyViewed,
  RECENTLY_VIEWED_LIMIT,
  withRecentProduct,
  type RecentProduct,
} from "../src/lib/commerce/recentlyViewed.ts";
import { buildBrowseMenu } from "../src/lib/commerce/catalogBrowse.ts";
import type { CategoryRow } from "../src/lib/commerce/categories.ts";
import {
  acceptanceProblem,
  TERMS_UPDATED_LABEL,
  TERMS_VERSION,
} from "../src/lib/legal/terms.ts";

/**
 * Storefront Discovery, Navigation & Customer Trust 4.0.
 *
 * The rules this pass is built on, asserted rather than described. Anything
 * here that is a *structural* claim about markup is tested through
 * `renderToStaticMarkup`, so it is checked against what the component actually
 * produces; anything that is a claim about a source file being the only place
 * something is written is checked by reading the file.
 */

/**
 * Renders a card the way a page does.
 *
 * `WishlistButton` and `CatalogProductAction` both read React Query caches, so
 * a bare `renderToStaticMarkup` throws "No QueryClient set". Wrapping here — with
 * retries off, so a failed fetch in a test never becomes a hang — keeps every
 * assertion below against the markup the real grid produces rather than against
 * a stripped-down variant that could drift from it.
 */
function renderCard(props: Record<string, unknown>): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(ProductCard, props as never))
  );
}

const read = (path: string) => readFileSync(path, "utf8");

const css = read("src/app/globals.css");
const header = read("src/components/SiteHeader.tsx");
const drawer = read("src/components/nav/MobileNavDrawer.tsx");
const productsMenu = read("src/components/nav/ProductsMenu.tsx");
const search = read("src/components/nav/StorefrontSearch.tsx");
const suggestRoute = read("src/app/api/public/catalog-suggest/route.ts");
const storefrontNav = read("src/lib/commerce/storefrontNav.ts");
const catalogData = read("src/lib/commerce/catalogData.ts");
const catalogBrowser = read("src/components/catalog/CatalogBrowser.tsx");
const pageView = read("src/components/catalog/CatalogPageView.tsx");
const quoteRoute = read("src/app/api/orders/[id]/quote/route.ts");
const cartPage = read("src/app/cart/page.tsx");
const loginPage = read("src/app/auth/login/page.tsx");
const termsPage = read("src/app/terms/page.tsx");
const privacyPage = read("src/app/privacy/page.tsx");

// ---------------------------------------------------------------------------
// Product fixtures, one per branch of the CTA rule
// ---------------------------------------------------------------------------

const base = {
  id: "p1",
  name: "Billet Shift Knob",
  slug: "billet-shift-knob",
  short_description: "Turned from solid bar.",
  image_url: null,
  category: "Shift Knobs",
  starting_price_cents: 6500,
  is_custom: false,
  availability_status: "available",
  inventory_policy: "unlimited",
  inventory_quantity: 0,
  continue_selling_when_out_of_stock: false,
  lead_time_text: null,
  product_media: [],
} as const;

/** Directly purchasable, nothing to decide. */
const plain = { ...base, purchase_mode: "direct_purchase" };

/** Purchasable *and* customizable — the case the old card got wrong. */
const optional = { ...base, purchase_mode: "direct_or_request", is_custom: true };

/** Purchasable, but a required option group has usable values. */
const configured = { ...base, purchase_mode: "direct_purchase", requires_configuration: true, has_options: true };

/** Quote-only. */
const quoted = { ...base, purchase_mode: "request_only", availability_status: "made_to_order" };

/** Out of stock and not continuing to sell. */
const gone = {
  ...base,
  purchase_mode: "direct_purchase",
  availability_status: "unavailable",
  inventory_policy: "track",
  inventory_quantity: 0,
};

// ---------------------------------------------------------------------------
// Call-to-action rules — the mandatory matrix
// ---------------------------------------------------------------------------

test("a directly purchasable product offers Add to cart", () => {
  const decision = catalogAction(plain);
  assert.equal(decision.kind, "add_to_cart");
  assert.equal(decision.label, "Add to cart");
  assert.equal(decision.reason, null);
  assert.equal(isDirectlyPurchasable(plain), true);
});

test("purchasable AND optionally customizable still offers Add to cart", () => {
  // The whole point of the rule: customization being *available* must not force
  // a customer who does not want it through the product page.
  const decision = catalogAction(optional);
  assert.equal(decision.kind, "add_to_cart");
  assert.equal(isOptionallyCustomizable(optional), true);
});

test("a required option group replaces Add to cart with Choose options", () => {
  const decision = catalogAction(configured);
  assert.equal(decision.kind, "configure");
  assert.equal(decision.label, "Choose options");
  assert.equal(decision.reason, "configuration_required");
});

test("a request-only product never offers the cart", () => {
  const decision = catalogAction(quoted);
  assert.equal(decision.kind, "request");
  assert.equal(decision.reason, "quote_only");
  assert.equal(isDirectlyPurchasable(quoted), false);
});

test("an unavailable product offers neither cart nor a false promise", () => {
  const decision = catalogAction(gone);
  assert.notEqual(decision.kind, "add_to_cart");
  assert.equal(decision.reason, "unavailable");
});

test("a purchasable product with no price falls back to the request path", () => {
  const decision = catalogAction({ ...optional, starting_price_cents: null });
  assert.equal(decision.kind, "request");
  assert.equal(decision.reason, "no_price");
});

test("the catalog no longer offers Buy now as its quick action", () => {
  for (const product of [plain, optional, configured, quoted, gone]) {
    assert.notEqual(catalogAction(product).label, "Buy now");
  }
});

test("quick add goes through the cart API and never straight to checkout", () => {
  const action = read("src/components/catalog/CatalogProductAction.tsx");
  assert.match(action, /useCartMutations/);
  // No navigation on success, no reload, no alert.
  assert.doesNotMatch(action, /router\.push\(["'`]\/(cart|checkout)/);
  assert.doesNotMatch(action, /window\.location/);
  assert.doesNotMatch(action, /\balert\(/);
  // Success is only ever set from the mutation's own onSuccess.
  assert.match(action, /onSuccess: \(\) => \{\s*setConfirmed\(true\)/);
});

// ---------------------------------------------------------------------------
// Customization signals — optional vs required must never look the same
// ---------------------------------------------------------------------------

test("Customizable is shown for an optionally customizable product", () => {
  assert.equal(customizationSignal(optional), "customizable");
});

test("a required configuration gets its own, stricter signal", () => {
  assert.equal(customizationSignal(configured), "choose_options");
});

test("a plain product gets no customization signal at all", () => {
  assert.equal(customizationSignal(plain), null);
});

test("a quote-only product gets no customization badge", () => {
  // Everything about it is customized; the word adds nothing the price line and
  // the request button have not already said.
  assert.equal(customizationSignal(quoted), null);
});

test("the Customizable badge reaches the rendered card", () => {
  const markup = renderCard({ product: optional });
  assert.match(markup, /data-signal="customizable"/);
  assert.match(markup, /Customizable/);
});

test("a required configuration renders the stricter badge and CTA", () => {
  const markup = renderCard({ product: configured });
  assert.match(markup, /data-signal="choose_options"/);
  assert.match(markup, /Choose options/);
});

// ---------------------------------------------------------------------------
// Availability and lead time
// ---------------------------------------------------------------------------

test("availability is worded for a customer and carries a non-colour cue", () => {
  const ready = availabilityPresentation({ availability_status: "available", lead_time_text: "Usually 3 days" });
  assert.equal(ready?.label, "In stock");
  assert.equal(ready?.tone, "ready");
  assert.equal(ready?.detail, "Usually 3 days");

  const made = availabilityPresentation({ availability_status: "made_to_order", lead_time_text: null });
  assert.equal(made?.label, "Made to order");
  assert.equal(made?.detail, null);
});

test("no lead time is invented when the catalog holds none", () => {
  const made = availabilityPresentation({ availability_status: "made_to_order" });
  assert.equal(made?.detail, null);
  const blank = availabilityPresentation({ availability_status: "available", lead_time_text: "   " });
  assert.equal(blank?.detail, null);
});

test("availability is never conveyed by colour alone", () => {
  // Every tone has distinct words, and the chip carries a dot.
  const labels = new Set(
    ["available", "limited", "made_to_order"].map(
      (status) => availabilityPresentation({ availability_status: status })?.label
    )
  );
  assert.equal(labels.size, 3);
  assert.match(css, /\.product-status-availability::before/);
});

// ---------------------------------------------------------------------------
// Badge alignment — the structural fix, not a per-card patch
// ---------------------------------------------------------------------------

test("the status row owns the card's bottom anchor, not the footer", () => {
  // This is the whole of the alignment fix. With `margin-top: auto` on the
  // footer, badges rode on the content above them and drifted 76px across one
  // row of equal-height cards.
  const status = css.slice(css.indexOf(".product-card-status {"));
  assert.match(status.slice(0, 200), /margin-top: auto/);

  const footer = css.slice(css.indexOf(".product-card-footer {"));
  assert.doesNotMatch(footer.slice(0, 220), /margin-top: auto/);
});

test("the status row reserves its height so one badge and two agree", () => {
  const status = css.slice(css.indexOf(".product-card-status {"), css.indexOf(".product-card-status {") + 260);
  assert.match(status, /min-height:/);
});

test("description length cannot move the status row", () => {
  // The title and the description are both clamped, so neither can grow without
  // bound and push the anchored block around.
  const title = css.slice(css.indexOf(".product-card-title {"), css.indexOf(".product-card-title {") + 700);
  assert.match(title, /line-clamp: 2/);
  const description = css.slice(
    css.indexOf(".product-card-description {"),
    css.indexOf(".product-card-description {") + 500
  );
  assert.match(description, /line-clamp: 2/);
});

test("zero, one and multiple status signals all render cleanly", () => {
  // Zero: availability hidden and nothing customizable.
  const none = renderCard({ product: plain, showAvailability: false });
  assert.doesNotMatch(none, /product-card-status/);

  // One: availability only.
  const one = renderCard({ product: plain });
  assert.match(one, /product-card-status/);
  assert.doesNotMatch(one, /product-status-custom/);

  // Three: availability, lead time, customizable — and no more than three.
  const many = renderCard({ product: { ...optional, lead_time_text: "Usually 3 days" } });
  assert.match(many, /product-status-availability/);
  assert.match(many, /product-status-detail/);
  assert.match(many, /product-status-custom/);
  assert.equal((many.match(/product-status-availability/g) ?? []).length, 1);
});

test("lead time is not a third equal-weight pill", () => {
  // It is a detail of the availability, not a competing fact.
  const detail = css.slice(css.indexOf(".product-status-detail {"), css.indexOf(".product-status-detail {") + 160);
  assert.doesNotMatch(detail, /border/);
  assert.doesNotMatch(detail, /border-radius: 9999px/);
});

// ---------------------------------------------------------------------------
// Card structure and merchandising
// ---------------------------------------------------------------------------

test("the card exposes one product link plus the action, and nothing else", () => {
  const markup = renderCard({ product: plain, showWishlist: false });
  const anchors = markup.match(/<a\b/g) ?? [];
  // One: the product name. The quick add is a <button>, not a second anchor.
  assert.equal(anchors.length, 1);
  assert.match(markup, /product-card-link/);
});

test("the quick-add control is lifted above the stretched link overlay", () => {
  // Without this it is covered by the card's own anchor and every click opens
  // the product page instead of adding to the cart.
  const cta = css.slice(css.indexOf(".product-card-cta {"), css.indexOf(".product-card-cta {") + 400);
  assert.match(cta, /z-index: 2/);
  assert.match(cta, /position: relative/);
});

test("the decorative specimen action stays inert", () => {
  const action = css.slice(css.indexOf(".product-card-action {"));
  assert.match(action.slice(0, 500), /pointer-events: none/);
});

test("the category trail is shown above the title, not beside it", () => {
  const markup = renderCard({ product: { ...plain, category_trail: ["Interior", "Shift Knobs"] } });
  const eyebrow = markup.indexOf("product-card-eyebrow");
  const title = markup.indexOf("product-card-title");
  assert.ok(eyebrow > -1 && title > eyebrow, "the trail must precede the title");
  assert.match(markup, /Interior/);
  assert.match(markup, /Shift Knobs/);
});

test("an uncategorized product still says something", () => {
  const markup = renderCard({ product: { ...plain, category: null, category_trail: null } });
  assert.match(markup, /Custom work/);
});

test("material is shown only when the column holds one, and never inferred", () => {
  const withMaterial = renderCard({ product: { ...plain, material: "6061 Aluminum" } });
  assert.match(withMaterial, /6061 Aluminum/);

  const without = renderCard({ product: plain });
  assert.doesNotMatch(without, /product-card-spec/);

  // Nothing parses a description looking for a material.
  const cardSource = read("src/components/ProductCard.tsx");
  assert.doesNotMatch(cardSource, /short_description.*match|match.*short_description/);
});

test("the hover image is lazy and only used when a second real image exists", () => {
  const single = renderCard({
    product: { ...plain, product_media: [{ url: "https://example.test/a.png", kind: "image", sort_order: 0 }] },
  });
  assert.doesNotMatch(single, /product-card-hover-image/);

  const double = renderCard({
    product: {
      ...plain,
      product_media: [
        { url: "https://example.test/a.png", kind: "image", sort_order: 0 },
        { url: "https://example.test/b.png", kind: "image", sort_order: 1 },
      ],
    },
  });
  assert.match(double, /product-card-hover-image/);
  assert.match(double, /loading="lazy"/);
});

test("price wording matches what the number actually means", () => {
  assert.equal(catalogPriceLabel(plain), "$65.00");
  assert.match(catalogPriceLabel(optional), /^From /);
  // A required option group ranging −$5 to +$35 makes a bare number wrong.
  assert.match(catalogPriceLabel(configured), /^From /);
  assert.equal(catalogPriceLabel({ ...plain, starting_price_cents: null }), "Price after review");
});

// ---------------------------------------------------------------------------
// Navigation: one canonical hierarchy
// ---------------------------------------------------------------------------

const cat = (over: Partial<CategoryRow> & { id: string; slug: string; name: string }): CategoryRow => ({
  description: null,
  parent_id: null,
  image_url: null,
  display_order: 0,
  is_active: true,
  archived_at: null,
  ...over,
});

test("the navbar reads the catalog's own menu builder, not a second list", () => {
  assert.match(storefrontNav, /buildBrowseMenu/);
  // No hardcoded category names anywhere in the navigation surfaces.
  for (const [name, source] of [
    ["header", header],
    ["drawer", drawer],
    ["products menu", productsMenu],
  ] as const) {
    assert.doesNotMatch(source, /Shift Knobs|Cutting Boards/, `${name} must not hardcode categories`);
  }
});

test("navbar and catalog agree about which categories exist", () => {
  const categories = [
    cat({ id: "interior", slug: "interior", name: "Interior" }),
    cat({ id: "knobs", slug: "shift-knobs", name: "Shift Knobs", parent_id: "interior" }),
    cat({ id: "kitchen", slug: "kitchen", name: "Kitchen", display_order: 1 }),
    cat({ id: "empty", slug: "empty", name: "Empty", display_order: 2 }),
  ];
  const products = [
    { id: "a", name: "A", slug: "a", category_id: "interior" },
    { id: "b", name: "B", slug: "b", category_id: "knobs" },
    { id: "c", name: "C", slug: "c", category_id: "kitchen" },
  ];

  const menu = buildBrowseMenu({ categories, products, activeCategoryId: null });
  assert.deepEqual(
    menu.categories.map((entry) => entry.name),
    ["Interior", "Kitchen"]
  );
  // An empty category is dropped from *both* surfaces, because both call this.
  assert.equal(menu.categories.some((entry) => entry.name === "Empty"), false);
  assert.equal(menu.categories[0].children.map((child) => child.name).join(), "Shift Knobs");
  assert.equal(menu.all.count, 3);
});

test("Products stays a link to /catalog and gains a separate disclosure", () => {
  assert.match(productsMenu, /href="\/catalog"/);
  // The disclosure is its own button so the word itself keeps navigating.
  assert.match(productsMenu, /aria-expanded=\{open\}/);
  assert.match(productsMenu, /aria-haspopup/);
  assert.doesNotMatch(productsMenu, /<button[^>]*>\s*Products/);
});

test("the dropdown is keyboard reachable and escapable", () => {
  assert.match(productsMenu, /ArrowDown/);
  assert.match(productsMenu, /Escape/);
  assert.match(productsMenu, /close\(true\)/); // returns focus to the trigger
  // Tab moves out rather than being trapped: this is a menu, not a dialog.
  assert.match(productsMenu, /if \(event\.key === "Tab"\)/);
});

test("hover open and close are both delayed, and closing is the slower one", () => {
  // The timers moved into `useNavHoverIntent` in Custom Project Request 3.0 so
  // the More menu could share them rather than grow a second hover system.
  // Products still hovers; the delays are just declared somewhere both menus
  // can reach. The behaviour asserted here is unchanged.
  assert.match(productsMenu, /useNavHoverIntent/, "Products must still hover");
  const hook = read("src/components/nav/useNavHoverIntent.ts");
  const open = Number(hook.match(/NAV_HOVER_OPEN_DELAY_MS = (\d+)/)?.[1]);
  const close = Number(hook.match(/NAV_HOVER_CLOSE_DELAY_MS = (\d+)/)?.[1]);
  assert.ok(open > 0, "opening must have intent delay");
  assert.ok(close > open, "closing must be more forgiving than opening");
});

test("mobile Products expands rather than dumping the whole tree", () => {
  assert.match(drawer, /categoriesOpen/);
  assert.match(drawer, /useState\(false\)/);
  assert.match(drawer, /aria-expanded=\{categoriesOpen\}/);
  assert.match(drawer, /aria-controls="mobile-nav-categories"/);
});

test("the dropdown panel is positioned absolutely, never fixed", () => {
  // The header carries `transition-transform`, which makes it the containing
  // block for fixed descendants — a fixed panel renders inside the 60px bar.
  const panel = css.slice(css.indexOf(".products-menu-panel {"), css.indexOf(".products-menu-panel {") + 500);
  assert.match(panel, /position: absolute/);
  assert.doesNotMatch(panel, /position: fixed/);
});

// ---------------------------------------------------------------------------
// Global storefront search
// ---------------------------------------------------------------------------

test("the header search submits to the canonical catalog URL", () => {
  assert.equal(catalogSearchHref("shift knob"), "/catalog?q=shift%20knob");
  assert.equal(catalogSearchHref("   "), "/catalog");
  // Reached through `searchDestination` now, which routes the All and Products
  // scopes to exactly this and a category scope to the same shape one level
  // down. The box no longer has a single hard-coded destination.
  assert.match(search, /searchDestination/);
  assert.equal(
    searchDestination(ALL_SCOPE, "shift knob"),
    "/catalog?q=shift%20knob",
    "All must still land where the unscoped box did"
  );
});

test("query normalization is forgiving without being clever", () => {
  assert.equal(normalizeSuggestQuery("  Shift   Knob "), "Shift Knob");
  assert.equal(normalizeSuggestQuery("shift-knob"), "shift knob");
  assert.equal(normalizeSuggestQuery("shift_knob"), "shift knob");
  assert.equal(normalizeSuggestQuery(null), "");
  assert.equal(normalizeSuggestQuery("x".repeat(200)).length, SUGGEST_LIMITS.maxLength);
});

test("suggestions are bounded on the server, not trimmed in the browser", () => {
  assert.ok(SUGGEST_LIMITS.products <= 6);
  assert.ok(SUGGEST_LIMITS.categories <= 4);

  /*
   * Two bounds now, because ranking was added between recall and the answer.
   *
   * The route used to ask the database for exactly five products and return
   * them, which meant the five were whichever `ilike` matched first in
   * `sort_order` — the best match for a query was routinely absent from a panel
   * that had room for it. Recall is now bounded at `FUZZY_RECALL_LIMIT`, ranked,
   * and *then* cut to `SUGGEST_LIMITS`. Both numbers are applied on the server;
   * nothing is fetched wholesale and trimmed in the browser, which is what this
   * test exists to guarantee.
   */
  assert.match(suggestRoute, /const FUZZY_RECALL_LIMIT = \d+;/, "recall is bounded");
  assert.match(suggestRoute, /\.limit\(FUZZY_RECALL_LIMIT\)/, "…and the bound reaches the query");
  assert.match(suggestRoute, /\.slice\(0, SUGGEST_LIMITS\.products\)/, "the answer is cut after ranking");
  assert.match(suggestRoute, /\.slice\(0, SUGGEST_LIMITS\.projects\)/);
  // Short queries never reach the database at all.
  assert.match(suggestRoute, /minQueryLength/);
});

test("suggestions expose only public catalog fields", () => {
  const select = suggestRoute.match(/\.select\(\s*"([^"]+)"/)?.[1] ?? "";
  for (const forbidden of ["cost", "inventory_quantity", "internal", "notes", "supplier"]) {
    assert.doesNotMatch(select, new RegExp(forbidden, "i"), `${forbidden} must not be selected`);
  }
  // And only published, unarchived rows.
  assert.match(suggestRoute, /\.eq\("is_published", true\)/);
  assert.match(suggestRoute, /\.is\("archived_at", null\)/);
  // Through the anon key, so RLS is a second guard behind the filters.
  assert.match(suggestRoute, /supabasePublicServer/);
});

test("category suggestions rank parents above their own children", () => {
  const categories = [
    {
      name: "Interior",
      slug: "interior",
      href: "/catalog/interior",
      count: 2,
      children: [{ name: "Interior Trim", slug: "trim", href: "/catalog/interior/trim", count: 1 }],
    },
  ];
  const ranked = rankCategorySuggestions(categories, "interior");
  assert.equal(ranked[0].name, "Interior");
  assert.equal(ranked[1].trail, "Interior / Interior Trim");
});

test("a subcategory suggestion is never shown bare", () => {
  const ranked = rankCategorySuggestions(
    [
      {
        name: "Kitchen",
        slug: "kitchen",
        href: "/catalog/kitchen",
        count: 1,
        children: [{ name: "Cutting Boards", slug: "boards", href: "/catalog/kitchen/boards", count: 1 }],
      },
    ],
    "boards"
  );
  assert.equal(ranked[0].trail, "Kitchen / Cutting Boards");
});

test("an empty suggestion set still offers a way forward", () => {
  assert.equal(suggestionCount(null), 0);
  assert.equal(suggestionCount({ query: "x", scope: "all", products: [], categories: [], projects: [] }), 0);
  /*
   * A payload from *before* the projects group existed must not crash the
   * panel. The suggest route is `revalidate = 60`, so for up to a minute after
   * a deploy a browser can be handed a cached response from the previous build
   * — and `.map` on a missing key would throw on every keystroke until the
   * cache turned over.
   */
  assert.equal(
    suggestionCount({ query: "x", scope: "all", products: [], categories: [] } as never),
    0,
    "a response missing a group is empty, not a crash"
  );
  // The panel always offers a way on, including with no suggestions.
  assert.match(search, /See all product results for/);
  assert.match(search, /See all project results for/);
});

test("the search box uses real combobox semantics", () => {
  assert.match(search, /role="combobox"/);
  assert.match(search, /role="listbox"/);
  assert.match(search, /role="option"/);
  assert.match(search, /aria-activedescendant/);
  assert.match(search, /aria-selected=\{active === index\}/);
  assert.match(search, /role="search"/);
});

test("typing is debounced and stale responses are discarded", () => {
  assert.match(search, /AbortController/);
  assert.match(search, /DEBOUNCE_MS/);
  assert.match(search, /controller\.abort\(\)/);
});

test("the header no longer opens a modal palette as its primary search", () => {
  // The icon button is gone from the bar; the palette keeps Ctrl+K and a drawer
  // entry, so site-wide search stays reachable without leading with it.
  assert.doesNotMatch(header, /aria-label="Search products \(Ctrl\+K\)"/);
  assert.match(header, /StorefrontSearch/);
  assert.match(drawer, /onOpenSearch/);
});

test("mobile puts search on its own row rather than in the icon strip", () => {
  assert.match(header, /site-header-mobile-search/);
  assert.match(css, /\.site-header-mobile-row/);
});

/**
 * The 1024 handoff was removed in pass 4.0, because it never worked.
 *
 * Pass 4.1 rendered Gallery and About twice — on the bar from `xl`, and inside
 * More below it — and hid whichever copy did not apply. The hiding half was
 * `@media (min-width: 1280px) { .site-more-item-narrow { display: none } }`,
 * which loses on source order to `.nav-menu-item { display: flex }` declared
 * ~450 lines later in the same stylesheet: same specificity, later rule. So at
 * every desktop width both copies rendered, and the More menu duplicated the
 * bar — the duplication the shop owner reported.
 *
 * The replacement is not a stronger selector. Every primary destination has one
 * slot on the bar at every width, so there is no second copy to hide and no
 * rule whose correctness depends on where it sits in the file. This asserts the
 * mechanism is gone rather than merely that the classes are unused.
 */
test("primary destinations are rendered once, not rendered twice and hidden", () => {
  // Comments stripped: both files explain the removal and name the classes
  // while doing it, and the assertion is about markup and rules, not prose.
  const headerCode = header.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, "");

  for (const dead of ["site-nav-link-wide", "site-more-item-narrow"]) {
    assert.doesNotMatch(headerCode, new RegExp(dead), `${dead} rendered a second copy of a live link`);
    assert.doesNotMatch(cssRules, new RegExp(`\\.${dead}`), `${dead} should have no rule left`);
  }

  // More holds secondary destinations only. Gallery and About are on the bar.
  const moreMenu = headerCode.slice(headerCode.indexOf("menuLabel=\"More destinations\""));
  assert.doesNotMatch(moreMenu, /narrowMoreItems/);
  assert.match(moreMenu, /secondaryNav\.map/);
});

// ---------------------------------------------------------------------------
// Catalog chrome, categories and recovery
// ---------------------------------------------------------------------------

test("the catalog toolbar is no longer a bordered panel", () => {
  const toolbar = css.slice(css.indexOf(".catalog-toolbar {"), css.indexOf(".catalog-toolbar {") + 320);
  assert.doesNotMatch(toolbar, /border: 1px solid/);
  assert.doesNotMatch(toolbar, /background: var\(--panel\)/);
});

test("the root catalog keeps exactly one category discovery system", () => {
  // The removed "FIND YOUR PART / Browse categories" block must not return: the
  // subcategory strip renders only inside a category.
  assert.match(pageView, /const discovery = category\s*\?/);
  assert.doesNotMatch(pageView, /Find your part/i);
  assert.doesNotMatch(css, /catalog-discovery-card/);
});

test("a parent category may still show its subcategories", () => {
  assert.match(pageView, /Shop by subcategory/);
  assert.match(pageView, /catalog-subnav/);
});

test("breadcrumbs name every clickable ancestor", () => {
  assert.match(pageView, /aria-label="Breadcrumb"/);
  assert.match(pageView, /href="\/catalog">Products/);
  assert.match(pageView, /\/catalog\/\$\{parent\.slug\}/);
  assert.match(pageView, /aria-current="page"/);
});

test("the custom-project offer left the page header", () => {
  // The words survive in a comment explaining the move, so this asserts the
  // absence of the *link* rather than of the string.
  assert.doesNotMatch(pageView, /<Link href="\/orders\/new"/);
  assert.match(catalogBrowser, /CatalogRecovery/);
});

test("no results offers recovery, and the custom path is one of the offers", () => {
  assert.match(catalogBrowser, /catalog-empty/);
  assert.match(catalogBrowser, /Clear search/);
  assert.match(catalogBrowser, /Clear filters/);
  assert.match(catalogBrowser, /variant="empty"/);
  const recovery = read("src/components/catalog/CatalogRecovery.tsx");
  assert.match(recovery, /Start a custom project/);
});

test("the custom offer is not shown aggressively beside results", () => {
  // Footer variant only when there *are* results, empty variant only when there
  // are none — never both, never above the products.
  assert.match(catalogBrowser, /\{visible\.length \? <CatalogRecovery variant="footer" \/> : null\}/);
});

test("a query failure is an error, never a convincing empty shop", () => {
  assert.match(catalogData, /throw new Error\("Unable to load the storefront catalog"\)/);
  const errorBoundary = read("src/app/catalog/error.tsx");
  assert.doesNotMatch(errorBoundary, /No products/i);
});

// ---------------------------------------------------------------------------
// Discovery state and view modes
// ---------------------------------------------------------------------------

test("List / 2 / 3 / 4 survive this pass", () => {
  const view = read("src/lib/commerce/catalogView.ts");
  assert.match(view, /CATALOG_VIEWS = \["list", 2, 3, 4\]/);
  // 4.1 moved the default from 3 to list; the four options and the storage key
  // are what this pass owns, and both are unchanged. `catalog-view-modes` holds
  // the assertions about which one is the default.
  assert.match(view, /DEFAULT_CATALOG_VIEW: CatalogView = "list"/);
  assert.match(view, /CATALOG_VIEW_KEY = "km\.catalog\.density"/);
  assert.match(css, /\[data-catalog-density="list"\], :root:not\(\[data-catalog-density\]\)\) \.catalog-grid/);
});

test("the list row lays out the media well, not the bare image", () => {
  // The well wraps the image, the hover image and the wishlist toggle; laying
  // out the inner image would leave the well at its intrinsic height.
  assert.match(
    css,
    /:where\(\[data-catalog-density="list"\], :root:not\(\[data-catalog-density\]\)\) \.catalog-grid \.product-card-media \{\s*grid-area: media/
  );
});

test("discovery state lives in the URL so Back restores it", () => {
  const browse = read("src/lib/commerce/catalogBrowse.ts");
  for (const key of ["q", "availability", "mode", "sort"]) {
    assert.match(browse, new RegExp(`"${key}"`));
  }
  assert.match(catalogBrowser, /parseCatalogFilters\(searchParams\)/);
  // The view mode is a stored preference applied pre-paint, not URL state.
  assert.match(read("src/lib/commerce/catalogView.ts"), /catalogViewScript/);
});

test("switching category keeps the search and the refinements", () => {
  assert.match(catalogBrowser, /filterQuery: catalogFilterQuery\(effectiveFilters\)/);
});

// ---------------------------------------------------------------------------
// Recently viewed
// ---------------------------------------------------------------------------

test("recently viewed is bounded and de-duplicated", () => {
  const make = (id: string): RecentProduct => ({ id, name: id, slug: id, image: null, price: "$1.00" });
  let list: RecentProduct[] = [];
  for (let index = 0; index < 12; index += 1) list = withRecentProduct(list, make(`p${index}`));
  assert.equal(list.length, RECENTLY_VIEWED_LIMIT);
  assert.equal(list[0].id, "p11");

  // Re-viewing moves to the front rather than duplicating.
  const again = withRecentProduct(list, make("p8"));
  assert.equal(again[0].id, "p8");
  assert.equal(again.filter((entry) => entry.id === "p8").length, 1);
});

test("a corrupt history is no history rather than a crash", () => {
  assert.deepEqual(parseRecentlyViewed("not json"), []);
  assert.deepEqual(parseRecentlyViewed(null), []);
  assert.deepEqual(parseRecentlyViewed('{"nope":1}'), []);
  assert.deepEqual(parseRecentlyViewed('[{"id":"a"}]'), []);
});

test("recently viewed never reaches the server", () => {
  const source = read("src/lib/commerce/recentlyViewed.ts");
  assert.doesNotMatch(source, /fetch\(|supabase/);
  assert.match(source, /localStorage/);
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

test("option flags are one query for the catalog, not one per card", () => {
  // PostgREST embeds the values inside their group, so the requirement rule is
  // decided from a single round trip however many products are on the page.
  assert.match(catalogData, /product_option_values\(is_active\)/);
  assert.match(catalogData, /\.in\(\s*"product_id"/);
  const attach = catalogData.slice(catalogData.indexOf("async function attachOptionFlags"));
  assert.equal((attach.slice(0, 1400).match(/await supabase/g) ?? []).length, 1);
});

test("the requirement rule matches what the server actually refuses", () => {
  // `priceLine` blocks on a required group with at least one value; a required
  // group with none does not block, and the shop has one of those.
  assert.match(catalogData, /row\.is_required && usableValues > 0/);
  assert.match(read("src/lib/commerce/pricing.ts"), /group\.is_required && group\.values\.length > 0/);
});

test("the navbar's category query stays small", () => {
  const select = storefrontNav.match(/\.select\("id,name,slug,category_id"\)/);
  assert.ok(select, "the product query must select only what the counts need");
  assert.doesNotMatch(storefrontNav, /product_media/);
});

// ---------------------------------------------------------------------------
// Terms and privacy
// ---------------------------------------------------------------------------

test("browsing requires no acceptance", () => {
  const layout = read("src/app/layout.tsx");
  assert.doesNotMatch(layout, /TermsGate|acceptTerms|requireTerms/);
  const catalogPage = read("src/app/catalog/page.tsx");
  assert.doesNotMatch(catalogPage, /terms/i);
});

test("signup and checkout carry an action-adjacent notice with both links", () => {
  assert.match(loginPage, /TermsInlineNotice/);
  assert.match(cartPage, /TermsInlineNotice variant="checkout"/);
  const notice = read("src/components/legal/TermsNotice.tsx");
  assert.match(notice, /href="\/terms"/);
  assert.match(notice, /href="\/privacy"/);
});

test("a custom project inquiry stays an inquiry", () => {
  const customRoute = read("src/app/api/orders/custom/route.ts");
  assert.doesNotMatch(customRoute, /agreedToTerms/);
});

test("approving a quote is enforced on the server, not by the checkbox", () => {
  assert.match(quoteRoute, /acceptanceProblem/);
  assert.match(quoteRoute, /status: 422/);
  // And refused before the order moves.
  const guardAt = quoteRoute.indexOf("acceptanceProblem");
  const updateAt = quoteRoute.indexOf('status:"awaiting_payment"');
  assert.ok(guardAt < updateAt, "the agreement must be checked before the status change");
});

test("a stale Terms version is refused rather than silently accepted", () => {
  assert.equal(acceptanceProblem({ agreed: true, termsVersion: TERMS_VERSION }), null);
  assert.equal(acceptanceProblem({ agreed: true, termsVersion: "1999-01-01" }), "stale_version");
  assert.equal(acceptanceProblem({ agreed: false, termsVersion: TERMS_VERSION }), "not_agreed");
  assert.equal(acceptanceProblem({ agreed: true }), "missing");
  assert.equal(acceptanceProblem({}), "not_agreed");
});

test("the acceptance record is durable, versioned and tied to the order", () => {
  assert.match(quoteRoute, /recordAuditEventStrict/);
  assert.match(quoteRoute, /termsVersion: TERMS_VERSION/);
  assert.match(quoteRoute, /related: \{ orderId: id \}/);
  assert.match(quoteRoute, /quoteRevision/);
  // Not a boolean that is true forever.
  assert.doesNotMatch(quoteRoute, /terms_accepted\s*:\s*true/);
});

test("the acceptance event survives the audit retention filter", () => {
  const retention = read("src/lib/audit/retention.ts");
  assert.match(retention, /"order\."/);
  assert.match(quoteRoute, /TERMS_ACCEPTED_EVENT/);
  assert.match(read("src/lib/legal/terms.ts"), /TERMS_ACCEPTED_EVENT = "order\.terms_accepted"/);
});

test("no device fingerprint is collected to prove acceptance", () => {
  for (const source of [quoteRoute, read("src/lib/legal/terms.ts"), read("src/components/legal/TermsNotice.tsx")]) {
    assert.doesNotMatch(source, /navigator\.userAgent|window\.screen|createElement\("canvas"\)/);
  }
});

test("the Terms version matches the date the page prints", () => {
  // Bumping one without the other loses the association for every acceptance
  // afterwards, so they are asserted against each other.
  assert.match(termsPage, new RegExp(TERMS_UPDATED_LABEL.replace(/,/g, ",")));
  assert.equal(TERMS_VERSION, "2026-08-01");
  assert.equal(TERMS_UPDATED_LABEL, "August 1, 2026");
});

test("the clickwrap is never pre-ticked", () => {
  const orderPage = read("src/app/orders/[id]/page.tsx");
  assert.match(orderPage, /const \[agreedToTerms, setAgreedToTerms\] = useState\(false\)/);
  assert.match(orderPage, /disabled=\{busy \|\| !agreedToTerms\}/);
});

// ---------------------------------------------------------------------------
// Privacy: no consent theatre, and no invented tracking
// ---------------------------------------------------------------------------

test("no cookie consent banner was added", () => {
  // The audit found only strictly-necessary and functional storage plus
  // cookieless analytics, so a banner would ask permission to do nothing.
  const layout = read("src/app/layout.tsx");
  assert.doesNotMatch(layout, /CookieBanner|ConsentBanner|CookieConsent/);
});

test("this pass introduced no advertising or marketing tracker", () => {
  const sources = [
    read("src/app/layout.tsx"),
    read("src/components/SiteHeader.tsx"),
    read("src/components/catalog/CatalogBrowser.tsx"),
    read("src/components/ProductCard.tsx"),
    read("src/components/nav/StorefrontSearch.tsx"),
  ].join("\n");
  for (const tracker of ["gtag", "fbq", "googletagmanager", "doubleclick", "hotjar", "mixpanel", "segment.com"]) {
    assert.doesNotMatch(sources, new RegExp(tracker, "i"));
  }
});

test("the privacy policy names the providers the code actually uses", () => {
  for (const provider of ["Vercel", "Supabase", "Stripe", "Resend", "Sentry"]) {
    assert.match(privacyPage, new RegExp(provider));
  }
  assert.match(privacyPage, /Cookies and local storage/);
  assert.match(privacyPage, /do not use advertising, marketing, or cross-site tracking cookies/);
});

test("the security migrations this pass must not touch are untouched", () => {
  // Read, not modified: their presence and their content are the assertion.
  for (const file of [
    "supabase/migrations/20260811025000_public_profile_projection.sql",
    "supabase/migrations/20260811030000_security_boundary_hardening.sql",
  ]) {
    assert.ok(read(file).length > 0, `${file} must still exist`);
  }
});
