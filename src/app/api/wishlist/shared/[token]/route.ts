import { NextRequest, NextResponse } from "next/server";
import { addCartItem, isCartMutationError, resolveCart, serializeCart } from "@/lib/commerce/cartService";
import { attachGuestCookie, resolveOwnerForWrite, settleGuestMerge } from "@/lib/commerce/cartSession";
import { consumeRateLimit, rateLimitMessage, RATE_LIMITS } from "@/lib/commerce/rateLimit";
import {
  addWishlistItem,
  loadSharedWishlist,
  resolveWishlist,
  serializeWishlist,
} from "@/lib/commerce/wishlistService";
import {
  attachWishlistCookie,
  rateLimitIdentity,
  resolveWishlistOwnerForWrite,
  settleWishlistMerge,
} from "@/lib/commerce/wishlistSession";

/**
 * Copying from a shared wishlist into the viewer's own cart or wishlist.
 *
 * A share token is a read capability on a set of products. It is never an
 * authorization to act as the owner: the viewer's own owner is resolved from
 * their own cookies and session, and every copied line is revalidated through
 * the same `addCartItem` and `addWishlistItem` paths as any other request.
 *
 * The response carries nothing about the list's owner.
 */

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const shared = await loadSharedWishlist(token);
  if (!shared) return NextResponse.json({ error: "This wishlist link is not available." }, { status: 404 });
  return NextResponse.json({ shared });
}

export async function POST(req: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const destination = body.destination === "cart" ? "cart" : "wishlist";
  const productId = typeof body.productId === "string" ? body.productId : null;

  const shared = await loadSharedWishlist(token);
  if (!shared) return NextResponse.json({ error: "This wishlist link is not available." }, { status: 404 });

  // Only products actually on the shared list may be copied. Without this the
  // endpoint would be a general-purpose "add anything to my cart" route that
  // merely happens to require a valid token.
  const targets = productId
    ? shared.entries.filter((entry) => entry.productId === productId)
    : shared.entries.filter((entry) => (destination === "cart" ? entry.cartEligible : !entry.removed));

  if (!targets.length) {
    return NextResponse.json({ error: "That item is not on this list any more." }, { status: 404 });
  }

  const wishlistOwner = await resolveWishlistOwnerForWrite(req);
  if (!wishlistOwner.owner) return NextResponse.json({ error: "Could not open a wishlist." }, { status: 500 });
  await settleWishlistMerge(wishlistOwner);

  const verdict = await consumeRateLimit(RATE_LIMITS.wishlistCopy, rateLimitIdentity(wishlistOwner));
  if (!verdict.allowed) return NextResponse.json({ error: rateLimitMessage(verdict) }, { status: 429 });

  const failures: string[] = [];
  let copied = 0;

  if (destination === "cart") {
    const cartOwner = await resolveOwnerForWrite(req);
    if (!cartOwner.owner) return NextResponse.json({ error: "Could not open a cart." }, { status: 500 });
    await settleGuestMerge(cartOwner);

    for (const entry of targets) {
      const result = await addCartItem(cartOwner.owner, {
        productId: entry.productId,
        quantity: 1,
        selectedOptions: entry.selectedOptions,
      });
      if (isCartMutationError(result)) failures.push(result.error);
      else copied += 1;
    }

    const cart = await resolveCart(cartOwner.owner);
    const res = NextResponse.json(
      { copied, failures: Array.from(new Set(failures)), cart: serializeCart(cart) },
      { status: copied === 0 ? 409 : 200 }
    );
    return attachWishlistCookie(attachGuestCookie(res, cartOwner), wishlistOwner);
  }

  for (const entry of targets) {
    const result = await addWishlistItem(wishlistOwner.owner, {
      productId: entry.productId,
      selectedOptions: entry.selectedOptions,
    });
    if (result && "error" in result) failures.push(result.error);
    else copied += 1;
  }

  const wishlist = await resolveWishlist(wishlistOwner.owner);
  const res = NextResponse.json(
    { copied, failures: Array.from(new Set(failures)), wishlist: serializeWishlist(wishlist) },
    { status: copied === 0 ? 409 : 200 }
  );
  return attachWishlistCookie(res, wishlistOwner);
}
