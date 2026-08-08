import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  activeFilterCount,
  applyCatalogFilters,
  AVAILABILITY_OPTIONS,
  buildBrowseMenu,
  catalogFilterQuery,
  CATALOG_AVAILABILITY,
  CATALOG_MODES,
  CATALOG_SORTS,
  categoryPath,
  filtersAreDefault,
  legacyCategoryTarget,
  MODE_OPTIONS,
  parseCatalogFilters,
  productsInCategory,
  resolveCategoryPath,
  SORT_OPTIONS,
  DEFAULT_FILTERS,
} from "../src/lib/commerce/catalogBrowse.ts";
import type { CategoryRow } from "../src/lib/commerce/categories.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const browser = read("src/components/catalog/CatalogBrowser.tsx");
const drawer = read("src/components/catalog/CatalogBrowseDrawer.tsx");
const view = read("src/components/catalog/CatalogPageView.tsx");
const catalogPage = read("src/app/catalog/page.tsx");
const slugPage = read("src/app/catalog/[slug]/page.tsx");
const subPage = read("src/app/catalog/[slug]/[subcategory]/page.tsx");
const migration = read("supabase/migrations/20260806040000_catalog_slug_namespace.sql");
const css = read("src/app/globals.css");

const category = (over: Partial<CategoryRow> & { id: string; slug: string; name: string }): CategoryRow => ({
  description: null,
  parent_id: null,
  image_url: null,
  display_order: 0,
  is_active: true,
  archived_at: null,
  ...over,
});

const INTERIOR = category({ id: "c-int", slug: "interior", name: "Interior" });
const KNOBS = category({ id: "c-knob", slug: "shift-knobs", name: "Shift knobs", parent_id: "c-int", display_order: 0 });
const TRIM = category({ id: "c-trim", slug: "trim", name: "Trim", parent_id: "c-int", display_order: 1 });
const EXTERIOR = category({ id: "c-ext", slug: "exterior", name: "Exterior", display_order: 1 });
const HIDDEN = category({ id: "c-hid", slug: "hidden", name: "Hidden", is_active: false });
const CATEGORIES = [INTERIOR, KNOBS, TRIM, EXTERIOR, HIDDEN];

const product = (id: string, over: Partial<Record<string, unknown>> = {}) => ({
  id,
  name: `Product ${id}`,
  slug: `product-${id}`,
  category_id: null as string | null,
  purchase_mode: "direct_purchase",
  availability_status: "available",
  starting_price_cents: 1000,
  created_at: "2026-01-01T00:00:00Z",
  ...over,
});

const PRODUCTS = [
  product("a", { category_id: "c-knob", name: "Billet knob", starting_price_cents: 4000, created_at: "2026-03-01T00:00:00Z" }),
  product("b", { category_id: "c-trim", name: "Trim ring", starting_price_cents: 2000, availability_status: "limited" }),
  product("c", { category_id: "c-int", name: "Interior plate", starting_price_cents: null, purchase_mode: "request_only" }),
  product("d", { category_id: "c-ext", name: "Exterior badge", starting_price_cents: 3000, created_at: "2026-05-01T00:00:00Z" }),
  product("e", { category_id: null, name: "Uncategorized thing" }),
];

// ---------------------------------------------------------------------------
// Filters live in the URL, and are total
// ---------------------------------------------------------------------------

test("filters parse from a URL and are total", () => {
  assert.deepEqual(parseCatalogFilters(new URLSearchParams("")), DEFAULT_FILTERS);
  assert.deepEqual(
    parseCatalogFilters(new URLSearchParams("q=knob&availability=limited&mode=request_only&sort=name")),
    { query: "knob", availability: "limited", mode: "request_only", sort: "name" }
  );
});

test("an unknown filter value is dropped, never carried", () => {
  const parsed = parseCatalogFilters(
    new URLSearchParams("availability=drop%20table&mode=../../etc&sort=%27%20or%201%3D1")
  );
  assert.deepEqual(parsed, DEFAULT_FILTERS);
});

