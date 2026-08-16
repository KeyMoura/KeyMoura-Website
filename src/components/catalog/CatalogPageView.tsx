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
  /*
   * Subcategory discovery, and only inside a category.
   *
   * At the catalog root this used to list every top-level category as a large
   * card — directly above `CatalogBrowser`, which opens with the category rail
   * on desktop and the Categories drawer on narrower widths. Two category
   * navigators, stacked, answering the same question in two different visual
   * languages, and the canonical one was the one pushed below the fold.
   *
   * Inside a category it is doing something the rail does not: showing where
   * you can go *deeper* from where you already are. So it stays there.
   */
  const discovery = category
    ? categories.filter((item) => item.is_active && !item.archived_at && item.parent_id === category.id)
    : [];

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

      {/*
        The intro, kept short.

        The "Need something else? Start a custom project" button used to sit
        here, above the products, on every catalog and category page — an
        apology for the catalog before anyone had looked at it. It moved to
        where it is useful: the no-results state, and a quiet rule below the
        results. See `CatalogRecovery`.
      */}
      <header className="catalog-intro">
        <p className="ui-eyebrow">{category ? "KeyMoura products" : "Made by KeyMoura"}</p>
        <h1 className="catalog-intro-title">{heading}</h1>
        <p className="catalog-intro-body">{description}</p>
      </header>

      {/*
        Subcategories, as a row of links rather than a grid of cards.

        Cards here competed with the product cards immediately below them for
        the same attention with the same shape, and a subcategory is a signpost
        rather than a thing you can buy. Links read as navigation, take one line
        instead of seven, and stop the top of a category page looking like a
        second catalog.
      */}
      {discovery.length ? (
        <nav className="catalog-subnav" aria-labelledby="catalog-discovery-heading">
          <h2 id="catalog-discovery-heading" className="catalog-subnav-heading">
            Shop by subcategory
          </h2>
          <ul className="catalog-subnav-list">
            {discovery.map((item) => (
              <li key={item.id}>
                <Link href={categoryPath(item, categories)} className="catalog-subnav-link">
                  {item.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
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
