"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
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
 * Both live in the URL and nowhere else. There is no `useState` mirror, which
 * is what makes the back button disagree with what is on screen: pressing Back
 * from *Interior, sorted by price* returns to *Interior, featured*, and the
 * highlighted chip follows.
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
  const visible = useMemo(() => applyCatalogFilters(scopedProducts, filters), [scopedProducts, filters]);

  const menu = useMemo(
    () =>
      buildBrowseMenu({
        categories,
        products: allProducts,
        activeCategoryId,
        // Switching category keeps the search and the sort. Dropping them is a
        // silent reset the customer did not ask for.
        filterQuery: catalogFilterQuery(filters),
      }),
    [categories, allProducts, activeCategoryId, filters]
  );

  const isDefault = filtersAreDefault(filters);
  const filterCount = activeFilterCount(filters);

  /** Writes filters back to the URL. Replace, not push: typing in a search box must not fill the history. */
  function setFilters(next: Partial<CatalogFilters>, mode: "replace" | "push" = "replace") {
    const merged = { ...filters, ...next };
    const url = `${pathname}${catalogFilterQuery(merged)}`;
    if (mode === "push") router.push(url, { scroll: false });
    else router.replace(url, { scroll: false });
  }

  const clear = () => router.replace(pathname, { scroll: false });

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
            value={filters.query}
            onChange={(event) => setFilters({ query: event.target.value })}
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
          filters={filters}
          filterCount={filterCount}
          onChange={setFilters}
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
