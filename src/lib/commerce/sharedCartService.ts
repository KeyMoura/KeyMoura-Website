import "server-only";

import { createHash } from "node:crypto";
import { routeServiceClient } from "@/lib/api/routeAuth";
import { createToken, loadPricedProducts, resolveCart, type CartOwner } from "@/lib/commerce/cartService";
import { isRejected, priceLine, type PricedProduct } from "@/lib/commerce/pricing";
import { allowsRequest, normalizePurchaseMode, type PurchaseMode } from "@/lib/commerce/purchaseModes";
import { isValidShareToken, shareExpiryFrom, shareIsLive } from "@/lib/commerce/sharing";
import { groupMediaByProduct, type ProductImageSource, type ProductMediaRef } from "@/lib/productImages";

/**
 * Shared carts.
 *
 * A share link points at an **immutable snapshot**, never at the owner's live
 * cart. Two reasons, and both matter: the owner can keep shopping without the
 * link mutating under whoever they sent it to, and a leaked link can never
 * become a read on someone's current activity.
 *
 * The snapshot records what each line cost *at the time it was shared*. That
 * number is display-only — it exists so the page can say "this went up since
 * this list was shared" — and is never used to charge anyone. Every price a
 * viewer can act on is re-resolved from live product rows here, and re-resolved
 * again by `addCartItem` when they copy it.
 */

export type SharedCartSnapshotItem = {
  productId: string;
  quantity: number;
  selectedOptions: Record<string, string>;
  /** Historical, for the "price changed" comparison only. Never charged. */
  name: string;
  unitPriceCents: number;
};

export type SharedCartLine = {
  productId: string;
  name: string;
  slug: string;
  image: ProductImageSource;
  quantity: number;
  selectedOptions: Record<string, string>;
  optionLabels: Array<{ group: string; label: string; adjustmentCents: number }>;
  /** Current price. Null when the line cannot be priced any more. */
  unitPriceCents: number | null;
  lineSubtotalCents: number | null;
  snapshotUnitPriceCents: number;
  priceChanged: boolean;
  cartEligible: boolean;
  blockedMessage: string | null;
  removed: boolean;
  canRequest: boolean;
  purchaseMode: PurchaseMode;
};

export type SharedCartView = {
  lines: SharedCartLine[];
  note: string | null;
  sharedAt: string;
  expiresAt: string | null;
  /** Total of what is still buyable, live. */
  currentSubtotalCents: number;
  /** What the same set cost when it was shared. */
  snapshotSubtotalCents: number;
};

export type SharedCartSummary = {
  token: string;
  itemCount: number;
  note: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  viewCount: number;
};

export const MAX_SHARED_CART_ITEMS = 50;

/**
 * Stable, non-reversible owner identity for a share row.
 *
 * A distinct salt from the rate limiter's, so the two tables' digests cannot be
 * joined to correlate a caller's share links with their request volume.
 */
const OWNER_SALT = "keymoura.sharedcart.owner.v1";

export function ownerDigest(owner: CartOwner): string {
  const identity = "customerId" in owner ? `user:${owner.customerId}` : `guest:${owner.guestToken}`;
  return createHash("sha256").update(`${OWNER_SALT}:${identity}`).digest("base64url").slice(0, 43);
}

export type SharedCartError = { error: string; status: number };

const isError = (value: unknown): value is SharedCartError =>
  Boolean(value) && typeof value === "object" && "error" in (value as object);

export { isError as isSharedCartError };

/**
 * Snapshots the caller's current cart behind a fresh token.
 *
 * Only lines that are currently valid are captured. A cart may legitimately
 * contain something that has since gone request-only; sharing that as though it
 * were purchasable would be a link that promises something the checkout will
 * refuse.
 */
