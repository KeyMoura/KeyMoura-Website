import "server-only";

import { routeServiceClient } from "@/lib/api/routeAuth";
import { groupMediaByProduct, type ProductImageSource, type ProductMediaRef } from "@/lib/productImages";

/**
 * Display-only product fields the pricing loader has no reason to carry.
 *
 * Every commerce surface that shows a product alongside a price — the cart, the
 * cart drawer, the wishlist, a shared cart, a shared wishlist — needs the same
 * cover image resolved by the same rules. This is that one loader.
 *
 * It used to be copy-pasted into `wishlistService` and `sharedCartService`, and
 * the cart would have been a third copy. Three implementations of "which image
 * wins" is how one of them quietly starts disagreeing with the catalog.
 *
 * Media is fetched separately from pricing and grouped in memory, the same way
 * the catalog and homepage do it, so a line resolves its image through exactly
 * the same rules as a product card: gallery order first, the denormalized
 * `products.image_url` only as a fallback. Reading `image_url` alone is what
 * used to make products with real images render as placeholders.
 */

/** What a line carries when its product is gone, unpublished, or imageless. */
export const EMPTY_IMAGE_SOURCE: ProductImageSource = { image_url: null, product_media: [] };

/**
 * Cover-image sources for a set of products, keyed by product id.
 *
 * Two batched queries regardless of how many products are asked for, so a
 * fifty-line cart costs the same as a one-line cart. Ids are de-duplicated
 * first, because a cart may legitimately hold the same product configured two
 * different ways.
 */
export async function loadProductImageSources(
  productIds: readonly string[]
): Promise<Map<string, ProductImageSource>> {
  const unique = Array.from(new Set(productIds)).filter(Boolean);
  if (!unique.length) return new Map();

  const [{ data: products }, { data: media }] = await Promise.all([
    routeServiceClient.from("products").select("id,image_url").in("id", unique),
    routeServiceClient
      .from("product_media")
      .select("product_id,url,kind,sort_order")
      .in("product_id", unique)
      .eq("kind", "image")
      .order("sort_order"),
  ]);

  const byProduct = groupMediaByProduct((media ?? []) as Array<ProductMediaRef & { product_id?: string | null }>);
  return new Map(
    (products ?? []).map((row) => [
      row.id as string,
      { image_url: (row.image_url as string | null) ?? null, product_media: byProduct.get(row.id as string) ?? [] },
    ])
  );
}
