import "server-only";

import { routeServiceClient } from "@/lib/api/routeAuth";
import { createToken, loadPricedProducts, MAX_CART_LINES } from "@/lib/commerce/cartService";
import { isRejected, priceLine, type PricedProduct } from "@/lib/commerce/pricing";
import { allowsRequest, normalizePurchaseMode, type PurchaseMode } from "@/lib/commerce/purchaseModes";
import { isValidShareToken, MAX_SHARE_DAYS, shareExpiryFrom, shareIsLive } from "@/lib/commerce/sharing";
import { groupMediaByProduct, type ProductImageSource, type ProductMediaRef } from "@/lib/productImages";

/**
 * The wishlist.
 *
 * A wishlist is not a cart and deliberately does not share its rules. A cart
 * may only hold things that can be bought outright; a wishlist may hold
 * anything published, including a `request_only` product someone wants quoted
 * later. So an entry is never dropped for being unpurchasable — it is kept and
 * annotated, and only the "move to cart" action is gated.
 *
 * Like the cart, a wishlist item stores product id and option selections only.
 * Every price and availability answer is resolved live here and again whenever
 * an item actually moves into a cart.
 */

export type WishlistOwner = { customerId: string } | { guestToken: string };

export type WishlistRecord = {
  id: string;
  customer_id: string | null;
  guest_token: string | null;
  share_token: string | null;
  is_public: boolean;
  share_expires_at: string | null;
  shared_at: string | null;
};

const WISHLIST_COLUMNS = "id,customer_id,guest_token,share_token,is_public,share_expires_at,shared_at";

/** A wishlist is a browsable page; an unbounded one is a slow page for its owner. */
export const MAX_WISHLIST_ITEMS = 100;

export type StoredWishlistItem = {
  id: string;
  product_id: string;
  selected_options: Record<string, string>;
  created_at: string;
};

export type WishlistEntry = {
  itemId: string;
  productId: string;
  name: string;
  slug: string;
  /** Shaped for the shared ProductImage component, not a pre-resolved URL. */
  image: ProductImageSource;
  selectedOptions: Record<string, string>;
  optionLabels: Array<{ group: string; label: string; adjustmentCents: number }>;
  /** Null whenever the product cannot be priced outright right now. */
  unitPriceCents: number | null;
  purchaseMode: PurchaseMode;
  /** True when this exact configuration could be added to a cart today. */
  cartEligible: boolean;
  /** Why not, in the customer's language. Null when it is eligible. */
  blockedMessage: string | null;
  /** True when the product is gone, unpublished, or archived. */
  removed: boolean;
  canRequest: boolean;
  addedAt: string;
};

export type ResolvedWishlist = {
  wishlistId: string | null;
  entries: WishlistEntry[];
  share: { token: string; isPublic: boolean; expiresAt: string | null; sharedAt: string | null } | null;
};

function sanitizeOptions(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
    if (typeof entry !== "string") continue;
    const cleanKey = key.trim().slice(0, 60);
    if (!cleanKey) continue;
    result[cleanKey] = entry.trim().slice(0, 120);
  }
  return result;
}

export async function findWishlist(owner: WishlistOwner): Promise<WishlistRecord | null> {
  const query = routeServiceClient.from("wishlists").select(WISHLIST_COLUMNS);
  const { data } = await ("customerId" in owner
    ? query.eq("customer_id", owner.customerId)
    : query.eq("guest_token", owner.guestToken)
  ).maybeSingle();
  return (data as WishlistRecord | null) ?? null;
}

export async function findOrCreateWishlist(owner: WishlistOwner): Promise<WishlistRecord> {
  const existing = await findWishlist(owner);
  if (existing) return existing;

  const insert = "customerId" in owner ? { customer_id: owner.customerId } : { guest_token: owner.guestToken };
  const { data, error } = await routeServiceClient.from("wishlists").insert(insert).select(WISHLIST_COLUMNS).single();

  // A concurrent request may have won the race; the partial unique indexes turn
  // that into a conflict rather than a second wishlist.
  if (error) {
    const retry = await findWishlist(owner);
    if (retry) return retry;
    throw new Error("Could not open a wishlist.");
  }
  return data as WishlistRecord;
}

