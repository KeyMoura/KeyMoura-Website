import { NextRequest, NextResponse } from "next/server";
import { consumeRateLimit, rateLimitMessage, RATE_LIMITS } from "@/lib/commerce/rateLimit";
import {
  createWishlistShare,
  isWishlistMutationError,
  revokeWishlistShare,
} from "@/lib/commerce/wishlistService";
import {
  attachWishlistCookie,
  rateLimitIdentity,
  resolveWishlistOwner,
  resolveWishlistOwnerForWrite,
  settleWishlistMerge,
} from "@/lib/commerce/wishlistSession";

/**
 * Wishlist share links.
 *
 * Creating a share link is rate limited well below ordinary writes. A share
 * link is a durable public artifact with a strong token; minting them in a loop
 * is the abuse case this endpoint has to survive, and there is no legitimate
 * reason to create more than a handful in ten minutes.
 */

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const resolved = await resolveWishlistOwnerForWrite(req);
  if (!resolved.owner) return NextResponse.json({ error: "Could not open a wishlist." }, { status: 500 });
  await settleWishlistMerge(resolved);

  const verdict = await consumeRateLimit(RATE_LIMITS.wishlistShare, rateLimitIdentity(resolved));
  if (!verdict.allowed) {
    return NextResponse.json({ error: rateLimitMessage(verdict) }, { status: 429 });
  }

  const expiresInDays =
    body.expiresInDays === null || body.expiresInDays === undefined ? null : Number(body.expiresInDays);

  const result = await createWishlistShare(resolved.owner, {
    expiresInDays,
    rotate: body.rotate === true,
  });

  if (isWishlistMutationError(result)) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  const origin = req.nextUrl.origin;
  const res = NextResponse.json({
    share: {
      token: result.token,
      url: `${origin}/wishlist/shared/${result.token}`,
      expiresAt: result.expiresAt,
    },
  });
  return attachWishlistCookie(res, resolved);
}

export async function DELETE(req: NextRequest) {
  const resolved = await resolveWishlistOwner(req);
  if (!resolved.owner) return NextResponse.json({ ok: true });
  await settleWishlistMerge(resolved);

  const result = await revokeWishlistShare(resolved.owner);
  return isWishlistMutationError(result)
    ? NextResponse.json({ error: result.error }, { status: result.status })
    : NextResponse.json({ ok: true });
}
