"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import ProductCard, { type ProductCardProduct } from "@/components/ProductCard";
import CatalogBrowseDrawer from "@/components/catalog/CatalogBrowseDrawer";
import CatalogCategoryTree from "@/components/catalog/CatalogCategoryTree";
import CatalogViewControl from "@/components/catalog/CatalogViewControl";
import CommerceSearch from "@/components/catalog/CommerceSearch";
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
 * ## Why a rail rather than the row of chips it replaces
 *
 * The previous version put categories, subcategories and filters in wrapping
 * rows of pills. The reasoning at the time was that one top-level category
 * would leave a sidebar mostly empty — true, and it turned out to be the wrong
 * thing to optimise for. Pills are *filter* shapes: uniform, small, equal
 * weight. A category, a subcategory and an availability toggle all rendered as
 * the same control, so the only cue for hierarchy was which row something
 * happened to be on, and the storefront's main organising idea looked like a
 * bank of toggles.
 *
 * The rail states the hierarchy structurally instead — sections with headings,
 * categories as a list, children indented beneath their parent — so it reads
 * correctly with one category and still reads correctly with forty, where a
 * wrapping chip row becomes a wall. Sorting stays above the grid, with the
 * thing it reorders.
 *
 * Below `lg` the rail gives way to the drawer: a narrow column beside a
 * two-column product grid leaves neither enough room, and the filters have to
 * go somewhere on a phone anyway.
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

  /** Just the search term, leaving the category and the refinements alone. */
  const clearSearch = () => {
    setTyped("");
    setFilters({ query: "" });
  };

  /*
   * Enter, or the Search button: commit now rather than in 350ms.
   *
   * The debounce exists so a keystroke does not cost an RSC round trip; a
   * deliberate submit is not a keystroke, and waiting a third of a second after
   * one is the kind of small unresponsiveness that makes a search box feel
   * broken. `push` rather than `replace` here — a submitted search is a place
   * the customer expects Back to return from, which is exactly the history
   * entry the debounced path is careful *not* to create.
   */
  const submitSearch = (value: string) => {
    const next = { ...filters, query: value.trim().slice(0, 80) };
    router.push(`${pathname}${catalogFilterQuery(next)}`, { scroll: false });
  };

  const searchId = useId();
  const term = effectiveFilters.query.trim();
  const scopeName = menu.trail.length ? menu.trail[menu.trail.length - 1].name : null;

  return (
    <div className="catalog-layout">
      {/*
        The browsing rail.

        A `nav` of its own, labelled, and deliberately not part of the global
        navbar: duplicating the site navigation here would give a screen reader
        two "Products" links to the same place and give a customer two
        different mental models of where they are.

        It is a rail rather than the row of pill chips this replaced. Chips read
        as *filters* — small, uniform, equal-weight — so a category and a
        subcategory and an availability toggle all looked like the same kind of
        control, and hierarchy had to be inferred from which row something was
        on. A rail states the hierarchy in space and type instead: sections with
        headings, categories as a list, children indented under their parent.
        It also stops being a wall at twenty categories, which a wrapping chip
        row does not.

        Below `lg` the whole rail gives way to the drawer — a narrow column
        beside a two-column grid leaves neither enough room.
      */}
      <nav aria-label="Browse products" className="catalog-rail">
        <section className="catalog-rail-section">
          <h2 className="catalog-rail-heading">Categories</h2>
          <CatalogCategoryTree menu={menu} variant="rail" />
        </section>

        {/* Refinements, kept visually distinct from the category list above.
            Sorting is deliberately *not* here — it belongs with the grid it
            reorders, where the reader can see the effect. */}
        <section className="catalog-rail-section">
          <h2 className="catalog-rail-heading">Availability</h2>
          <MenuSelect
            ariaLabel="Availability"
            className="ui-select-trigger w-full"
            value={filters.availability}
            onChange={(value) => setFilters({ availability: value as CatalogFilters["availability"] }, "push")}
            options={AVAILABILITY_OPTIONS}
          />
        </section>

        <section className="catalog-rail-section">
          <h2 className="catalog-rail-heading">How it is bought</h2>
          <MenuSelect
            ariaLabel="How it is bought"
            className="ui-select-trigger w-full"
            value={filters.mode}
            onChange={(value) => setFilters({ mode: value as CatalogFilters["mode"] }, "push")}
            options={MODE_OPTIONS}
          />
        </section>

        <button
          type="button"
          onClick={clear}
          disabled={isDefault}
          className="ui-btn ui-btn-ghost w-full !py-2 text-sm disabled:opacity-40"
        >
          Clear filters
        </button>
      </nav>

      <div className="catalog-main">
        {/*
          Search on its own row, then the result context.

          These used to share a row with sort, density and the drawer triggers,
          which made the storefront's primary control one of five equal boxes —
          the same silhouette a staff table's filter field has. Search is what a
          customer came to do; how many results there are and how they are
          arranged is a different question, and it belongs on a different line.
        */}
        <section aria-label="Search and arrange products" className="catalog-toolbar">
          <CommerceSearch
            inputId={searchId}
            value={typed}
            onChange={setTyped}
            onSubmit={submitSearch}
            onClear={clearSearch}
          />

          <div className="catalog-results-bar">
            {/*
              A real count of what is on screen, said as a sentence. No
              "1,000+", no per-category estimate, nothing derived from anything
              but this list — and, when there is a search, what it was a search
              *for*, so nobody has to read the input back to find out.
            */}
            <p className="catalog-results-count" aria-live="polite">
              <strong>{visible.length}</strong>{" "}
              {term
                ? `${visible.length === 1 ? "result" : "results"} for `
                : visible.length === 1
                  ? "product"
                  : "products"}
              {term ? <span className="catalog-results-term">“{term}”</span> : null}
              {scopeName || (!isDefault && visible.length !== scopedProducts.length) ? (
                <span className="catalog-results-scope">
                  {scopeName ? `in ${scopeName}` : null}
                  {scopeName && !isDefault && visible.length !== scopedProducts.length ? " · " : null}
                  {!isDefault && visible.length !== scopedProducts.length
                    ? `filtered from ${scopedProducts.length}`
                    : null}
                </span>
              ) : null}
            </p>

            <div className="catalog-filter-controls">
              <div className="catalog-toolbar-sort">
                <MenuSelect
                  ariaLabel="Sort products"
                  className="ui-select-trigger"
                  value={filters.sort}
                  onChange={(value) => setFilters({ sort: value as CatalogFilters["sort"] }, "push")}
                  options={SORT_OPTIONS}
                />
              </div>
              {/* Beside sorting, because both are "how am I looking at this
                  list" — and deliberately not in the rail with the category
                  tree, which is "what list am I looking at". */}
              <CatalogViewControl />
            </div>
          </div>

          <CatalogBrowseDrawer
            menu={menu}
            filters={effectiveFilters}
            filterCount={filterCount}
            // The drawer holds dropdowns only — search lives on the toolbar at
            // every width now — and a dropdown changes once per interaction, so
            // each of those is a history entry worth having.
            onChange={(next, mode) => setFilters(next, mode)}
            onClear={clear}
          />
        </section>

        {!isDefault ? (
          <div className="catalog-active-filters" aria-label="Active filters">
            <span className="catalog-active-filters-label">Active filters</span>
            {effectiveFilters.query ? (
              <button type="button" onClick={clearSearch} className="catalog-filter-chip">
                Search: {effectiveFilters.query} <span aria-hidden="true">×</span>
              </button>
            ) : null}
            {effectiveFilters.availability !== "all" ? (
              <button type="button" onClick={() => setFilters({ availability: "all" }, "push")} className="catalog-filter-chip">
                {AVAILABILITY_OPTIONS.find((item) => item.value === effectiveFilters.availability)?.label} <span aria-hidden="true">×</span>
              </button>
            ) : null}
            {effectiveFilters.mode !== "all" ? (
              <button type="button" onClick={() => setFilters({ mode: "all" }, "push")} className="catalog-filter-chip">
                {MODE_OPTIONS.find((item) => item.value === effectiveFilters.mode)?.label} <span aria-hidden="true">×</span>
              </button>
            ) : null}
            {effectiveFilters.sort !== "featured" ? (
              <button type="button" onClick={() => setFilters({ sort: "featured" }, "push")} className="catalog-filter-chip">
                {SORT_OPTIONS.find((item) => item.value === effectiveFilters.sort)?.label} <span aria-hidden="true">×</span>
              </button>
            ) : null}
            <button type="button" onClick={clear} className="catalog-filter-chip catalog-filter-chip-clear">
              Clear all
            </button>
          </div>
        ) : null}

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
          /*
           * Empty is not an error and it is not a bare zero.
           *
           * "0 products" is a fact the customer already knows by looking, and it
           * does not say which of the four things they set is responsible.
           * Naming the search term is the useful half: it is the thing most
           * likely to be a typo, and it is the thing a Clear search button can
           * fix in one press without throwing away the category they navigated
           * to on the way here.
           */
          <div className="ui-empty-state mt-6 !p-10">
            <h2 className="text-xl font-semibold text-brand-text">
              {term
                ? `No products match “${term}”.`
                : scopedProducts.length
                  ? "No products match those filters."
                  : "Nothing is listed here yet."}
            </h2>
            <p className="mt-2">
              {term
                ? "Try another search, or clear your filters."
                : scopedProducts.length
                  ? "Try clearing a filter — or describe what you need and we will quote it."
                  : "Browse everything, or describe what you need and we will quote it."}
            </p>
            <div className="ui-action-row mt-5 justify-center">
              {term ? (
                <button type="button" onClick={clearSearch} className="ui-btn ui-btn-secondary">
                  Clear search
                </button>
              ) : null}
              {scopedProducts.length ? (
                <button type="button" onClick={clear} disabled={isDefault} className="ui-btn ui-btn-secondary disabled:opacity-40">
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
      </div>
    </div>
  );
}