export async function createCartShare(
  owner: CartOwner,
  options: { expiresInDays?: unknown; note?: unknown } = {}
): Promise<SharedCartError | { ok: true; token: string; expiresAt: string | null }> {
  const resolved = await resolveCart(owner);
  const lines = resolved.priced.lines;

  if (!lines.length) {
    return { error: "Add something to your cart before sharing it.", status: 409 };
  }

  const items: SharedCartSnapshotItem[] = lines.slice(0, MAX_SHARED_CART_ITEMS).map((line) => ({
    productId: line.productId,
    quantity: line.quantity,
    selectedOptions: line.selectedOptions,
    name: line.product.name,
    unitPriceCents: line.unitPriceCents,
  }));

  const note = typeof options.note === "string" ? options.note.trim().slice(0, 200) : "";
  const token = createToken();
  const expiresAt = shareExpiryFrom(options.expiresInDays);
  const snapshotSubtotal = items.reduce((total, item) => total + item.unitPriceCents * item.quantity, 0);

  const { error } = await routeServiceClient.from("shared_carts").insert({
    token,
    // Kept for staff traceability on the authenticated path; never selected by
    // the public read.
    created_by: "customerId" in owner ? owner.customerId : null,
    owner_hash: ownerDigest(owner),
    items,
    note: note || null,
    expires_at: expiresAt,
    snapshot_subtotal_cents: snapshotSubtotal,
  });

  if (error) return { error: "Could not create a share link.", status: 500 };
  return { ok: true, token, expiresAt };
}

/** Every share this caller created, newest first, for the cart page to manage. */
export async function listCartShares(owner: CartOwner): Promise<SharedCartSummary[]> {
  const { data } = await routeServiceClient
    .from("shared_carts")
    .select("token,items,note,created_at,expires_at,revoked_at,view_count")
    .eq("owner_hash", ownerDigest(owner))
    .order("created_at", { ascending: false })
    .limit(20);

  return (data ?? []).map((row) => ({
    token: row.token as string,
    itemCount: Array.isArray(row.items) ? (row.items as unknown[]).length : 0,
    note: (row.note as string | null) ?? null,
    createdAt: row.created_at as string,
    expiresAt: (row.expires_at as string | null) ?? null,
    revokedAt: (row.revoked_at as string | null) ?? null,
    viewCount: Number(row.view_count ?? 0),
  }));
}

/**
 * Revokes one share.
 *
 * Scoped by `owner_hash`, which is the ownership check: a token belonging to
 * someone else's share matches nothing rather than being revoked.
 */
export async function revokeCartShare(owner: CartOwner, token: unknown): Promise<SharedCartError | { ok: true }> {
  if (!isValidShareToken(token)) return { error: "That share link is not valid.", status: 400 };

  const { data, error } = await routeServiceClient
    .from("shared_carts")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token", token.trim())
    .eq("owner_hash", ownerDigest(owner))
    .is("revoked_at", null)
    .select("token");

  if (error) return { error: "Could not revoke that link.", status: 500 };
  if (!data?.length) return { error: "That share link is not yours, or is already revoked.", status: 404 };
  return { ok: true };
}

function sanitizeSnapshot(value: unknown): SharedCartSnapshotItem[] {
  if (!Array.isArray(value)) return [];
  const items: SharedCartSnapshotItem[] = [];

  for (const entry of value.slice(0, MAX_SHARED_CART_ITEMS)) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const productId = typeof row.productId === "string" ? row.productId : "";
    if (!productId) continue;

    const options: Record<string, string> = {};
    if (row.selectedOptions && typeof row.selectedOptions === "object" && !Array.isArray(row.selectedOptions)) {
      for (const [key, val] of Object.entries(row.selectedOptions as Record<string, unknown>).slice(0, 30)) {
        if (typeof val === "string") options[key.slice(0, 60)] = val.slice(0, 120);
      }
    }

    items.push({
      productId,
      quantity: Math.min(Math.max(Math.trunc(Number(row.quantity ?? 1)) || 1, 1), 99),
      selectedOptions: options,
      name: typeof row.name === "string" ? row.name.slice(0, 200) : "",
      unitPriceCents: Math.max(0, Math.trunc(Number(row.unitPriceCents ?? 0)) || 0),
    });
  }

  return items;
}

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
 * Loads a shared cart by token, for anyone holding the link.
 *
 * Returns lines and nothing else. No customer id, no email, no guest token, no
 * cart id, no `created_by`, and no handle that would let a viewer write to the
 * owner's cart. Prices and availability are resolved live, and each line is
 * compared against the snapshot so the page can say what has changed.
 */
