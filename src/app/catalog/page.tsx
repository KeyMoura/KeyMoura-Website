import type { Metadata } from "next";
import Link from "next/link";
import CatalogClient, { type CatalogCategory } from "@/app/catalog/CatalogClient";
import type { ProductCardProduct } from "@/components/ProductCard";
import { supabasePublicServer } from "@/lib/supabasePublicServer";
import { groupMediaByProduct } from "@/lib/productImages";
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

type CatalogProductRow = ProductCardProduct & { category_id?: string | null };

/**
 * Loads the catalog on the server, as the public.
 *
 * The page used to fetch in a `useEffect`, so every visit painted a skeleton
 * and then the grid — including for a crawler, which got the skeleton and
 * nothing else. The product list is public, identical for every visitor, and
 * revalidated every five minutes, so there is nothing here that needs to wait
 * for a browser.
 */
async function loadCatalog(): Promise<{ products: CatalogProductRow[]; categories: CatalogCategory[] }> {
  const supabase = supabasePublicServer();

  const [productResult, categoryResult] = await Promise.all([
    supabase
      .from("products")
      .select(
        "id,name,slug,short_description,image_url,category,category_id,purchase_mode,starting_price_cents,is_custom,availability_status,lead_time_text,inventory_policy,inventory_quantity,continue_selling_when_out_of_stock"
      )
      .eq("is_published", true)
      .is("archived_at", null)
      .order("sort_order")
      .order("created_at", { ascending: false }),
    supabase
      .from("product_categories")
      .select("id,name,slug,parent_id")
      .eq("is_active", true)
      .is("archived_at", null)
      .order("display_order"),
  ]);

  const products = (productResult.data ?? []) as CatalogProductRow[];

  if (products.length) {
    const { data: media } = await supabase
      .from("product_media")
      .select("product_id,url,kind,sort_order")
      .in(
        "product_id",
        products.map((product) => product.id)
      )
      .eq("kind", "image")
      .order("sort_order");

    const byProduct = groupMediaByProduct(media ?? []);
    for (const product of products) product.product_media = byProduct.get(product.id) ?? [];
  }

  return { products, categories: (categoryResult.data ?? []) as CatalogCategory[] };
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const [{ products, categories }, params] = await Promise.all([loadCatalog(), searchParams]);

  // A breadcrumb or footer link may name a category; it is matched by name
  // because that is what the legacy links carry.
  const requested = params.category?.trim().toLowerCase();
  const initialCategory =
    (requested && categories.find((row) => row.name.toLowerCase() === requested)?.id) || "all";

  return (
    <main className="page-container">
      <header className="max-w-3xl">
        <p className="ui-eyebrow">Made by KeyMoura</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight md:text-5xl">Products</h1>
        <p className="mt-4 leading-7 text-brand-textMuted">
          Ready designs you can buy outright, and made-to-order parts we quote against your
          specification. Nothing is charged on a custom project until the scope and price are agreed.
        </p>
        <div className="ui-action-row mt-6">
          <Link href="/orders/new" className="ui-btn ui-btn-secondary">
            Need something else? Start a custom project
          </Link>
        </div>
      </header>

      <CatalogClient products={products} categories={categories} initialCategory={initialCategory} />
    </main>
  );
}
