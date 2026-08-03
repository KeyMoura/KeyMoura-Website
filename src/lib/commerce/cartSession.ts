import "server-only";

import type { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/api/routeAuth";
import { createToken, GUEST_CART_COOKIE, mergeGuestCart, type CartOwner } from "@/lib/commerce/cartService";

/**
 * Who a cart belongs to on this request.
 *
 * A signed-in customer always wins: once someone authenticates, their account
 * cart is the only one that matters and a stale guest cookie must never
 * shadow it. Guests fall back to an opaque token in an httpOnly cookie.
 *
 * The guest token is a bearer credential for a cart, so it is httpOnly (no
 * script can read it), SameSite=Lax (not sent on cross-site POSTs), and — by
 * the migration's design — never usable as a direct database key: every cart
 * table denies anon and authenticated entirely and is reached only through
 * these server routes.
 */

const GUEST_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export type ResolvedOwner = {
  owner: CartOwner | null;
  customerId: string | null;
  /** Set when a brand new guest token was minted and must be written back. */
  issuedGuestToken: string | null;
  /**
   * A guest cart that still needs folding into this account.
   *
   * Merging lazily here — rather than inside each sign-in route — means every
   * entry path (password, OAuth, magic link) is covered by one rule, and a
   * sign-in that never round-trips through our callback still cannot strand a
   * guest cart.
   */
  pendingGuestMerge: string | null;
};

export function readGuestToken(req: NextRequest): string | null {
  const raw = req.cookies.get(GUEST_CART_COOKIE)?.value?.trim();
  if (!raw) return null;
  // Tokens are 32 random bytes in base64url. Anything else is a forged or
  // corrupted cookie and is ignored rather than used as a lookup key.
  return /^[A-Za-z0-9_-]{40,64}$/.test(raw) ? raw : null;
}

/** Resolves the current owner without creating anything. */
export async function resolveOwner(req: NextRequest): Promise<ResolvedOwner> {
  const guestToken = readGuestToken(req);
  const user = await getUserFromRequest(req);

  if (user) {
    return {
      owner: { customerId: user.id },
      customerId: user.id,
      issuedGuestToken: null,
      pendingGuestMerge: guestToken,
    };
  }

  return {
    owner: guestToken ? { guestToken } : null,
    customerId: null,
    issuedGuestToken: null,
    pendingGuestMerge: null,
  };
}

/**
 * Resolves the owner, minting a guest token when there is nothing to use yet.
 *
 * Only mutations call this: a plain read must never hand a cookie to a visitor
 * who is simply looking at the site.
 */
export async function resolveOwnerForWrite(req: NextRequest): Promise<ResolvedOwner> {
  const existing = await resolveOwner(req);
  if (existing.owner) return existing;

  const guestToken = createToken();
  return { owner: { guestToken }, customerId: null, issuedGuestToken: guestToken, pendingGuestMerge: null };
}

/**
 * Folds any pending guest cart into the signed-in account.
 *
 * Safe to call on every request: it is a no-op when there is no guest cookie
 * or no guest cart behind it, and the cookie is cleared afterwards so the
 * merge happens exactly once.
 */
export async function settleGuestMerge(resolved: ResolvedOwner): Promise<boolean> {
  if (!resolved.customerId || !resolved.pendingGuestMerge) return false;
  await mergeGuestCart(resolved.pendingGuestMerge, resolved.customerId);
  return true;
}

/** Writes a freshly minted guest token onto the response. */
export function attachGuestCookie(res: NextResponse, resolved: ResolvedOwner): NextResponse {
  if (!resolved.issuedGuestToken) return res;
  res.cookies.set(GUEST_CART_COOKIE, resolved.issuedGuestToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: GUEST_COOKIE_MAX_AGE,
  });
  return res;
}

/** Clears the guest cookie after its cart has been merged into an account. */
export function clearGuestCookie(res: NextResponse): NextResponse {
  res.cookies.set(GUEST_CART_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return res;
}
