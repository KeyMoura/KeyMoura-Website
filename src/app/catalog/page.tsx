import type { Metadata } from "next";
import { redirect } from "next/navigation";
import CatalogPageView from "@/components/catalog/CatalogPageView";
import { legacyCategoryTarget, categoryPath } from "@/lib/commerce/catalogBrowse";
import { loadCatalogData } from "@/lib/commerce/catalogData";
import { getSiteSettings } from "@/lib/siteSettings";

export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSiteSettings();
  return {
    title: "Products",
    description: `Ready designs and made-to-order parts from ${settings.name}. Browse the catalog, or send a drawing and get a reviewed quote before you pay.`,
    alternates: { canonical: "/catalog" },
  };
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ products, categories }, params] = await Promise.all([loadCatalogData(), searchParams]);

  /**
   * `?category=Interior` was how a category was selected before category
   * routes existed, and the breadcrumb, the footer and anything already
   * shared still carry it. Those links keep working — and land on the real
   * category page, so one view does not end up with two indexable URLs
   * competing for the same content.
   */
  const raw = params.category;
  const requested = Array.isArray(raw) ? raw[0] : raw;
  const legacy = legacyCategoryTarget(requested, categories);
  if (legacy) redirect(categoryPath(legacy, categories));

  return (
    <CatalogPageView
      allProducts={products}
      scopedProducts={products}
      categories={categories}
      category={null}
      parent={null}
    />
  );
}