export async function loadSharedCart(token: unknown): Promise<SharedCartView | null> {
  if (!isValidShareToken(token)) return null;
  const clean = token.trim();

  const { data } = await routeServiceClient
    .from("shared_carts")
    .select("items,note,created_at,expires_at,revoked_at")
    .eq("token", clean)
    .maybeSingle();

  if (!data) return null;
  if (!shareIsLive({ revoked_at: data.revoked_at as string | null, expires_at: data.expires_at as string | null })) {
    return null;
  }

  const snapshot = sanitizeSnapshot(data.items);
  if (!snapshot.length) return null;

  const productIds = snapshot.map((item) => item.productId);
  const [products, display] = await Promise.all([loadPricedProducts(productIds), loadDisplayFields(productIds)]);

  const lines: SharedCartLine[] = [];
  let currentSubtotal = 0;
  let snapshotSubtotal = 0;

  for (const item of snapshot) {
    snapshotSubtotal += item.unitPriceCents * item.quantity;
    const product: PricedProduct | undefined = products.get(item.productId);

    if (!product) {
      lines.push({
        productId: item.productId,
        name: item.name || "This product is no longer available",
        slug: "",
        image: { image_url: null, product_media: [] },
        quantity: item.quantity,
        selectedOptions: item.selectedOptions,
        optionLabels: [],
        unitPriceCents: null,
        lineSubtotalCents: null,
        snapshotUnitPriceCents: item.unitPriceCents,
        priceChanged: false,
        cartEligible: false,
        blockedMessage: "This product has been removed from the catalog.",
        removed: true,
        canRequest: false,
        purchaseMode: "request_only",
      });
      continue;
    }

    const mode = normalizePurchaseMode(product.purchase_mode);
    const removed = !product.is_published || Boolean(product.archived_at);
    const priced = priceLine(product, {
      productId: item.productId,
      quantity: item.quantity,
      selectedOptions: item.selectedOptions,
    });
    const rejected = isRejected(priced);

    if (!rejected) currentSubtotal += priced.lineSubtotalCents;

    lines.push({
      productId: item.productId,
      name: product.name,
      slug: product.slug,
      image: display.get(item.productId) ?? { image_url: null, product_media: [] },
      // The live pricing may have clamped quantity to available stock, which is
      // itself worth showing rather than hiding.
      quantity: rejected ? item.quantity : priced.quantity,
      selectedOptions: rejected ? item.selectedOptions : priced.selectedOptions,
      optionLabels: rejected ? [] : priced.optionLabels,
      unitPriceCents: rejected ? null : priced.unitPriceCents,
      lineSubtotalCents: rejected ? null : priced.lineSubtotalCents,
      snapshotUnitPriceCents: item.unitPriceCents,
      priceChanged: !rejected && priced.unitPriceCents !== item.unitPriceCents,
      cartEligible: !rejected,
      blockedMessage: rejected ? priced.blocker.message : null,
      removed,
      canRequest: !removed && allowsRequest(mode),
      purchaseMode: mode,
    });
  }

  // Best-effort: a counter is not worth failing a page render over.
  await routeServiceClient.rpc("touch_shared_cart", { p_token: clean }).then(
    () => undefined,
    () => undefined
  );

  return {
    lines,
    note: (data.note as string | null) ?? null,
    sharedAt: data.created_at as string,
    expiresAt: (data.expires_at as string | null) ?? null,
    currentSubtotalCents: currentSubtotal,
    snapshotSubtotalCents: snapshotSubtotal,
  };
}
