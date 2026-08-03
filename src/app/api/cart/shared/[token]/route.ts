import { NextRequest, NextResponse } from "next/server";
import { addCartItem, isCartMutationError, resolveCart, serializeCart } from "@/lib/commerce/cartService";
import { attachGuestCookie, resolveOwnerForWrite, settleGuestMerge } from "@/lib/commerce/cartSession";
import { consumeRateLimit, rateLimitMessage, RATE_LIMITS } from "@/lib/commerce/rateLimit";
import { loadSharedCart } from "@/lib/commerce/sharedCartService";
import type { CartOwner } from "@/lib/commerce/cartService";

/**
 * Copying a shared cart into the viewer's own cart.
 *
 * The token is a read capability on a snapshot. It is never an authorization to
 * act as the owner: the viewer's cart is resolved from their own cookies, and
 * every line goes back through `addCartItem`, which re-checks purchase mode,
 * publication, stock, options, and price against live product rows.
 *
 * The snapshot's recorded prices are not consulted here at all. They exist only
 * so the page can show what changed.
 */

export const dynamic = "force-dynamic";

const identityOf = (owner: CartOwner): string =>
  "customerId" in owner ? `user:${owner.customerId}` : `guest:${owner.guestToken}`;

export async function GET(_req: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const shared = await loadSharedCart(token);
  if (!shared) return NextResponse.json({ error: "This cart link is not available." }, { status: 404 });
  return NextResponse.json({ shared });
}

export async function POST(req: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const productId = typeof body.productId === "string" ? body.productId : null;

  const shared = await loadSharedCart(token);
  if (!shared) return NextResponse.json({ error: "This cart link is not available." }, { status: 404 });

  // Only lines actually on the snapshot may be copied. Without this the
  // endpoint would be a general "add anything to my cart" route that merely
  // happens to require a valid token.
  const targets = productId
    ? shared.lines.filter((line) => line.productId === productId && line.cartEligible)
    : shared.lines.filter((line) => line.cartEligible);

  if (!targets.length) {
    return NextResponse.json({ error: "Nothing on this list can be added to a cart right now." }, { status: 404 });
  }

  const owner = await resolveOwnerForWrite(req);
  if (!owner.owner) return NextResponse.json({ error: "Could not open a cart." }, { status: 500 });
  await settleGuestMerge(owner);

  const verdict = await consumeRateLimit(RATE_LIMITS.cartShareCopy, identityOf(owner.owner));
  if (!verdict.allowed) return NextResponse.json({ error: rateLimitMessage(verdict) }, { status: 429 });

  const failures: string[] = [];
  let copied = 0;

  for (const line of targets) {
    const result = await addCartItem(owner.owner, {
      productId: line.productId,
      quantity: line.quantity,
      selectedOptions: line.selectedOptions,
    });
    if (isCartMutationError(result)) failures.push(result.error);
    else copied += 1;
  }

  const cart = await resolveCart(owner.owner);
  const res = NextResponse.json(
    { copied, failures: Array.from(new Set(failures)), cart: serializeCart(cart) },
    { status: copied === 0 ? 409 : 200 }
  );
  return attachGuestCookie(res, owner);
}