test("filters round-trip through the query string, canonically", () => {
  const filters = { query: "shift knob", availability: "limited" as const, mode: "all" as const, sort: "name" as const };
  const query = catalogFilterQuery(filters);
  assert.deepEqual(parseCatalogFilters(new URLSearchParams(query.slice(1))), filters);
  // Defaults are omitted, so one view has one URL.
  assert.equal(catalogFilterQuery(DEFAULT_FILTERS), "");
  assert.ok(filtersAreDefault(DEFAULT_FILTERS));
  assert.equal(activeFilterCount(filters), 3);
});

test("a search term is bounded", () => {
  const long = "x".repeat(500);
  assert.equal(parseCatalogFilters(new URLSearchParams(`q=${long}`)).query.length, 80);
});

test("plain search-param objects work too, for the server component", () => {
  assert.equal(parseCatalogFilters({ sort: "price-low" }).sort, "price-low");
  assert.equal(parseCatalogFilters({ sort: ["price-low", "name"] }).sort, "price-low");
});

test("every offered option is a value the parser accepts", () => {
  // A control offering a value the parser drops is a filter that silently does
  // nothing. Deriving one from the other is what makes that unrepresentable.
  assert.deepEqual(AVAILABILITY_OPTIONS.map((o) => o.value), [...CATALOG_AVAILABILITY]);
  assert.deepEqual(MODE_OPTIONS.map((o) => o.value), [...CATALOG_MODES]);
  assert.deepEqual(SORT_OPTIONS.map((o) => o.value), [...CATALOG_SORTS]);
});

// ---------------------------------------------------------------------------
// Applying them
// ---------------------------------------------------------------------------

test("search, availability and purchase type all narrow the list", () => {
  assert.equal(applyCatalogFilters(PRODUCTS, { ...DEFAULT_FILTERS, query: "knob" }).length, 1);
  assert.equal(applyCatalogFilters(PRODUCTS, { ...DEFAULT_FILTERS, availability: "limited" }).length, 1);
  assert.equal(applyCatalogFilters(PRODUCTS, { ...DEFAULT_FILTERS, mode: "request_only" }).length, 1);
});

test("sorting is deterministic and puts unpriced products where they belong", () => {
  const low = applyCatalogFilters(PRODUCTS, { ...DEFAULT_FILTERS, sort: "price-low" });
  // An unpriced product sorts last on price-low rather than reading as free.
  assert.equal(low[low.length - 1].id, "c");
  const high = applyCatalogFilters(PRODUCTS, { ...DEFAULT_FILTERS, sort: "price-high" });
  assert.equal(high[0].id, "a");
  const newest = applyCatalogFilters(PRODUCTS, { ...DEFAULT_FILTERS, sort: "newest" });
  assert.equal(newest[0].id, "d");
});

test("featured keeps the order staff arranged", () => {
  const featured = applyCatalogFilters(PRODUCTS, DEFAULT_FILTERS);
  assert.deepEqual(featured.map((p) => p.id), PRODUCTS.map((p) => p.id));
});

// ---------------------------------------------------------------------------
// The browse menu
// ---------------------------------------------------------------------------

test("the menu counts a parent's whole branch, and every count is exact", () => {
  const menu = buildBrowseMenu({ categories: CATEGORIES, products: PRODUCTS, activeCategoryId: null });
  assert.equal(menu.all.count, 5);
  const interior = menu.categories.find((entry) => entry.slug === "interior");
  // 1 directly in Interior + 1 in Shift knobs + 1 in Trim.
  assert.equal(interior?.count, 3);
  assert.deepEqual(interior?.children.map((child) => child.count), [1, 1]);
});

test("an empty category is not offered, and a hidden one is not either", () => {
  const menu = buildBrowseMenu({
    categories: [...CATEGORIES, category({ id: "c-empty", slug: "empty", name: "Empty", display_order: 9 })],
    products: PRODUCTS,
    activeCategoryId: null,
  });
  const slugs = menu.categories.map((entry) => entry.slug);
  assert.ok(!slugs.includes("empty"), "a category that always opens an empty page is a wasted click");
  assert.ok(!slugs.includes("hidden"), "an inactive category is not in the storefront menu");
});

