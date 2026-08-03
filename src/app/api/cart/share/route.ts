import { NextRequest, NextResponse } from "next/server";
import { attachGuestCookie, resolveOwner, resolveOwnerForWrite, settleGuestMerge } from "@/lib/commerce/cartSession";
import { consumeRateLimit, rateLimitMessage, RATE_LIMITS } from "@/lib/commerce/rateLimit";
import {
  createCartShare,
  isSharedCartError,
  listCartShares,
  revokeCartShare,
} from "@/lib/commerce/sharedCartService";
import type { CartOwner } from "@/lib/commerce/cartService";

/**
 * Cart share links.
 *
 * Creating one is rate limited well below ordinary cart writes: a share link is
 * a durable public artifact carrying a snapshot, and minting them in a loop is
 * the abuse case this endpoint exists to survive.
 */

export const dynamic = "force-dynamic";

const identityOf = (owner: CartOwner): string =>
  "customerId" in owner ? `user:${owner.customerId}` : `guest:${owner.guestToken}`;

/** Lists this caller's own share links so they can see and revoke them. */
export async function GET(req: NextRequest) {
  const resolved = await resolveOwner(req);
  if (!resolved.owner) return NextResponse.json({ shares: [] });
  await settleGuestMerge(resolved);

  return NextResponse.json({ shares: await listCartShares(resolved.owner) });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const resolved = await resolveOwnerForWrite(req);
  if (!resolved.owner) return NextResponse.json({ error: "Your cart is empty." }, { status: 404 });
  await settleGuestMerge(resolved);

  const verdict = await consumeRateLimit(RATE_LIMITS.cartShare, identityOf(resolved.owner));
  if (!verdict.allowed) return NextResponse.json({ error: rateLimitMessage(verdict) }, { status: 429 });

  const result = await createCartShare(resolved.owner, {
    expiresInDays: body.expiresInDays,
    note: body.note,
  });

  if (isSharedCartError(result)) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  const res = NextResponse.json({
    share: {
      token: result.token,
      url: `${req.nextUrl.origin}/cart/shared/${result.token}`,
      expiresAt: result.expiresAt,
    },
    shares: await listCartShares(resolved.owner),
  });
  return attachGuestCookie(res, resolved);
}

export async function DELETE(req: NextRequest) {
  const resolved = await resolveOwner(req);
  if (!resolved.owner) return NextResponse.json({ error: "Nothing to revoke." }, { status: 404 });
  await settleGuestMerge(resolved);

  const token = req.nextUrl.searchParams.get("token");
  const result = await revokeCartShare(resolved.owner, token);

  return isSharedCartError(result)
    ? NextResponse.json({ error: result.error }, { status: result.status })
    : NextResponse.json({ ok: true, shares: await listCartShares(resolved.owner) });
}
