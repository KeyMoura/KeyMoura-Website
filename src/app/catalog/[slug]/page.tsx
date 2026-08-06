import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import CatalogPageView from "@/components/catalog/CatalogPageView";
import { categoryPath, productsInCategory, resolveCategoryPath } from "@/lib/commerce/catalogBrowse";
import { loadCatalogData } from "@/lib/commerce/catalogData";
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

/**
 * One dynamic segment, two kinds of page.
 *
 * `/catalog/[slug]` is a **category** when the slug names one, and a product
 * otherwise. Next.js cannot have two different dynamic segments in one
 * position, and products were not moved to make room: `/catalog/premade-shift-knob`
 * is live, indexed, and linked from the cart, the wishlist, order pages and
 * transactional email. Breaking those to gain a URL shape a customer cannot
 * see is not a trade worth making.
 *
 * The ambiguity that would normally make this fragile is closed in the
 * database: `20260806040000_catalog_slug_namespace.sql` refuses a category
 * slug a product already uses and a product slug a category already uses, so a
 * path can never name two things. The order below is therefore a formality
 * rather than a precedence rule — but categories are checked first so that if
 * the guard were ever dropped, the failure would be a visibly wrong page
 * rather than a silently shadowed category.
 *
 * The category lookup is one indexed query on a small table. A product page
 * pays for it and nothing else; the full catalog load happens only when the
 * slug really is a category.
 */
async function loadCategoryBySlug(slug: string): Promise<{ id: string } | null> {
  const { data } = await supabasePublicServer()
    .from("product_categories")
    .select("id")
    .eq("slug", slug)
    .eq("is_active", true)
    .is("archived_at", null)
    .maybeSingle();
  return (data as { id: string } | null) ?? null;
}

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

  if (await loadCategoryBySlug(slug)) {
    const [{ categories }, settings] = await Promise.all([loadCatalogData(), getSiteSettings()]);
    const category = resolveCategoryPath([slug], categories);
    if (category) {
      const description =
        category.description?.trim() ||
        `${category.name} from ${settings.name}. Buy what is ready, or ask us to make a version that fits.`;
      return {
        title: category.name,
        description,
        // The canonical is the category's own path and never carries filters:
        // a sort order is how you are looking at a page, not a different page.
        alternates: { canonical: categoryPath(category, categories) },
        openGraph: {
          title: category.name,
          description,
          type: "website",
          url: categoryPath(category, categories),
        },
      };
    }
  }

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

export default async function CatalogSlugPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  if (await loadCategoryBySlug(slug)) {
    const { products, categories } = await loadCatalogData();
    const category = resolveCategoryPath([slug], categories);
    // A *sub*category reached by its own slug alone is not a 404 — it exists —
    // but it has one canonical address, under its parent. Redirecting keeps a
    // single indexable URL per view and puts the right parent in the crumb.
    if (category?.parent_id) redirect(categoryPath(category, categories));
    if (category) {
      return (
        <CatalogPageView
          allProducts={products}
          scopedProducts={productsInCategory(products, category.id, categories)}
          categories={categories}
          category={category}
          parent={null}
        />
      );
    }
  }

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
          {/* Real category routes now, not `?category=<name>`. The old links
              still work — `/catalog` redirects them here — but a breadcrumb
              should point at the canonical address of the thing it names. */}
          {parentCategory ? (
            <li>
              <Link href={`/catalog/${parentCategory.slug}`}>{parentCategory.name}</Link>
            </li>
          ) : null}
          {category ? (
            <li>
              <Link
                href={
                  parentCategory
                    ? `/catalog/${parentCategory.slug}/${category.slug}`
                    : `/catalog/${category.slug}`
                }
              >
                {category.name}
              </Link>
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