test("the parent stays marked while a subcategory is current, without claiming to be it", () => {
  const menu = buildBrowseMenu({ categories: CATEGORIES, products: PRODUCTS, activeCategoryId: KNOBS.id });
  const interior = menu.categories.find((entry) => entry.slug === "interior");
  assert.equal(interior?.isCurrentBranch, true);
  assert.equal(interior?.isActive, false, "only one link may carry aria-current");
  assert.equal(interior?.children.find((child) => child.slug === "shift-knobs")?.isActive, true);

  // Exactly one thing is `isActive` across the whole menu, at every level.
  const actives = [
    menu.all.isActive,
    ...menu.categories.map((entry) => entry.isActive),
    ...menu.categories.flatMap((entry) => entry.children.map((child) => child.isActive)),
  ].filter(Boolean);
  assert.equal(actives.length, 1);
});

test("menu links carry the current filters, so switching category is not a silent reset", () => {
  const menu = buildBrowseMenu({
    categories: CATEGORIES,
    products: PRODUCTS,
    activeCategoryId: null,
    filterQuery: "?sort=name",
  });
  assert.equal(menu.all.href, "/catalog?sort=name");
  assert.equal(menu.categories[0].href, "/catalog/interior?sort=name");
  assert.equal(menu.categories[0].children[0].href, "/catalog/interior/shift-knobs?sort=name");
});

