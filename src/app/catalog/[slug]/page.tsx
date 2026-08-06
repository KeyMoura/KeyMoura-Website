import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ProductGallery, { type GalleryImage } from "@/components/product/ProductGallery";
import ProductPurchasePanel from "@/components/product/ProductPurchasePanel";
import ProductSections from "@/components/product/ProductSections";
import ProductRequestForm from "@/components/product/ProductRequestForm";
import ProductCard, { type ProductCardProduct } from "@/components/ProductCard";
import { supabasePublicServer } from "@/lib/supabasePublicServer";
import { getSiteSettings } from "@/lib/siteSettings";
import { groupMediaByProduct, normalizeImageUrl, primaryProductImage } from "@/lib/productImages";
import {
  availabilityLabel,
  inventoryLabel,
  productCanBeRequested,
  type CatalogProduct,
  type ProductMedia,
  type ProductOptionGroup,
} from "@/lib/commerceTypes";
import { allowsRequest, normalizePurchaseMode, PURCHASE_MODE_COPY } from "@/lib/commerce/purchaseModes";
import {
  buildProductSections,
  parseDetailContent,
  parseProductFacts,
  quickFacts,
} from "@/lib/commerce/productContent";

export const revalidate = 300;

type CategoryRow = { id: string; name: string; slug: string; parent_id: string | null };

type LoadedProduct = {
  product: CatalogProduct & Record<string, unknown>;
  media: ProductMedia[];
  groups: ProductOptionGroup[];
  category: CategoryRow | null;
  parentCategory: CategoryRow | null;
  related: ProductCardProduct[];
};

/**
 * Loads everything the page renders, as the public.
 *
 * Server-side and through the anon key, so RLS is a second guard behind every
 * filter here rather than something bypassed by a service-role client. The old
 * page did all of this in a `useEffect` after hydration, which meant the first
 * paint was the word "Loading…", the product had no metadata for a crawler or a
 * link preview, and the largest contentful paint waited on a round trip that
 * had not started when the HTML arrived.
 */
