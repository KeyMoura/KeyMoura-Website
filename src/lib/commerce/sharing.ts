/**
 * The rules that govern every share link on the site.
 *
 * Wishlist shares and cart shares are different features with different
 * payloads, but they are the same *capability*: an unguessable token that
 * grants a read on a set of products and nothing else. Keeping the token shape,
 * the expiry window, and the validity check in one pure module means the two
 * cannot drift into having different security properties — which is exactly how
 * one of them would quietly become the weak one.
 *
 * Pure and dependency-free so the rules can be tested directly.
 */

/**
 * 32 bytes of CSPRNG output rendered as base64url is 43 characters. The range
 * is deliberately wider than that so a token minted by a different encoding
 * still validates, while anything short enough to be brute-forced does not.
 */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;

export function isValidShareToken(token: unknown): token is string {
  return typeof token === "string" && SHARE_TOKEN_PATTERN.test(token.trim());
}

/** Longest a share link may live. Anything longer is effectively permanent. */
export const MAX_SHARE_DAYS = 90;

/**
 * Normalizes a requested lifetime.
 *
 * Returns null for "no expiry", which is a legitimate choice — a wishlist sent
 * to a family member should not silently die. Out-of-range and non-numeric
 * input is clamped rather than rejected so a malformed request produces a safe
 * link instead of an error.
 */
export function clampShareDays(days: unknown): number | null {
  if (days == null || days === "") return null;
  const parsed = typeof days === "number" ? days : Number.parseInt(String(days), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_SHARE_DAYS);
}

/** The absolute expiry for a requested lifetime, or null when there is none. */
export function shareExpiryFrom(days: unknown, now: number = Date.now()): string | null {
  const clamped = clampShareDays(days);
  return clamped == null ? null : new Date(now + clamped * 86_400_000).toISOString();
}

/**
 * Whether a share has lapsed.
 *
 * An unparseable timestamp counts as expired. A share link is a privilege, and
 * the safe reading of a value we cannot understand is "no longer valid" rather
 * than "valid forever".
 */
export function shareExpired(expiresAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!expiresAt) return false;
  const at = new Date(expiresAt).getTime();
  if (!Number.isFinite(at)) return true;
  return at <= now;
}

/**
 * Whether a stored share row may still be read by a link holder.
 *
 * Revocation, the public flag, and expiry are checked together so no caller can
 * accidentally honour one and forget another.
 */
export function shareIsLive(
  share: { is_public?: boolean | null; revoked_at?: string | null; expires_at?: string | null },
  now: number = Date.now()
): boolean {
  if (share.is_public === false) return false;
  if (share.revoked_at) return false;
  return !shareExpired(share.expires_at, now);
}