export async function loadWishlistItems(wishlistId: string): Promise<StoredWishlistItem[]> {
  const { data } = await routeServiceClient
    .from("wishlist_items")
    .select("id,product_id,selected_options,created_at")
    .eq("wishlist_id", wishlistId)
    .order("created_at", { ascending: false });

  return (data ?? []).map((row) => ({
    id: row.id as string,
    product_id: row.product_id as string,
    selected_options: sanitizeOptions(row.selected_options),
    created_at: row.created_at as string,
  }));
}

/**
 * Display-only fields the pricing loader has no reason to carry.
 *
 * Media is fetched separately and grouped, the same way the catalog and
 * homepage do it, so a wishlist row resolves its image through exactly the same
 * rules — gallery order first, the denormalized `image_url` only as a fallback.
 * Reading `image_url` alone is what used to make products with real images
 * render as placeholders.
 */
async function loadDisplayFields(productIds: readonly string[]): Promise<Map<string, ProductImageSource>> {
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

/**
 * Turns stored items into displayable entries, resolving every product live.
 *
 * Shared by the owner's page and the public shared page so a viewer and an
 * owner never see different prices or different availability for the same item.
 */
export async function resolveWishlistEntries(items: readonly StoredWishlistItem[]): Promise<WishlistEntry[]> {
  if (!items.length) return [];

  const productIds = items.map((item) => item.product_id);
  const [products, display] = await Promise.all([loadPricedProducts(productIds), loadDisplayFields(productIds)]);

  const entries: WishlistEntry[] = [];
  for (const item of items) {
    const product: PricedProduct | undefined = products.get(item.product_id);

    // The foreign key cascades on delete, so a missing row means the product was
    // removed between the read and now. Show it as gone rather than hiding it.
    if (!product) {
      entries.push({
        itemId: item.id,
        productId: item.product_id,
        name: "This product is no longer available",
        slug: "",
        image: { image_url: null, product_media: [] },
        selectedOptions: item.selected_options,
        optionLabels: [],
        unitPriceCents: null,
        purchaseMode: "request_only",
        cartEligible: false,
        blockedMessage: "This product has been removed from the catalog.",
        removed: true,
        canRequest: false,
        addedAt: item.created_at,
      });
      continue;
    }

    const mode = normalizePurchaseMode(product.purchase_mode);
    const removed = !product.is_published || Boolean(product.archived_at);
    const priced = priceLine(product, {
      productId: item.product_id,
      quantity: 1,
      selectedOptions: item.selected_options,
    });
    const rejected = isRejected(priced);

    entries.push({
      itemId: item.id,
      productId: item.product_id,
      name: product.name,
      slug: product.slug,
      image: display.get(item.product_id) ?? { image_url: null, product_media: [] },
      selectedOptions: rejected ? item.selected_options : priced.selectedOptions,
      optionLabels: rejected ? [] : priced.optionLabels,
      unitPriceCents: rejected ? null : priced.unitPriceCents,
      purchaseMode: mode,
      cartEligible: !rejected,
      blockedMessage: rejected ? priced.blocker.message : null,
      removed,
      // An unpublished product cannot be requested either; a live request-only
      // one is exactly what the request path is for.
      canRequest: !removed && allowsRequest(mode),
      addedAt: item.created_at,
    });
  }

  return entries;
}

function shareOf(wishlist: WishlistRecord): ResolvedWishlist["share"] {
  if (!wishlist.share_token || !wishlist.is_public) return null;
  return {
    token: wishlist.share_token,
    isPublic: wishlist.is_public,
    expiresAt: wishlist.share_expires_at,
    sharedAt: wishlist.shared_at,
  };
}

export async function resolveWishlist(owner: WishlistOwner | null): Promise<ResolvedWishlist> {
  const empty: ResolvedWishlist = { wishlistId: null, entries: [], share: null };
  if (!owner) return empty;

  const wishlist = await findWishlist(owner);
  if (!wishlist) return empty;

  const items = await loadWishlistItems(wishlist.id);
  return {
    wishlistId: wishlist.id,
    entries: await resolveWishlistEntries(items),
    share: shareOf(wishlist),
  };
}

export type WishlistMutationError = { error: string; status: number };

const isError = (value: unknown): value is WishlistMutationError =>
  Boolean(value) && typeof value === "object" && "error" in (value as object);

export { isError as isWishlistMutationError };

/**
 * Adds a product to a wishlist.
 *
 * The only gate is that the product is real and publicly visible. A
 * `request_only` product is a perfectly reasonable thing to save, so purchase
 * mode is *not* checked here — it is checked when the item moves to a cart.
 */
export async function addWishlistItem(
  owner: WishlistOwner,
  input: { productId: string; selectedOptions: unknown }
): Promise<WishlistMutationError | { ok: true }> {
  const productId = typeof input.productId === "string" ? input.productId.trim() : "";
  if (!productId) return { error: "Choose a product first.", status: 400 };

  const products = await loadPricedProducts([productId]);
  const product = products.get(productId);
  if (!product) return { error: "That product is no longer available.", status: 404 };
  if (!product.is_published || product.archived_at) {
    return { error: "That product is no longer available.", status: 409 };
  }

  const wishlist = await findOrCreateWishlist(owner);
  const existing = await loadWishlistItems(wishlist.id);

  // `wishlist_items_unique` is on (wishlist_id, product_id), so one product is
  // one entry regardless of options. Saving it again is a no-op, not an error:
  // the button is a toggle and re-adding must stay idempotent.
  if (existing.some((item) => item.product_id === productId)) return { ok: true };

  if (existing.length >= MAX_WISHLIST_ITEMS) {
    return { error: `A wishlist holds up to ${MAX_WISHLIST_ITEMS} items.`, status: 409 };
  }

  const { error } = await routeServiceClient.from("wishlist_items").insert({
    wishlist_id: wishlist.id,
    product_id: productId,
    selected_options: sanitizeOptions(input.selectedOptions),
  });

  // A concurrent add hits the unique index; that is the desired end state.
  if (error) {
    const retry = await loadWishlistItems(wishlist.id);
    if (retry.some((item) => item.product_id === productId)) return { ok: true };
    return { error: "Could not save that to your wishlist.", status: 500 };
  }
  await touchWishlist(wishlist.id);
  return { ok: true };
}

async function touchWishlist(wishlistId: string): Promise<void> {
  await routeServiceClient.from("wishlists").update({ updated_at: new Date().toISOString() }).eq("id", wishlistId);
}

/** Removes by item id or by product id. Both are scoped to the caller's own list. */
export async function removeWishlistItem(
  owner: WishlistOwner,
  target: { itemId?: string; productId?: string }
): Promise<WishlistMutationError | { ok: true }> {
  const wishlist = await findWishlist(owner);
  if (!wishlist) return { ok: true };

  const query = routeServiceClient.from("wishlist_items").delete();
  // Scoping the delete by wishlist_id is the ownership check: an id belonging to
  // someone else's list matches nothing rather than being deleted.
  const scoped = target.itemId
    ? query.eq("id", target.itemId).eq("wishlist_id", wishlist.id)
    : target.productId
      ? query.eq("product_id", target.productId).eq("wishlist_id", wishlist.id)
      : null;

  if (!scoped) return { error: "Nothing to remove.", status: 400 };

  const { error } = await scoped;
  if (error) return { error: "Could not remove that item.", status: 500 };
  await touchWishlist(wishlist.id);
  return { ok: true };
}

export async function clearWishlist(owner: WishlistOwner): Promise<WishlistMutationError | { ok: true }> {
  const wishlist = await findWishlist(owner);
  if (!wishlist) return { ok: true };

  const { error } = await routeServiceClient.from("wishlist_items").delete().eq("wishlist_id", wishlist.id);
  if (error) return { error: "Could not clear your wishlist.", status: 500 };
  return { ok: true };
}

/**
 * Folds a guest wishlist into the signed-in account's list.
 *
 * Mirrors the cart merge: entries the account already has are kept as they are,
 * new ones are copied across, and the guest list is emptied and detached rather
 * than left as a second live list behind a cookie the browser still holds.
 */
export async function mergeGuestWishlist(guestToken: string, customerId: string): Promise<void> {
  const guestList = await findWishlist({ guestToken });
  if (!guestList) return;

  const guestItems = await loadWishlistItems(guestList.id);
  if (guestItems.length) {
    const target = await findOrCreateWishlist({ customerId });
    const existing = await loadWishlistItems(target.id);
    const owned = new Set(existing.map((item) => item.product_id));
    const room = Math.max(0, MAX_WISHLIST_ITEMS - existing.length);

    const incoming = guestItems.filter((item) => !owned.has(item.product_id)).slice(0, room);
    if (incoming.length) {
      await routeServiceClient.from("wishlist_items").insert(
        incoming.map((item) => ({
          wishlist_id: target.id,
          product_id: item.product_id,
          selected_options: item.selected_options,
        }))
      );
    }
  }

  // The guest list is deleted outright rather than kept: unlike a cart there is
  // no status column to mark it abandoned, and leaving it would leave a live
  // share link pointing at a list its owner can no longer reach.
  await routeServiceClient.from("wishlists").delete().eq("id", guestList.id);
}

/* ---------------------------------------------------------------------- */
/* Sharing                                                                 */
/* ---------------------------------------------------------------------- */

export { MAX_SHARE_DAYS };

/**
 * Turns sharing on and returns the link token.
 *
 * The token is 32 bytes of CSPRNG output, which is what makes the public page
 * unenumerable — there is no sequential id and no owner identifier anywhere in
 * the URL. Re-sharing an already-shared list rotates nothing by default so a
 * link already sent to someone keeps working.
 */
export async function createWishlistShare(
  owner: WishlistOwner,
  options: { expiresInDays?: number | null; rotate?: boolean } = {}
): Promise<WishlistMutationError | { ok: true; token: string; expiresAt: string | null }> {
  const wishlist = await findOrCreateWishlist(owner);

  const items = await loadWishlistItems(wishlist.id);
  if (!items.length) return { error: "Add something to your wishlist before sharing it.", status: 409 };

  const expiresAt = shareExpiryFrom(options.expiresInDays);
  const token = options.rotate || !wishlist.share_token ? createToken() : wishlist.share_token;

  const { error } = await routeServiceClient
    .from("wishlists")
    .update({
      share_token: token,
      is_public: true,
      share_expires_at: expiresAt,
      shared_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", wishlist.id);

  if (error) return { error: "Could not create a share link.", status: 500 };
  return { ok: true, token, expiresAt };
}

/**
 * Revokes sharing.
 *
 * The token is cleared, not merely hidden behind `is_public`, so a link that
 * leaked cannot be revived by a later bug that flips the flag back on.
 */
export async function revokeWishlistShare(owner: WishlistOwner): Promise<WishlistMutationError | { ok: true }> {
  const wishlist = await findWishlist(owner);
  if (!wishlist) return { ok: true };

  const { error } = await routeServiceClient
    .from("wishlists")
    .update({ share_token: null, is_public: false, share_expires_at: null, shared_at: null })
    .eq("id", wishlist.id);

  if (error) return { error: "Could not turn off sharing.", status: 500 };
  return { ok: true };
}

export type SharedWishlistView = {
  entries: WishlistEntry[];
  sharedAt: string | null;
  expiresAt: string | null;
};

/**
 * Loads a shared wishlist by token, for anyone holding the link.
 *
 * Returns entries only. No customer id, no email, no guest token, no wishlist
 * id, and nothing that could be used to write to the list — a viewer holds a
 * read capability on a set of products, not a handle on someone's account.
 */
export async function loadSharedWishlist(token: string): Promise<SharedWishlistView | null> {
  // Reject a malformed token before it ever reaches a query. A short or
  // wrongly-shaped value is a probe, not a lost link.
  if (!isValidShareToken(token)) return null;
  const clean = token.trim();

  const { data } = await routeServiceClient
    .from("wishlists")
    .select("id,is_public,share_expires_at,shared_at")
    .eq("share_token", clean)
    .maybeSingle();

  if (!data) return null;

  const expiresAt = (data.share_expires_at as string | null) ?? null;
  if (!shareIsLive({ is_public: data.is_public as boolean, expires_at: expiresAt })) return null;

  const items = await loadWishlistItems(data.id as string);
  return {
    entries: await resolveWishlistEntries(items),
    sharedAt: (data.shared_at as string | null) ?? null,
    expiresAt,
  };
}

/* ---------------------------------------------------------------------- */
/* Wire shape                                                              */
/* ---------------------------------------------------------------------- */

/** Deliberately carries no owner identity, on either the owner or shared path. */
export function serializeWishlist(resolved: ResolvedWishlist) {
  return {
    itemCount: resolved.entries.length,
    cartEligibleCount: resolved.entries.filter((entry) => entry.cartEligible).length,
    share: resolved.share,
    items: resolved.entries,
  };
}

export type SerializedWishlist = ReturnType<typeof serializeWishlist>;

export { MAX_CART_LINES };