test("the breadcrumb trail is parent-first and only as deep as the tree", () => {
  assert.deepEqual(
    buildBrowseMenu({ categories: CATEGORIES, products: PRODUCTS, activeCategoryId: KNOBS.id }).trail.map((r) => r.slug),
    ["interior", "shift-knobs"]
  );
  assert.deepEqual(
    buildBrowseMenu({ categories: CATEGORIES, products: PRODUCTS, activeCategoryId: INTERIOR.id }).trail.map((r) => r.slug),
    ["interior"]
  );
  assert.deepEqual(
    buildBrowseMenu({ categories: CATEGORIES, products: PRODUCTS, activeCategoryId: null }).trail,
    []
  );
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

test("a two-segment path is checked against both segments", () => {
  assert.equal(resolveCategoryPath(["interior", "shift-knobs"], CATEGORIES)?.id, KNOBS.id);
  // The wrong parent is a 404, not a redirect: accepting it would give one page
  // two addresses and put a wrong parent in the breadcrumb.
  assert.equal(resolveCategoryPath(["exterior", "shift-knobs"], CATEGORIES), null);
  assert.equal(resolveCategoryPath(["interior", "nope"], CATEGORIES), null);
});

test("a subcategory slug alone does not resolve at the top level", () => {
  assert.equal(resolveCategoryPath(["shift-knobs"], CATEGORIES), null);
  assert.equal(resolveCategoryPath(["interior"], CATEGORIES)?.id, INTERIOR.id);
});

test("an inactive or archived category resolves to nothing", () => {
  assert.equal(resolveCategoryPath(["hidden"], CATEGORIES), null);
  const archived = [category({ id: "c-arc", slug: "gone", name: "Gone", archived_at: "2026-01-01T00:00:00Z" })];
  assert.equal(resolveCategoryPath(["gone"], archived), null);
});

test("every category has exactly one canonical path", () => {
  assert.equal(categoryPath(INTERIOR, CATEGORIES), "/catalog/interior");
  assert.equal(categoryPath(KNOBS, CATEGORIES), "/catalog/interior/shift-knobs");
});

test("legacy ?category= links still resolve, by name or by slug", () => {
  assert.equal(legacyCategoryTarget("Interior", CATEGORIES)?.id, INTERIOR.id);
  assert.equal(legacyCategoryTarget("  interior ", CATEGORIES)?.id, INTERIOR.id);
  assert.equal(legacyCategoryTarget("shift-knobs", CATEGORIES)?.id, KNOBS.id);
  assert.equal(legacyCategoryTarget("nonsense", CATEGORIES), null);
  assert.equal(legacyCategoryTarget(null, CATEGORIES), null);
});

test("a category page shows its whole branch", () => {
  assert.deepEqual(productsInCategory(PRODUCTS, INTERIOR.id, CATEGORIES).map((row) => row.id), ["a", "b", "c"]);
  assert.deepEqual(productsInCategory(PRODUCTS, KNOBS.id, CATEGORIES).map((row) => row.id), ["a"]);
});

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

test("all three catalog routes exist and share one loader and one grid", () => {
  for (const [name, source] of [["/catalog", catalogPage], ["/catalog/[slug]", slugPage], ["/catalog/[slug]/[subcategory]", subPage]] as const) {
    assert.match(source, /loadCatalogData/, `${name} must load through the shared loader`);
  }
  for (const [name, source] of [["/catalog", catalogPage], ["/catalog/[slug]/[subcategory]", subPage]] as const) {
    assert.match(source, /CatalogPageView/, `${name} must render the shared view`);
  }
  assert.match(view, /CatalogBrowser/);
});

test("the product route resolves a category before falling through to a product", () => {
  assert.match(slugPage, /loadCategoryBySlug/);
  // Both the page and its metadata branch, or a category page would be served
  // with a product's title.
  const metadata = slugPage.slice(slugPage.indexOf("export async function generateMetadata"));
  assert.match(metadata, /loadCategoryBySlug/);
});

test("a subcategory reached without its parent redirects to its one canonical URL", () => {
  assert.match(slugPage, /category\?\.parent_id\) redirect\(categoryPath/);
});

test("legacy ?category= is redirected rather than served as a second URL", () => {
  assert.match(catalogPage, /legacyCategoryTarget/);
  assert.match(catalogPage, /redirect\(categoryPath/);
});

test("category pages set a canonical that never carries a filter", () => {
  for (const [name, source] of [["/catalog/[slug]", slugPage], ["/catalog/[slug]/[subcategory]", subPage]] as const) {
    assert.match(source, /alternates: \{ canonical: categoryPath\(category, categories\) \}/, `${name} needs a canonical`);
  }
});

test("useSearchParams is wrapped in Suspense, or the route stops prerendering", () => {
  assert.match(browser, /useSearchParams/);
  assert.match(view, /<Suspense/);
});

// ---------------------------------------------------------------------------
// The menu is its own navigation, and works on a phone
// ---------------------------------------------------------------------------

test("the catalog menu is a distinct labelled nav, not a copy of the global navbar", () => {
  assert.match(browser, /aria-label="Browse products"/);
  const header = read("src/components/SiteHeader.tsx");
  // The global bar links to the catalog; it does not list categories, which
  // would give a screen reader two routes to the same place.
  assert.doesNotMatch(header, /catalog-rail-link/);
  assert.doesNotMatch(header, /buildBrowseMenu/);
});

test("the mobile sheet is a real dialog, portalled, trapped and dismissible", () => {
  assert.match(drawer, /createPortal\(/);
  assert.match(drawer, /document\.body/);
  assert.match(drawer, /role="dialog"/);
  assert.match(drawer, /aria-modal="true"/);
  assert.match(drawer, /aria-labelledby="catalog-drawer-title"/);
  assert.match(drawer, /event\.key === "Escape"/);
  assert.match(drawer, /triggerRef\.current\?\.focus\(\)/, "focus returns to the trigger");
  assert.match(drawer, /body\.style\.position = "fixed"/, "the page behind is locked");
  assert.match(drawer, /window\.scrollTo\(0, scrollY\)/, "and restored at its offset");
  assert.match(drawer, /event\.shiftKey && document\.activeElement === first/, "the trap wraps both ways");
});

test("the sheet closes by derivation when the customer navigates", () => {
  // A per-link onClick alone leaves the panel over the page the back button
  // just returned to.
  assert.match(drawer, /const open = openedOn === pathname/);
});

test("the sheet offers categories, filters, sorting and a reset", () => {
  for (const token of ["Categories", "Filter", "Sort", "Clear filters", "Availability"]) {
    assert.match(drawer, new RegExp(token), `the sheet must offer ${token}`);
  }
});

test("touch targets in the catalog menu meet 44px", () => {
  for (const selector of ["catalog-rail-link", "catalog-drawer-trigger", "catalog-drawer-item", "catalog-drawer-close"]) {
    const rule = css.match(new RegExp(`\\.${selector}[,\\s][^{]*\\{([^}]*)\\}|\\.${selector} \\{([^}]*)\\}`));
    const body = rule ? rule[1] ?? rule[2] ?? "" : "";
    assert.ok(rule, `globals.css must define .${selector}`);
    assert.match(body, /(min-height|height): 2\.75rem/, `.${selector} must be at least 44px`);
  }
});

test("the rail gives way to the sheet below lg rather than squeezing the grid", () => {
  /*
   * Re-pointed in pass 14, when the wrapping chip rows became a browsing rail.
   * The property is unchanged and is what matters: on a narrow screen the
   * browse menu is the drawer, never a cramped column or a sideways scroller.
   */
  const rail = css.match(/\.catalog-rail \{([^}]*)\}/);
  assert.ok(rail, "globals.css must define .catalog-rail");
  assert.match(rail[1], /display: none/, "hidden by default; the sheet takes over");

  // It appears only from `lg`, beside a grid track that can shrink.
  assert.match(
    css,
    /@media \(min-width: 1024px\) \{[\s\S]*?\.catalog-rail \{[\s\S]*?display: flex/,
    "the rail is shown from lg up"
  );
  assert.match(
    css,
    /grid-template-columns: 15rem minmax\(0, 1fr\)/,
    "a fixed rail track and a shrinkable product track — 1fr would let the grid overflow"
  );
});

test("the rail states hierarchy structurally rather than as another row of pills", () => {
  // The reported problem was that categories read as filters. Children are
  // nested markup under their parent, not a second flat row.
  assert.match(browser, /catalog-rail-sublist/);
  assert.match(browser, /entry\.isCurrentBranch && entry\.children\?\.length/);
  assert.match(css, /\.catalog-rail-sublist \{[^}]*border-left/, "children are ruled to their parent");
  assert.match(css, /\.catalog-rail-heading \{[^}]*text-transform: uppercase/, "sections carry real headings");

  // Sorting stays with the grid it reorders; availability and purchase type
  // moved into the rail.
  assert.match(browser, /ariaLabel="Sort products"/);
  const toolbar = browser.slice(browser.indexOf("catalog-toolbar"));
  assert.doesNotMatch(toolbar, /ariaLabel="Availability"/, "availability belongs in the rail");
});

// ---------------------------------------------------------------------------
// The slug namespace
// ---------------------------------------------------------------------------

test("the migration is additive and guards the data before installing the rule", () => {
  const sql = migration.toLowerCase();
  for (const forbidden of ["drop table", "drop column", "truncate", "delete from", "alter column"]) {
    assert.ok(!sql.includes(forbidden), `the migration must not ${forbidden}`);
  }
  assert.match(sql, /raise exception[\s\S]*name both a category and a product/);
  assert.match(sql, /create trigger product_categories_slug_namespace/);
  assert.match(sql, /create trigger products_slug_namespace/);
});

test("the namespace guard covers both directions and is not reachable by a client", () => {
  assert.match(migration, /from public\.products where slug = new\.slug/);
  assert.match(migration, /from public\.product_categories where slug = new\.slug/);
  assert.match(migration, /revoke all on function public\.product_categories_slug_namespace\(\) from public, anon, authenticated/);
  assert.match(migration, /revoke all on function public\.products_slug_namespace\(\) from public, anon, authenticated/);
});

// ---------------------------------------------------------------------------
// Staff management
// ---------------------------------------------------------------------------

test("staff can manage categories, and the entry is permission gated", () => {
  const nav = read("src/lib/staffNavigation.ts");
  assert.match(nav, /href: "\/staff\/catalog\/categories"/);
  assert.match(nav, /anyOf: \["catalog\.categories\.manage"\]/);
  const page = read("src/app/staff/catalog/categories/page.tsx");
  assert.match(page, /catalog\.categories\.manage/);
  // Rules come from the same module the route imports, so a disabled control
  // and a refused request cannot disagree.
  assert.match(page, /from "@\/lib\/commerce\/categories"/);
  // And a failed load is never an empty catalog. Comments are stripped first:
  // the file's own prose quotes the empty state in order to say a failure must
  // not reach it, and matching that would test the documentation.
  const code = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /loadFailed/);
  assert.ok(
    code.indexOf("loadFailed ?") < code.indexOf("No categories yet"),
    "the failure branch must be tested before the empty one"
  );
});
