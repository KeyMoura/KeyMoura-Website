/**
 * Canonical product image resolution.
 *
 * `products.image_url` is a denormalized cache of the primary gallery image. It
 * is legitimately null for products whose media was uploaded or reordered
 * without refreshing it, so reading it alone hides images that genuinely exist.
 * Every surface that shows a product must resolve through here instead, so the
 * homepage, the catalog grid, and the product page agree on which image wins.
 *
 * Order of preference:
 *   1. `product_media` rows of kind "image", by `sort_order`
 *   2. `products.image_url`
 *
 * Anything that cannot become a usable browser URL is dropped rather than
 * rendered as a broken image.
 */

export type ProductMediaRef = {
  url?: string | null;
  kind?: string | null;
  sort_order?: number | null;
};

export type ProductImageSource = {
  image_url?: string | null;
  product_media?: ProductMediaRef[] | null;
};

const STORAGE_PREFIX = "/storage/v1/object/public/";

function supabasePublicBase(): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!base) return null;
  return base.replace(/\/+$/, "");
}

/**
 * Turns a stored value into a URL a browser can load, or null.
 *
 * Accepts absolute http(s) URLs, protocol-relative URLs, root-relative site
 * paths, inline image data URLs, and bare Supabase Storage object paths such as
 * `product-assets/<id>/<file>.png`.
 */
export function normalizeImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;
  if (/^data:image\//i.test(raw)) return raw;

  // Reject any other scheme (javascript:, file:, …) before treating the value
  // as a path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;

  if (raw.startsWith("/")) {
    const base = supabasePublicBase();
    // A stored value may already be the storage path without its origin.
    if (base && raw.startsWith(STORAGE_PREFIX)) return `${base}${raw}`;
    return raw;
  }

  const base = supabasePublicBase();
  if (!base) return null;
  return `${base}${STORAGE_PREFIX}${raw.replace(/^\/+/, "")}`;
}

/**
 * Every usable image for a product, best first, without duplicates.
 *
 * Returning the full list lets a card fall forward to the next real image when
 * one URL turns out to be broken, instead of dropping straight to a placeholder.
 */
export function productImageCandidates(product: ProductImageSource | null | undefined): string[] {
  if (!product) return [];

  const gallery = (product.product_media ?? [])
    .filter((asset) => asset && (asset.kind ?? "image") === "image")
    .slice()
    .sort((left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0))
    .map((asset) => asset.url);

  const ordered = [...gallery, product.image_url];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of ordered) {
    const normalized = normalizeImageUrl(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

/** The single image a product should lead with, or null when it truly has none. */
export function primaryProductImage(product: ProductImageSource | null | undefined): string | null {
  return productImageCandidates(product)[0] ?? null;
}

/**
 * Groups media rows by product id so a list query can be resolved in one pass.
 */
export function groupMediaByProduct<T extends ProductMediaRef & { product_id?: string | null }>(
  rows: readonly T[] | null | undefined
): Map<string, T[]> {
  const byProduct = new Map<string, T[]>();
  for (const row of rows ?? []) {
    const id = row.product_id;
    if (!id) continue;
    const list = byProduct.get(id);
    if (list) list.push(row);
    else byProduct.set(id, [row]);
  }
  for (const list of byProduct.values()) {
    list.sort((left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0));
  }
  return byProduct;
}
