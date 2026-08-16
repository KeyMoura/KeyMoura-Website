import "server-only";

import type { ProductCardProduct } from "@/components/ProductCard";
import type { CategoryRow } from "@/lib/commerce/categories";
import { groupMediaByProduct } from "@/lib/productImages";
import { supabasePublicServer } from "@/lib/supabasePublicServer";

export type CatalogProductRow = ProductCardProduct & {
  category_id?: string | null;
  created_at?: string | null;
};

export type CatalogData = {
  products: CatalogProductRow[];
  categories: CategoryRow[];
};

// One string literal rather than a concatenation: PostgREST's generated types
// read the select list at compile time, and a built-up string types the result
// as an error row instead of a product.
const PRODUCT_COLUMNS =
  "id,name,slug,short_description,image_url,category,category_id,purchase_mode,starting_price_cents,is_custom,availability_status,lead_time_text,inventory_policy,inventory_quantity,continue_selling_when_out_of_stock,material,created_at";

const CATEGORY_COLUMNS = "id,name,slug,description,parent_id,image_url,display_order,is_active,archived_at";

/**
 * Which products cannot be added to a cart without a decision, and which merely
 * offer one.
 *
 * **One query for the whole catalog, not one per card.** PostgREST embeds the
 * values inside their group, so the requirement rule — a required group with at
 * least one *active* value — is decided from a single round trip no matter how
 * many products are on the page. A per-card lookup here would be an N+1 on the
 * busiest page of the shop, and it would be invisible until the catalog grew.
 *
 * The rule is copied from `priceLine`, deliberately and exactly: a required
 * group with no usable values does not block a purchase there, so it must not
 * send a card to a configuration page here. The shop has one of those today.
 *
 * Both flags are readable by `anon` under RLS (`20260802020100_product_purchase
 * _modes.sql` scopes option reads to published products), so this stays on the
 * public client with the rest of the catalog and never sees a draft.
 */
type OptionGroupRow = {
  product_id: string;
  is_required: boolean;
  product_option_values: { is_active: boolean }[] | null;
};

async function attachOptionFlags(
  supabase: ReturnType<typeof supabasePublicServer>,
  products: CatalogProductRow[]
): Promise<void> {
  if (!products.length) return;

  const { data, error } = await supabase
    .from("product_option_groups")
    .select("product_id,is_required,product_option_values(is_active)")
    .in(
      "product_id",
      products.map((product) => product.id)
    );

  // A failure here costs the two badges and the sharper call-to-action, not the
  // catalog. Every card falls back to "no known options", and the server still
  // refuses an add that needed a choice — with the message it always gave.
  if (error) return;

  const required = new Set<string>();
  const any = new Set<string>();

  for (const row of (data ?? []) as OptionGroupRow[]) {
    any.add(row.product_id);
    const usableValues = (row.product_option_values ?? []).filter((value) => value.is_active).length;
    if (row.is_required && usableValues > 0) required.add(row.product_id);
  }

  for (const product of products) {
    product.requires_configuration = required.has(product.id);
    product.has_options = any.has(product.id);
  }
}

/**
 * "Interior / Shift Knobs" on every card, from the rows already in hand.
 *
 * `products.category` is a denormalized *name* and carries no hierarchy, so a
 * product filed under a subcategory used to show only the leaf — the card said
 * "Shift Knobs" with no indication of where that sits. Resolving the trail from
 * `category_id` against the categories this function already loaded costs no
 * extra query and gives the card the same two-level path the breadcrumb shows.
 *
 * A product with no category, or one pointing at a row that is archived or
 * hidden, gets no trail and falls back to the flat text. Nothing is invented.
 */
function attachCategoryTrails(products: CatalogProductRow[], categories: readonly CategoryRow[]): void {
  if (!products.length) return;
  const byId = new Map(categories.filter((row) => row.is_active && !row.archived_at).map((row) => [row.id, row]));

  for (const product of products) {
    const category = product.category_id ? byId.get(product.category_id) : undefined;
    if (!category) continue;
    const parent = category.parent_id ? byId.get(category.parent_id) : undefined;
    product.category_trail = parent ? [parent.name, category.name] : [category.name];
  }
}

