import "server-only";

import type { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/api/routeAuth";
import { createToken, GUEST_WISHLIST_COOKIE } from "@/lib/commerce/cartService";
import { mergeGuestWishlist, type WishlistOwner } from "@/lib/commerce/wishlistService";

/**
 * Who a wishlist belongs to on this request.
 *
 * Mirrors the cart's ownership rules exactly — a signed-in customer always
 * wins, guests fall back to an opaque httpOnly token, and the guest list is
 * folded into the account lazily on the first authenticated request rather than
 * inside each sign-in route. Keeping the two modules parallel is deliberate: a
 * divergence between how carts and wishlists decide ownership is precisely the
 * kind of thing that becomes a cross-account leak.
 *
 * The wishlist uses its own cookie rather than reusing the cart token so that
 * clearing one never silently discards the other.
 */

const GUEST_COOKIE_MAX_AGE = 60 * 60 * 24 * 90;

export type ResolvedWishlistOwner = {
  owner: WishlistOwner | null;
  customerId: string | null;
  issuedGuestToken: string | null;
  pendingGuestMerge: string | null;
};

export function readWishlistGuestToken(req: NextRequest): string | null {
  const raw = req.cookies.get(GUEST_WISHLIST_COOKIE)?.value?.trim();
  if (!raw) return null;
  // 32 random bytes in base64url. Anything else is forged or corrupted and is
  // ignored rather than used as a lookup key.
  return /^[A-Za-z0-9_-]{40,64}$/.test(raw) ? raw : null;
}

export async function resolveWishlistOwner(req: NextRequest): Promise<ResolvedWishlistOwner> {
  const guestToken = readWishlistGuestToken(req);
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
 * Only mutations call this: browsing must not hand a cookie to a visitor.
 */
export async function resolveWishlistOwnerForWrite(req: NextRequest): Promise<ResolvedWishlistOwner> {
  const existing = await resolveWishlistOwner(req);
  if (existing.owner) return existing;

  const guestToken = createToken();
  return { owner: { guestToken }, customerId: null, issuedGuestToken: guestToken, pendingGuestMerge: null };
}

/** No-op unless a signed-in request arrived carrying a guest wishlist cookie. */
export async function settleWishlistMerge(resolved: ResolvedWishlistOwner): Promise<boolean> {
  if (!resolved.customerId || !resolved.pendingGuestMerge) return false;
  await mergeGuestWishlist(resolved.pendingGuestMerge, resolved.customerId);
  return true;
}

export function attachWishlistCookie(res: NextResponse, resolved: ResolvedWishlistOwner): NextResponse {
  if (!resolved.issuedGuestToken) return res;
  res.cookies.set(GUEST_WISHLIST_COOKIE, resolved.issuedGuestToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: GUEST_COOKIE_MAX_AGE,
  });
  return res;
}

/** Clears the guest cookie after its list has been merged into an account. */
export function clearWishlistCookie(res: NextResponse): NextResponse {
  res.cookies.set(GUEST_WISHLIST_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return res;
}

/** The identity the rate limiter counts against for this request. */
export function rateLimitIdentity(resolved: ResolvedWishlistOwner): string {
  if (resolved.customerId) return `user:${resolved.customerId}`;
  if (resolved.owner && "guestToken" in resolved.owner) return `guest:${resolved.owner.guestToken}`;
  return "";
}
