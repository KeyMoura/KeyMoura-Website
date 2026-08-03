import { NextRequest, NextResponse } from "next/server";
import {
  addCartItem,
  isCartMutationError,
  resolveCart,
  serializeCart,
} from "@/lib/commerce/cartService";
import { attachGuestCookie, resolveOwnerForWrite, settleGuestMerge } from "@/lib/commerce/cartSession";
import { consumeRateLimit, rateLimitMessage, RATE_LIMITS } from "@/lib/commerce/rateLimit";
import {
  removeWishlistItem,
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
 * Moves or copies wishlist items into the cart.
 *
 * The wishlist's own record of what is purchasable is treated as a hint, not an
 * authority: every line goes through `addCartItem`, which re-checks purchase
 * mode, publication, stock, options, and price against live product rows. A
 * wishlist entry that looked eligible when the page rendered and is not
 * eligible now is refused here, exactly as a hand-written request would be.
 *
 * "Move" only removes an item once the cart has actually accepted it, so a
 * refusal can never lose the customer's saved item.
 */

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const wantsMove = body.mode === "move";
  const itemId = typeof body.itemId === "string" ? body.itemId : null;
  const all = body.all === true;

  if (!itemId && !all) return NextResponse.json({ error: "Nothing to move." }, { status: 400 });

  const wishlistOwner = await resolveWishlistOwnerForWrite(req);
  if (!wishlistOwner.owner) return NextResponse.json({ error: "Your wishlist is empty." }, { status: 404 });
  await settleWishlistMerge(wishlistOwner);

  const verdict = await consumeRateLimit(RATE_LIMITS.wishlistWrite, rateLimitIdentity(wishlistOwner));
  if (!verdict.allowed) return NextResponse.json({ error: rateLimitMessage(verdict) }, { status: 429 });

  const wishlist = await resolveWishlist(wishlistOwner.owner);
  const targets = itemId
    ? wishlist.entries.filter((entry) => entry.itemId === itemId)
    : wishlist.entries.filter((entry) => entry.cartEligible);

  if (!targets.length) {
    return NextResponse.json(
      { error: itemId ? "That item is no longer in your wishlist." : "Nothing in your wishlist can be bought outright yet." },
      { status: 404 }
    );
  }

  const cartOwner = await resolveOwnerForWrite(req);
  if (!cartOwner.owner) return NextResponse.json({ error: "Could not open a cart." }, { status: 500 });
  await settleGuestMerge(cartOwner);

  const failures: string[] = [];
  let moved = 0;

  for (const entry of targets) {
    const result = await addCartItem(cartOwner.owner, {
      productId: entry.productId,
      quantity: 1,
      selectedOptions: entry.selectedOptions,
    });

    if (isCartMutationError(result)) {
      failures.push(result.error);
      continue;
    }

    moved += 1;
    if (wantsMove) await removeWishlistItem(wishlistOwner.owner, { itemId: entry.itemId });
  }

  const [cart, refreshedWishlist] = await Promise.all([
    resolveCart(cartOwner.owner),
    resolveWishlist(wishlistOwner.owner),
  ]);

  const res = NextResponse.json(
    {
      moved,
      // Every distinct refusal, so a bulk move explains each item it could not
      // take rather than reporting a single opaque failure.
      failures: Array.from(new Set(failures)),
      cart: serializeCart(cart),
      wishlist: serializeWishlist(refreshedWishlist),
    },
    { status: moved === 0 ? 409 : 200 }
  );

  return attachWishlistCookie(attachGuestCookie(res, cartOwner), wishlistOwner);
}