/**
 * Everything the storefront catalog renders, loaded once as the public.
 *
 * Through the anon key rather than the service role, so RLS is a second guard
 * behind every filter here: a missing `.eq("is_published", true)` returns
 * nothing rather than serving a draft. It is also the reason this path is
 * exercisable locally at all — `.env.local` carries a deliberately fake
 * service-role key.
 *
 * **The whole published catalog is loaded, not one category's worth**, and
 * every page that uses this shares the result. Two reasons, and the second is
 * the one that matters:
 *
 * 1. Filtering a list already in memory is instant and needs no request, which
 *    is what lets search, availability, purchase type and sort respond to a
 *    keystroke without a round trip.
 * 2. The browse menu's counts are counts. A per-category page that loaded only
 *    its own products would have to *estimate* the other categories' numbers or
 *    issue a count query per category — and pass 9 recorded what happens when a
 *    card says 3 and the list it opens holds 5.
 *
 * Revalidated every five minutes by the pages that call it. If this catalog
 * ever grows past a few hundred products, the counts move to one grouped query
 * and the grid moves to a paginated server query; the shape here is the thing
 * that would change, not the pages.
 */
export async function loadCatalogData(): Promise<CatalogData> {
  const supabase = supabasePublicServer();

  const [productResult, categoryResult] = await Promise.all([
    supabase
      .from("products")
      .select(PRODUCT_COLUMNS)
      .eq("is_published", true)
      .is("archived_at", null)
      .order("sort_order")
      .order("created_at", { ascending: false }),
    supabase
      .from("product_categories")
      .select(CATEGORY_COLUMNS)
      .is("archived_at", null)
      .order("display_order"),
  ]);

  // A failed public query is an error page, never a convincing empty shop.
  // Throwing here lets the route error boundary and observability pipeline do
  // their jobs instead of translating an outage into "0 products".
  if (productResult.error || categoryResult.error) {
    throw new Error("Unable to load the storefront catalog");
  }

  const products = (productResult.data ?? []) as CatalogProductRow[];

  if (products.length) {
    const { data: media, error: mediaError } = await supabase
      .from("product_media")
      .select("product_id,url,kind,sort_order")
      .in(
        "product_id",
        products.map((product) => product.id)
      )
      .eq("kind", "image")
      .order("sort_order");

    if (mediaError) throw new Error("Unable to load storefront product media");

    const byProduct = groupMediaByProduct(media ?? []);
    for (const product of products) product.product_media = byProduct.get(product.id) ?? [];

    await attachOptionFlags(supabase, products);
  }

  const categories = (categoryResult.data ?? []) as CategoryRow[];
  attachCategoryTrails(products, categories);

  return { products, categories };
}

/**
 * The first few storefront products, in the catalog's own featured order.
 *
 * The homepage needs six products, not the catalog. `loadCatalogData` exists to
 * serve a browser that filters, counts and sorts the whole published list in
 * memory; asking it for a six-card row would fetch every product and every
 * product's media to render six of them.
 *
 * So this is a second *query*, deliberately, but not a second *source*: the
 * columns, the publication filter and the ordering are the ones above, and
 * `sort_order` then newest is exactly what the catalog calls "Featured". A
 * merchandiser who reorders the catalog reorders the homepage, which is the
 * property that matters — the homepage must never be able to disagree with
 * `/catalog` about which products lead.
 *
 * Failure is empty, not fatal. A product row is the one part of the homepage
 * that is genuinely optional: the brand story, the custom-work path and every
 * call to action stand on their own, so a catalog outage should cost the
 * section and not the page.
 */
export async function loadFeaturedProducts(limit = 6): Promise<CatalogProductRow[]> {
  try {
    const supabase = supabasePublicServer();

    const { data, error } = await supabase
      .from("products")
      .select(PRODUCT_COLUMNS)
      .eq("is_published", true)
      .is("archived_at", null)
      .order("sort_order")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) return [];

    const products = (data ?? []) as CatalogProductRow[];
    if (!products.length) return [];

    // One media query for the whole row rather than one per card: six products
    // must cost two round trips, not seven.
    const { data: media, error: mediaError } = await supabase
      .from("product_media")
      .select("product_id,url,kind,sort_order")
      .in(
        "product_id",
        products.map((product) => product.id)
      )
      .eq("kind", "image")
      .order("sort_order");

    if (mediaError) return products;

    const byProduct = groupMediaByProduct(media ?? []);
    for (const product of products) product.product_media = byProduct.get(product.id) ?? [];

    await attachOptionFlags(supabase, products);

    return products;
  } catch {
    return [];
  }
}
