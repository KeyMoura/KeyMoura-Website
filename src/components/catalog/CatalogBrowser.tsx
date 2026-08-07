"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import ProductCard, { type ProductCardProduct } from "@/components/ProductCard";
import CatalogBrowseDrawer from "@/components/catalog/CatalogBrowseDrawer";
import { MenuSelect } from "@/components/ui/MenuSelect";
import type { CategoryRow } from "@/lib/commerce/categories";
import {
  activeFilterCount,
  applyCatalogFilters,
  AVAILABILITY_OPTIONS,
  buildBrowseMenu,
  catalogFilterQuery,
  filtersAreDefault,
  MODE_OPTIONS,
  parseCatalogFilters,
  SORT_OPTIONS,
  type CatalogFilters,
} from "@/lib/commerce/catalogBrowse";

export type CatalogProductRow = ProductCardProduct & {
  category_id?: string | null;
  created_at?: string | null;
};

type CatalogBrowserProps = {
  /** Every published product, so counts are counts and not estimates. */
  allProducts: CatalogProductRow[];
  /** The products this page is about: all of them, or one category's. */
  scopedProducts: CatalogProductRow[];
  categories: CategoryRow[];
  activeCategoryId: string | null;
};

/**
 * The storefront catalog: browse menu, filters, and the grid.
 *
 * ## Why the category is a route and the filters are a query string
 *
 * A category is *what you are looking at* — it has a name, a description, a
 * canonical URL, a breadcrumb, and it is worth linking to and indexing. A
 * filter is *how you are looking at it*, and a separate indexable page for
 * every combination of four filters is a thousand near-duplicate pages.
 *
 * The URL is the source of truth for both. Pressing Back from *Interior,
 * sorted by price* returns to *Interior, featured*, and the highlighted chip
 * follows.
 *
 * The search text is the one exception, and a narrow one: it is held locally
 * while it is being typed and written to the URL when the typing pauses. That
 * is not a mirror the URL can drift from — a URL change from any other source
 * is adopted immediately — it is a debounce, and it exists because this is a
 * server component and a `router.replace` per keystroke costs a full RSC
 * round trip for a result the browser already has.
 *
 * ## Why a horizontal bar rather than a permanent sidebar
 *
 * The brief allows either. This catalog has one top-level category today, so a
 * full-height sidebar would be a mostly empty column taking a third of the
 * width away from the products — which the brief names as the thing not to do.
 * A top-level row plus a second row of subcategories reads the same at one
 * category and at twenty, and it does not compete with the global navbar for
 * the top of the page.
 *
 * On small screens the rows are replaced by one trigger and a real drawer:
 * a scrolling row of chips hides everything past the third one, and the
 * filters have to go somewhere anyway.
 */
