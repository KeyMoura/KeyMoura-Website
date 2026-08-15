import Link from "next/link";
import { Suspense } from "react";
import CatalogBrowser from "@/components/catalog/CatalogBrowser";
import type { CategoryRow } from "@/lib/commerce/categories";
import type { CatalogProductRow } from "@/lib/commerce/catalogData";
import { categoryPath } from "@/lib/commerce/catalogBrowse";

type CatalogPageViewProps = {
  allProducts: CatalogProductRow[];
  scopedProducts: CatalogProductRow[];
  categories: CategoryRow[];
  /** The category being viewed, or null for All products. */
  category: CategoryRow | null;
  /** The category's parent, when viewing a subcategory. */
  parent: CategoryRow | null;
};

/**
 * The shell every catalog page shares: breadcrumb, heading, and the browser.
 *
 * One component rather than three near-identical pages, because the difference
 * between `/catalog`, `/catalog/interior` and `/catalog/interior/shift-knobs`
 * is *which products are in scope* and nothing else. Three copies is how the
 * category pages come to look like a different site from the one they are in.
 *
 * `CatalogBrowser` reads `useSearchParams`, so it needs a Suspense boundary or
 * the whole route opts out of prerendering — the same requirement
 * `/staff/fulfillment` and `/staff/production` hit for the same reason. The
 * fallback is the real grid's container so the page does not jump when the
 * filters resolve.
 */
export default function CatalogPageView({
  allProducts,
  scopedProducts,
  categories,
  category,
  parent,
}: CatalogPageViewProps) {
  const heading = category?.name ?? "Products";
  const description =
    category?.description?.trim() ||
    (category
      ? `${heading} from KeyMoura. Buy what is ready, or ask us to make a version that fits.`
      : "Ready designs you can buy outright, and made-to-order parts we quote against your specification. Nothing is charged on a custom project until the scope and price are agreed.");
  const discovery = categories.filter((item) =>
    item.is_active && !item.archived_at && (category ? item.parent_id === category.id : item.parent_id === null)
  );

  return (
    <main className="page-container">
      {/* Only rendered inside a category: a breadcrumb on the catalog root
          would be a single crumb pointing at the page you are on. */}
      {category ? (
        <nav aria-label="Breadcrumb" className="product-breadcrumb">
          <ol>
            <li>
              <Link href="/">Home</Link>
            </li>
            <li>
              <Link href="/catalog">Products</Link>
            </li>
            {parent ? (
              <li>
                <Link href={`/catalog/${parent.slug}`}>{parent.name}</Link>
              </li>
            ) : null}
            <li aria-current="page">{category.name}</li>
          </ol>
        </nav>
      ) : null}

      <header className="max-w-3xl">
        <p className="ui-eyebrow">{category ? "KeyMoura products" : "Made by KeyMoura"}</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight md:text-5xl">{heading}</h1>
        <p className="mt-4 leading-7 text-brand-textMuted">{description}</p>
        <div className="ui-action-row mt-6">
          <Link href="/orders/new" className="ui-btn ui-btn-secondary">
            Need something else? Start a custom project
          </Link>
        </div>
      </header>

      {discovery.length ? (
        <section className="catalog-discovery" aria-labelledby="catalog-discovery-heading">
          <div>
            <p className="ui-eyebrow">{category ? "Explore this collection" : "Find your part"}</p>
            <h2 id="catalog-discovery-heading" className="catalog-discovery-title">
              {category ? "Shop by subcategory" : "Browse categories"}
            </h2>
          </div>
          <div className="catalog-discovery-grid">
            {discovery.map((item) => (
              <Link key={item.id} href={categoryPath(item, categories)} className="catalog-discovery-card">
                <span className="catalog-discovery-name">{item.name}</span>
                {item.description ? <span className="catalog-discovery-description">{item.description}</span> : null}
                <span className="catalog-discovery-action">Browse <span aria-hidden="true">→</span></span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <Suspense fallback={<div className="catalog-nav-placeholder" aria-hidden="true" />}>
        <CatalogBrowser
          allProducts={allProducts}
          scopedProducts={scopedProducts}
          categories={categories}
          activeCategoryId={category?.id ?? null}
        />
      </Suspense>
    </main>
  );
}