async function loadProduct(slug: string): Promise<LoadedProduct | null> {
  const supabase = supabasePublicServer();

  const { data: productRow } = await supabase
    .from("products")
    .select("*")
    .eq("slug", slug)
    .eq("is_published", true)
    .is("archived_at", null)
    .maybeSingle();

  if (!productRow) return null;
  const product = productRow as CatalogProduct & Record<string, unknown>;

  // One round trip for everything that hangs off the product.
  const [mediaResult, groupResult, categoryResult] = await Promise.all([
    supabase.from("product_media").select("*").eq("product_id", product.id).order("sort_order"),
    supabase
      .from("product_option_groups")
      .select("*,product_option_values(*)")
      .eq("product_id", product.id)
      .order("sort_order"),
    product.category_id
      ? supabase.from("product_categories").select("id,name,slug,parent_id").eq("id", product.category_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const category = (categoryResult.data ?? null) as CategoryRow | null;

  const [parentResult, relatedResult] = await Promise.all([
    category?.parent_id
      ? supabase.from("product_categories").select("id,name,slug,parent_id").eq("id", category.parent_id).maybeSingle()
      : Promise.resolve({ data: null }),
    // Related products share the category. Without one there is nothing
    // meaningful to relate, so the section simply does not render rather than
    // falling back to "any three other products", which is not a relationship.
    product.category_id
      ? supabase
          .from("products")
          .select(
            "id,name,slug,short_description,image_url,category,purchase_mode,starting_price_cents,is_custom,availability_status,lead_time_text,inventory_policy,inventory_quantity,continue_selling_when_out_of_stock"
          )
          .eq("category_id", product.category_id)
          .eq("is_published", true)
          .is("archived_at", null)
          .neq("id", product.id)
          .order("sort_order")
          .limit(3)
      : Promise.resolve({ data: [] }),
  ]);

  const related = (relatedResult.data ?? []) as ProductCardProduct[];
  if (related.length) {
    const { data: relatedMedia } = await supabase
      .from("product_media")
      .select("product_id,url,kind,sort_order")
      .in(
        "product_id",
        related.map((item) => item.id)
      )
      .eq("kind", "image")
      .order("sort_order");
    const byProduct = groupMediaByProduct(relatedMedia ?? []);
    for (const item of related) item.product_media = byProduct.get(item.id) ?? [];
  }

  const groups = ((groupResult.data ?? []) as ProductOptionGroup[]).map((group) => ({
    ...group,
    product_option_values: [...(group.product_option_values ?? [])]
      .filter((value) => value.is_active)
      .sort((a, b) => a.sort_order - b.sort_order),
  }));

  return {
    product,
    media: (mediaResult.data ?? []) as ProductMedia[],
    groups,
    category,
    parentCategory: (parentResult.data ?? null) as CategoryRow | null,
    related,
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const [loaded, settings] = await Promise.all([loadProduct(slug), getSiteSettings()]);
  if (!loaded) return { title: "Product not found" };

  const { product } = loaded;
  const description =
    product.short_description?.trim() ||
    product.description?.trim().slice(0, 200) ||
    `${product.name} from ${settings.name}.`;
  const image = primaryProductImage(product);

  return {
    // Bare, not `${name} | ${site}`: the root layout's title template already
    // appends the site name, and doing it here produced "Premade Shift Knob |
    // KeyMoura | KeyMoura" in the tab.
    title: product.name,
    description,
    alternates: { canonical: `/catalog/${product.slug}` },
    openGraph: {
      title: product.name,
      description,
      type: "website",
      url: `/catalog/${product.slug}`,
      images: image ? [{ url: image }] : [],
    },
    twitter: {
      card: "summary_large_image",
      title: product.name,
      description,
      images: image ? [image] : [],
    },
  };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [loaded, settings] = await Promise.all([loadProduct(slug), getSiteSettings()]);
  if (!loaded) notFound();

  const { product, media, groups, category, parentCategory, related } = loaded;

  const purchaseMode = normalizePurchaseMode(product.purchase_mode);
  const available = productCanBeRequested(product);
  const inStock =
    product.inventory_policy === "unlimited" ||
    product.inventory_quantity > 0 ||
    product.continue_selling_when_out_of_stock;

  const facts = parseProductFacts(product);
  const content = parseDetailContent(product.detail_content);
  const sections = buildProductSections({ description: product.description, content, facts });

  // Ready to ship means real, countable stock — not merely "not unavailable".
  const readyToShip =
    !facts.madeToOrder && product.inventory_policy === "track" && product.inventory_quantity > 0;
  const factsRow = quickFacts(facts, { readyToShip });

  const images: GalleryImage[] = media
    .filter((asset) => asset.kind === "image")
    .map((asset) => ({
      id: asset.id,
      url: normalizeImageUrl(asset.url) ?? "",
      alt: asset.alt_text?.trim() || product.name,
      caption: asset.alt_text?.trim() || null,
    }))
    .filter((image) => image.url);

  // The denormalized cover is a fallback only, and only when the gallery is
  // genuinely empty — the canonical order is gallery first, then image_url.
  if (!images.length) {
    const cover = normalizeImageUrl(product.image_url);
    if (cover) images.push({ id: "cover", url: cover, alt: product.name, caption: null });
  }

  const modelUrl = normalizeImageUrl(media.find((asset) => asset.kind === "model")?.url ?? product.model_url);
  const canRequest = allowsRequest(purchaseMode) && available;
  const shareUrl = `${settings.url.replace(/\/$/, "")}/catalog/${product.slug}`;
  const maxQuantity =
    product.inventory_policy === "track" && !product.continue_selling_when_out_of_stock
      ? Math.max(product.inventory_quantity, 0)
      : null;

  return (
    <main className="product-page">
      <nav aria-label="Breadcrumb" className="product-breadcrumb">
        <ol>
          <li>
            <Link href="/">Home</Link>
          </li>
          <li>
            <Link href="/catalog">Products</Link>
          </li>
          {parentCategory ? (
            <li>
              <Link href={`/catalog?category=${encodeURIComponent(parentCategory.name)}`}>
                {parentCategory.name}
              </Link>
            </li>
          ) : null}
          {category ? (
            <li>
              <Link href={`/catalog?category=${encodeURIComponent(category.name)}`}>{category.name}</Link>
            </li>
          ) : null}
          <li aria-current="page">{product.name}</li>
        </ol>
      </nav>

      <div className="product-layout">
        <div className="product-media-column">
          <ProductGallery
            images={images}
            productName={product.name}
            modelUrl={modelUrl}
            modelPoster={normalizeImageUrl(product.model_poster_url)}
          />
        </div>

        {/*
          One box, in normal document flow. There is no inner scroll wrapper:
          this column used to be a sticky, `max-height`-bounded, `overflow-y:
          auto` card, which gave the purchase controls their own scrollbar
          inside the page's. See the note on `.product-info-column` in
          globals.css for why sticky was removed rather than repaired.
        */}
        <div className="product-info-column">
          <div className="product-eyebrow-row">
            <span className="ui-badge ui-badge-accent">{PURCHASE_MODE_COPY[purchaseMode].label}</span>
            <span className={`ui-badge ${available ? "ui-badge-success" : "ui-badge-danger"}`}>
              {availabilityLabel(product.availability_status)}
            </span>
            {product.inventory_policy === "track" ? (
              <span className="ui-badge">{inventoryLabel(product)}</span>
            ) : null}
          </div>

          <h1 className="product-title">{product.name}</h1>

          {product.short_description ? (
            <p className="product-summary">{product.short_description}</p>
          ) : null}

          {/* No rating is rendered. `product_reviews` exists but holds no
              rows and there is no review UI yet, so any star row here would
              be decoration standing in for data that does not exist. */}

          <ProductPurchasePanel
            productId={product.id}
            productName={product.name}
            purchaseMode={purchaseMode}
            startingPriceCents={product.starting_price_cents}
            available={available}
            inStock={inStock}
            maxQuantity={maxQuantity}
            groups={groups}
            requestHref="#request-form"
            shareUrl={shareUrl}
          />

          {factsRow.length ? (
            <dl className="product-quick-facts">
              {factsRow.map((fact) => (
                <div key={fact.label} className="product-quick-fact">
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          <ul className="product-assurances">
            <li>Every custom request is reviewed by a person before any payment.</li>
            <li>
              Questions about material or tolerance? Read the{" "}
              <Link href="/design-guide">design guide</Link> or <Link href="/contact">ask first</Link>.
            </li>
          </ul>
        </div>
      </div>

      <ProductSections sections={sections} />

      {canRequest ? <ProductRequestForm product={product} groups={groups} canRequest={canRequest} /> : null}

      {related.length ? (
        <section className="product-related" aria-labelledby="related-heading">
          <h2 id="related-heading" className="product-sections-heading">
            More in {category?.name ?? "this category"}
          </h2>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {related.map((item) => (
              <ProductCard key={item.id} product={item} />
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
