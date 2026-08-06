import type { Metadata } from "next";
import { notFound } from "next/navigation";
import CatalogPageView from "@/components/catalog/CatalogPageView";
import { categoryPath, productsInCategory, resolveCategoryPath } from "@/lib/commerce/catalogBrowse";
import { loadCatalogData } from "@/lib/commerce/catalogData";
import { getSiteSettings } from "@/lib/siteSettings";

export const revalidate = 300;

/**
 * `/catalog/[category]/[subcategory]`.
 *
 * `resolveCategoryPath` checks **both** segments against the tree, so
 * `/catalog/exterior/shift-knobs` is a 404 when *shift-knobs* belongs to
 * *interior*. Matching only the last segment would give one page two addresses
 * and put a wrong parent in the breadcrumb — and would let anyone mint an
 * arbitrary number of indexable URLs for the same products.
 *
 * There is no third level: the database refuses a parent that itself has a
 * parent, so a deeper path cannot name anything.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; subcategory: string }>;
}): Promise<Metadata> {
  const [{ slug, subcategory }, settings] = await Promise.all([params, getSiteSettings()]);
  const { categories } = await loadCatalogData();
  const category = resolveCategoryPath([slug, subcategory], categories);
  if (!category) return { title: "Category not found" };

  const description =
    category.description?.trim() ||
    `${category.name} from ${settings.name}. Buy what is ready, or ask us to make a version that fits.`;

  return {
    title: category.name,
    description,
    alternates: { canonical: categoryPath(category, categories) },
    openGraph: {
      title: category.name,
      description,
      type: "website",
      url: categoryPath(category, categories),
    },
  };
}

export default async function SubcategoryPage({
  params,
}: {
  params: Promise<{ slug: string; subcategory: string }>;
}) {
  const { slug, subcategory } = await params;
  const { products, categories } = await loadCatalogData();

  const category = resolveCategoryPath([slug, subcategory], categories);
  if (!category) notFound();

  const parent = categories.find((row) => row.id === category.parent_id) ?? null;

  return (
    <CatalogPageView
      allProducts={products}
      scopedProducts={productsInCategory(products, category.id, categories)}
      categories={categories}
      category={category}
      parent={parent}
    />
  );
}
