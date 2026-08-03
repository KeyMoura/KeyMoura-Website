import { NextRequest, NextResponse } from "next/server";
import { consumeRateLimit, rateLimitMessage, RATE_LIMITS } from "@/lib/commerce/rateLimit";
import {
  addCartItem,
  clearCart,
  isCartMutationError,
  removeCartItem,
  resolveCart,
  serializeCart,
  setCartDiscountCode,
  updateCartItemQuantity,
} from "@/lib/commerce/cartService";
import {
  attachGuestCookie,
  clearGuestCookie,
  resolveOwner,
  resolveOwnerForWrite,
  settleGuestMerge,
  type ResolvedOwner,
} from "@/lib/commerce/cartSession";

/**
 * The cart HTTP surface.
 *
 * Every response is the *whole* re-resolved cart, priced from live product
 * rows. The browser never computes a total and never sends one: it sends what
 * changed and renders whatever comes back, so the drawer, the cart page, and
 * checkout can never disagree about money.
 */

export const dynamic = "force-dynamic";

/**
 * Sends back the whole re-resolved cart, settling a pending guest merge first.
 *
 * The merge runs before the read so a customer who just signed in sees their
 * guest items immediately rather than one request later.
 */
async function respondWithCart(resolved: ResolvedOwner, init?: { status?: number; error?: string }) {
  const merged = await settleGuestMerge(resolved);
  const cart = await resolveCart(resolved.owner);

  const res = init?.error
    ? NextResponse.json({ error: init.error }, { status: init.status ?? 400 })
    : NextResponse.json({ cart: serializeCart(cart) });

  // A merged guest cart is now owned by the account; keeping the token would
  // leave a live handle on a cart the customer no longer uses.
  return merged ? clearGuestCookie(res) : attachGuestCookie(res, resolved);
}

/** Reads never mint a guest cookie — only a real mutation does. */
export async function GET(req: NextRequest) {
  return respondWithCart(await resolveOwner(req));
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Nothing to add." }, { status: 400 });

  const resolved = await resolveOwnerForWrite(req);
  if (!resolved.owner) return NextResponse.json({ error: "Could not open a cart." }, { status: 500 });
  await settleGuestMerge(resolved);

  const result = await addCartItem(resolved.owner, {
    productId: String(body.productId ?? ""),
    quantity: body.quantity,
    selectedOptions: body.selectedOptions,
  });

  // A refusal still returns the cookie and the current cart: the visitor has a
  // cart record even though this line was rejected, and dropping the token
  // here would silently orphan whatever they add next.
  return isCartMutationError(result)
    ? respondWithCart(resolved, { error: result.error, status: result.status })
    : respondWithCart(resolved);
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });

  const resolved = await resolveOwnerForWrite(req);
  if (!resolved.owner) return NextResponse.json({ error: "Your cart is empty." }, { status: 404 });
  await settleGuestMerge(resolved);

  const isDiscountAttempt = typeof body.discountCode === "string" && body.discountCode.trim() !== "";

  // Submitting codes is how a discount list gets enumerated: the reply
  // distinguishes "not recognized" from "expired", which is exactly the oracle
  // a guessing loop needs. Clearing a code is not an attempt and is not counted.
  if (isDiscountAttempt) {
    const identity =
      "customerId" in resolved.owner ? `user:${resolved.owner.customerId}` : `guest:${resolved.owner.guestToken}`;
    const verdict = await consumeRateLimit(RATE_LIMITS.discountAttempt, identity);
    if (!verdict.allowed) {
      return respondWithCart(resolved, { error: rateLimitMessage(verdict), status: 429 });
    }
  }

  const result =
    typeof body.discountCode === "string" || body.discountCode === null
      ? await setCartDiscountCode(resolved.owner, body.discountCode)
      : typeof body.itemId === "string"
        ? await updateCartItemQuantity(resolved.owner, body.itemId, body.quantity)
        : ({ error: "Nothing to change.", status: 400 } as const);

  return isCartMutationError(result)
    ? respondWithCart(resolved, { error: result.error, status: result.status })
    : respondWithCart(resolved);
}

export async function DELETE(req: NextRequest) {
  const resolved = await resolveOwner(req);
  if (!resolved.owner) return respondWithCart(resolved);
  await settleGuestMerge(resolved);

  const itemId = req.nextUrl.searchParams.get("itemId");
  const result = itemId ? await removeCartItem(resolved.owner, itemId) : await clearCart(resolved.owner);

  return isCartMutationError(result)
    ? respondWithCart(resolved, { error: result.error, status: result.status })
    : respondWithCart(resolved);
}
