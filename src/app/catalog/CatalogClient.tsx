"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import ProductCard, { type ProductCardProduct } from "@/components/ProductCard";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { normalizePurchaseMode } from "@/lib/commerce/purchaseModes";

export type CatalogCategory = { id: string; name: string; slug: string; parent_id: string | null };

type Sort = "featured" | "name" | "price-low" | "price-high";

type CatalogClientProps = {
  products: (ProductCardProduct & { category_id?: string | null })[];
  categories: CatalogCategory[];
  /** Seeds the category filter from a breadcrumb or a footer link. */
  initialCategory?: string;
};

/**
 * The catalog grid and its filters.
 *
 * The products arrive already loaded from the server component above, so the
 * grid is real content in the first HTML rather than a skeleton waiting on a
 * round trip. Only the filtering is interactive, which is what it should be:
 * two products or two hundred, filtering a list already in memory is instant
 * and needs no request.
 *
 * Filters use `MenuSelect`, the same control as the rest of the site. The page
 * previously mixed bare `<select>` elements into a page where every other
 * dropdown was a `MenuSelect`, so the catalog was the one surface that looked
 * like a different application.
 *
 * Categories come from `product_categories` rather than being derived from the
 * legacy free-text `products.category` column. Deriving them meant the filter
 * list was whatever strings happened to be in use, including typos, and a
 * category with no products simply vanished.
 */
export default function CatalogClient({ products, categories, initialCategory = "all" }: CatalogClientProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(initialCategory);
  const [availability, setAvailability] = useState("all");
  const [mode, setMode] = useState("all");
  const [sort, setSort] = useState<Sort>("featured");

  const categoryOptions = useMemo(() => {
    // One level of nesting, enforced in the database, so a child is shown
    // indented under its parent rather than needing a tree.
    const parents = categories.filter((row) => !row.parent_id);
    const children = categories.filter((row) => row.parent_id);
    const options = [{ value: "all", label: "All categories" }];
    for (const parent of parents) {
      options.push({ value: parent.id, label: parent.name });
      for (const child of children.filter((row) => row.parent_id === parent.id)) {
        options.push({ value: child.id, label: `— ${child.name}` });
      }
    }
    return options;
  }, [categories]);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    const result = products.filter((product) => {
      if (term && !`${product.name} ${product.short_description ?? ""} ${product.category ?? ""}`.toLowerCase().includes(term)) {
        return false;
      }
      if (category !== "all") {
        // A parent category includes its children, which is what a customer
        // means by "show me Interior".
        const childIds = categories.filter((row) => row.parent_id === category).map((row) => row.id);
        if (product.category_id !== category && !childIds.includes(product.category_id ?? "")) return false;
      }
      if (availability !== "all" && product.availability_status !== availability) return false;
      if (mode !== "all" && normalizePurchaseMode(product.purchase_mode) !== mode) return false;
      return true;
    });

    const byPrice = (value: number | null | undefined, fallback: number) => value ?? fallback;
    if (sort === "name") return [...result].sort((a, b) => a.name.localeCompare(b.name));
    if (sort === "price-low")
      return [...result].sort((a, b) => byPrice(a.starting_price_cents, Number.MAX_SAFE_INTEGER) - byPrice(b.starting_price_cents, Number.MAX_SAFE_INTEGER));
    if (sort === "price-high")
      return [...result].sort((a, b) => byPrice(b.starting_price_cents, -1) - byPrice(a.starting_price_cents, -1));
    return result;
  }, [products, query, category, categories, availability, mode, sort]);

  const filtered = Boolean(query.trim()) || category !== "all" || availability !== "all" || mode !== "all" || sort !== "featured";
  const clear = () => {
    setQuery("");
    setCategory("all");
    setAvailability("all");
    setMode("all");
    setSort("featured");
  };

  return (
    <>
      <section aria-label="Filter products" className="catalog-filters">
        <div className="catalog-filter-row">
          <div className="catalog-search">
            <label className="sr-only" htmlFor="catalog-search">
              Search products
            </label>
            <input
              id="catalog-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search products…"
              className="ui-input"
            />
          </div>

          <MenuSelect
            ariaLabel="Category"
            className="ui-select-trigger"
            value={category}
            onChange={setCategory}
            options={categoryOptions}
          />
          <MenuSelect
            ariaLabel="Availability"
            className="ui-select-trigger"
            value={availability}
            onChange={setAvailability}
            options={[
              { value: "all", label: "Any availability" },
              { value: "available", label: "Available" },
              { value: "limited", label: "Limited" },
              { value: "made_to_order", label: "Made to order" },
            ]}
          />
          <MenuSelect
            ariaLabel="How it is bought"
            className="ui-select-trigger"
            value={mode}
            onChange={setMode}
            options={[
              { value: "all", label: "Any purchase type" },
              { value: "direct_purchase", label: "Buy now" },
              { value: "direct_or_request", label: "Buy or customize" },
              { value: "request_only", label: "Quoted" },
            ]}
          />
          <MenuSelect
            ariaLabel="Sort products"
            className="ui-select-trigger"
            value={sort}
            onChange={(value) => setSort(value as Sort)}
            options={[
              { value: "featured", label: "Featured" },
              { value: "name", label: "Name" },
              { value: "price-low", label: "Price: low to high" },
              { value: "price-high", label: "Price: high to low" },
            ]}
          />
        </div>

        <div className="catalog-filter-summary">
          {/* The count is a real count of what is on screen. No "1,000+
              products" and no fabricated per-category totals. */}
          <p aria-live="polite">
            {visible.length} {visible.length === 1 ? "product" : "products"}
            {filtered && visible.length !== products.length ? ` of ${products.length}` : null}
          </p>
          <button type="button" onClick={clear} disabled={!filtered} className="ui-btn ui-btn-ghost !py-1.5 text-sm disabled:opacity-40">
            Clear filters
          </button>
        </div>
      </section>

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
            {products.length ? "No products match those filters." : "The catalog is being set up."}
          </h2>
          <p className="mt-2">
            {products.length
              ? "Try clearing a filter — or describe what you need and we will quote it."
              : "Nothing is published yet. A custom project is the fastest way to get started."}
          </p>
          <div className="ui-action-row mt-5 justify-center">
            {products.length ? (
              <button type="button" onClick={clear} className="ui-btn ui-btn-secondary">
                Clear filters
              </button>
            ) : null}
            <Link href="/orders/new" className="ui-btn ui-btn-primary">
              Start a custom project
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
