import { NextRequest, NextResponse } from "next/server";
import { consumeRateLimit, rateLimitMessage, RATE_LIMITS } from "@/lib/commerce/rateLimit";
import {
  addWishlistItem,
  clearWishlist,
  isWishlistMutationError,
  removeWishlistItem,
  resolveWishlist,
  serializeWishlist,
} from "@/lib/commerce/wishlistService";
import {
  attachWishlistCookie,
  clearWishlistCookie,
  rateLimitIdentity,
  resolveWishlistOwner,
  resolveWishlistOwnerForWrite,
  settleWishlistMerge,
  type ResolvedWishlistOwner,
} from "@/lib/commerce/wishlistSession";

/**
 * The wishlist HTTP surface.
 *
 * Like the cart, every response is the whole re-resolved wishlist: the browser
 * renders what it is given and never holds an availability answer or a price
 * the server did not just compute.
 */

export const dynamic = "force-dynamic";

async function respondWithWishlist(resolved: ResolvedWishlistOwner, init?: { status?: number; error?: string }) {
  const merged = await settleWishlistMerge(resolved);
  const wishlist = await resolveWishlist(resolved.owner);

  const res = init?.error
    ? NextResponse.json({ error: init.error, wishlist: serializeWishlist(wishlist) }, { status: init.status ?? 400 })
    : NextResponse.json({ wishlist: serializeWishlist(wishlist) });

  // A merged guest list now belongs to the account; keeping the token would
  // leave a live handle on a list the customer no longer uses.
  return merged ? clearWishlistCookie(res) : attachWishlistCookie(res, resolved);
}

/** Reads never mint a guest cookie — only a real mutation does. */
export async function GET(req: NextRequest) {
  return respondWithWishlist(await resolveWishlistOwner(req));
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Nothing to save." }, { status: 400 });

  const resolved = await resolveWishlistOwnerForWrite(req);
  if (!resolved.owner) return NextResponse.json({ error: "Could not open a wishlist." }, { status: 500 });
  await settleWishlistMerge(resolved);

  const verdict = await consumeRateLimit(RATE_LIMITS.wishlistWrite, rateLimitIdentity(resolved));
  if (!verdict.allowed) {
    return respondWithWishlist(resolved, { error: rateLimitMessage(verdict), status: 429 });
  }

  const result = await addWishlistItem(resolved.owner, {
    productId: String(body.productId ?? ""),
    selectedOptions: body.selectedOptions,
  });

  return isWishlistMutationError(result)
    ? respondWithWishlist(resolved, { error: result.error, status: result.status })
    : respondWithWishlist(resolved);
}

export async function DELETE(req: NextRequest) {
  const resolved = await resolveWishlistOwner(req);
  if (!resolved.owner) return respondWithWishlist(resolved);
  await settleWishlistMerge(resolved);

  const itemId = req.nextUrl.searchParams.get("itemId");
  const productId = req.nextUrl.searchParams.get("productId");

  const result =
    itemId || productId
      ? await removeWishlistItem(resolved.owner, { itemId: itemId ?? undefined, productId: productId ?? undefined })
      : await clearWishlist(resolved.owner);

  return isWishlistMutationError(result)
    ? respondWithWishlist(resolved, { error: result.error, status: result.status })
    : respondWithWishlist(resolved);
}