export default function CatalogBrowser({
  allProducts,
  scopedProducts,
  categories,
  activeCategoryId,
}: CatalogBrowserProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const filters = useMemo(() => parseCatalogFilters(searchParams), [searchParams]);

  /**
   * The search box is the one filter that changes on every keystroke.
   *
   * Writing each one straight to the URL made the box cost a server round trip
   * per character: this is a server component, so a `router.replace` refetches
   * the RSC payload — and it comes back identical, because the filtering is
   * done here over a list already in memory. Measured at roughly 1.5s per
   * keystroke against the dev server.
   *
   * So the typed text is held locally for the grid, and the URL is written
   * once the typing pauses. The URL is still the source of truth: when it
   * changes for any reason that is not this box — a Back, a shared link, a
   * Clear — the box adopts it. That adjustment happens during render, which is
   * React's documented pattern for deriving state from a changing input and
   * avoids both an effect and the cascading render one would cause.
   *
   * The dropdowns are left writing straight through. They change once per
   * interaction, and each of those *is* a history entry worth having.
   */
  const [typed, setTyped] = useState(filters.query);
  const [lastUrlQuery, setLastUrlQuery] = useState(filters.query);
  if (lastUrlQuery !== filters.query) {
    // React's documented "adjusting state when a prop changes": both halves are
    // state, set during render, so React restarts the render immediately rather
    // than painting a stale box and correcting it. A ref would have done the
    // same job less safely — and `react-hooks/refs` refuses one here for
    // exactly that reason.
    setLastUrlQuery(filters.query);
    setTyped(filters.query);
  }

  const effectiveFilters = useMemo(() => ({ ...filters, query: typed }), [filters, typed]);
  const visible = useMemo(
    () => applyCatalogFilters(scopedProducts, effectiveFilters),
    [scopedProducts, effectiveFilters]
  );

  const menu = useMemo(
    () =>
      buildBrowseMenu({
        categories,
        products: allProducts,
        activeCategoryId,
        // Switching category keeps the search and the sort. Dropping them is a
        // silent reset the customer did not ask for.
        filterQuery: catalogFilterQuery(effectiveFilters),
      }),
    [categories, allProducts, activeCategoryId, effectiveFilters]
  );

  /*
   * The URL catches up when the typing pauses. `replace`, not `push`: a
   * history entry per pause would make Back walk backwards through a word.
   */
  useEffect(() => {
    if (typed === filters.query) return;
    const timer = window.setTimeout(() => {
      const next = { ...filters, query: typed };
      router.replace(`${pathname}${catalogFilterQuery(next)}`, { scroll: false });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [typed, filters, pathname, router]);

  const isDefault = filtersAreDefault(effectiveFilters);
  const filterCount = activeFilterCount(effectiveFilters);

  /** Writes filters back to the URL. Replace, not push: typing in a search box must not fill the history. */
  function setFilters(next: Partial<CatalogFilters>, mode: "replace" | "push" = "replace") {
    const merged = { ...filters, ...next };
    const url = `${pathname}${catalogFilterQuery(merged)}`;
    if (mode === "push") router.push(url, { scroll: false });
    else router.replace(url, { scroll: false });
  }

  const clear = () => {
    setTyped("");
    router.replace(pathname, { scroll: false });
  };

  const branch = menu.categories.find((entry) => entry.isCurrentBranch);
  const subcategories = branch?.children ?? [];

  return (
    <>
      {/*
        A `nav` of its own, labelled, and deliberately not part of the global
        navbar: duplicating the site navigation here would give a screen reader
        two "Products" links to the same place and give a customer two
        different mental models of where they are.
      */}
      <nav aria-label="Product categories" className="catalog-nav">
        <ul className="catalog-nav-row">
          <li>
            <Link
              href={menu.all.href}
              aria-current={menu.all.isActive ? "page" : undefined}
              className={`catalog-nav-chip${menu.all.isActive ? " is-active" : ""}`}
            >
              {menu.all.name}
              <span className="catalog-nav-count">{menu.all.count}</span>
            </Link>
          </li>
          {menu.categories.map((entry) => (
            <li key={entry.id}>
              <Link
                href={entry.href}
                aria-current={entry.isActive ? "page" : undefined}
                className={`catalog-nav-chip${entry.isActive ? " is-active" : ""}${
                  entry.isCurrentBranch && !entry.isActive ? " is-branch" : ""
                }`}
              >
                {entry.name}
                <span className="catalog-nav-count">{entry.count}</span>
              </Link>
            </li>
          ))}
        </ul>

        {/* Subcategories appear only for the branch you are in. Showing every
            child of every category at once is a wall, and showing none makes
            subcategories undiscoverable — this is the middle, and it is why
            the parent chip stays highlighted while a child is selected. */}
        {subcategories.length ? (
          <ul className="catalog-nav-subrow" aria-label={`${branch?.name} subcategories`}>
            <li>
              <Link
                href={branch?.href ?? menu.all.href}
                aria-current={branch?.isActive ? "page" : undefined}
                className={`catalog-nav-subchip${branch?.isActive ? " is-active" : ""}`}
              >
                All {branch?.name}
              </Link>
            </li>
            {subcategories.map((child) => (
              <li key={child.id}>
                <Link
                  href={child.href}
                  aria-current={child.isActive ? "page" : undefined}
                  className={`catalog-nav-subchip${child.isActive ? " is-active" : ""}`}
                >
                  {child.name}
                  <span className="catalog-nav-count">{child.count}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </nav>

      <section aria-label="Search and filter products" className="catalog-toolbar">
        <div className="catalog-search">
          <label className="sr-only" htmlFor="catalog-search">
            Search products
          </label>
          <input
            id="catalog-search"
            type="search"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="Search products…"
            className="ui-input"
          />
        </div>

        <div className="catalog-filter-controls">
          <MenuSelect
            ariaLabel="Availability"
            className="ui-select-trigger"
            value={filters.availability}
            onChange={(value) => setFilters({ availability: value as CatalogFilters["availability"] }, "push")}
            options={AVAILABILITY_OPTIONS}
          />
          <MenuSelect
            ariaLabel="How it is bought"
            className="ui-select-trigger"
            value={filters.mode}
            onChange={(value) => setFilters({ mode: value as CatalogFilters["mode"] }, "push")}
            options={MODE_OPTIONS}
          />
          <MenuSelect
            ariaLabel="Sort products"
            className="ui-select-trigger"
            value={filters.sort}
            onChange={(value) => setFilters({ sort: value as CatalogFilters["sort"] }, "push")}
            options={SORT_OPTIONS}
          />
        </div>

        <CatalogBrowseDrawer
          menu={menu}
          filters={effectiveFilters}
          filterCount={filterCount}
          onChange={(next, mode) => {
            // The drawer's search box shares the debounce; its dropdowns do not.
            if (typeof next.query === "string" && Object.keys(next).length === 1) setTyped(next.query);
            else setFilters(next, mode);
          }}
          onClear={clear}
        />
      </section>

      <div className="catalog-summary">
        {/* A real count of what is on screen. No "1,000+", no per-category
            estimate, nothing derived from anything but this list. */}
        <p aria-live="polite">
          {visible.length} {visible.length === 1 ? "product" : "products"}
          {!isDefault && visible.length !== scopedProducts.length ? ` of ${scopedProducts.length}` : null}
        </p>
        <button
          type="button"
          onClick={clear}
          disabled={isDefault}
          className="ui-btn ui-btn-ghost !py-1.5 text-sm disabled:opacity-40"
        >
          Clear filters
        </button>
      </div>

      {visible.length ? (
        <section className="mt-6" aria-labelledby="catalog-products">
          {/* Product names are h3 inside the shared card, so the grid needs an
              h2 above them to keep the heading outline unbroken. */}
          <h2 id="catalog-products" className="sr-only">
            Products
          </h2>
          <div className="catalog-grid">
            {visible.map((product, index) => (
              <ProductCard key={product.id} product={product} priority={index < 3} />
            ))}
          </div>
        </section>
      ) : (
        <div className="ui-empty-state mt-6 !p-10">
          <h2 className="text-xl font-semibold text-brand-text">
            {scopedProducts.length ? "No products match those filters." : "Nothing is listed here yet."}
          </h2>
          <p className="mt-2">
            {scopedProducts.length
              ? "Try clearing a filter — or describe what you need and we will quote it."
              : "Browse everything, or describe what you need and we will quote it."}
          </p>
          <div className="ui-action-row mt-5 justify-center">
            {scopedProducts.length ? (
              <button type="button" onClick={clear} className="ui-btn ui-btn-secondary">
                Clear filters
              </button>
            ) : (
              <Link href="/catalog" className="ui-btn ui-btn-secondary">
                All products
              </Link>
            )}
            <Link href="/orders/new" className="ui-btn ui-btn-primary">
              Start a custom project
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
