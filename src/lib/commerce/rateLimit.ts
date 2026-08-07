import "server-only";

import { createHash } from "node:crypto";
import { routeServiceClient } from "@/lib/api/routeAuth";

/**
 * Application-level rate limiting, backed by the database.
 *
 * A module-scope counter would be per-instance, so on serverless the effective
 * limit is whatever you configured multiplied by however many instances are
 * warm. The counter lives in Postgres and the check-and-record is atomic under
 * an advisory lock, so a burst from one caller is actually stopped.
 */

export type RateLimitRule = { bucket: string; limit: number; windowSeconds: number };

/**
 * The limits, in one place so they can be read and reasoned about together
 * rather than being scattered as magic numbers across routes.
 *
 * Share creation is deliberately tighter than ordinary writes: a share link is
 * a public, permanent artifact, and minting them in a loop is how you turn a
 * wishlist feature into an open redirect farm or a storage bill.
 */
export const RATE_LIMITS = {
  wishlistWrite: { bucket: "wishlist.write", limit: 60, windowSeconds: 60 },
  wishlistShare: { bucket: "wishlist.share", limit: 5, windowSeconds: 600 },
  wishlistCopy: { bucket: "wishlist.copy", limit: 20, windowSeconds: 600 },
  cartShare: { bucket: "cart.share", limit: 5, windowSeconds: 600 },
  cartShareCopy: { bucket: "cart.share.copy", limit: 20, windowSeconds: 600 },
  discountAttempt: { bucket: "discount.attempt", limit: 15, windowSeconds: 300 },
  // Lifecycle writes. Generous enough that a customer correcting a mistake is
  // never blocked, tight enough that a loop cannot fill the request tables or
  // the staff notification queue.
  orderCancel: { bucket: "order.cancel", limit: 10, windowSeconds: 300 },
  orderReturn: { bucket: "order.return", limit: 10, windowSeconds: 600 },
  /**
   * Guest surfaces, which a stranger reaches with no account at all.
   *
   * Tighter than the signed-in equivalents on purpose: an account is itself a
   * cost to create, and these three each end in something the shop pays for —
   * a row a staff member has to read, an email that leaves the building, or a
   * Stripe session. Generous enough that a customer who mistypes an address
   * twice and retries is never blocked.
   */
  guestRequest: { bucket: "guest.request", limit: 5, windowSeconds: 3600 },
  guestCheckout: { bucket: "guest.checkout", limit: 20, windowSeconds: 900 },
  guestMessage: { bucket: "guest.message", limit: 20, windowSeconds: 600 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Stable, non-reversible identity for the limiter.
 *
 * A guest token is a bearer credential for a cart and a user id is personal
 * data. Neither belongs in a table that every anonymous request writes to, so
 * only a salted digest is stored. The salt is a constant rather than a secret:
 * the goal is that a reader of this table cannot lift a working guest token out
 * of it, not that identities are unguessable to someone who already holds the
 * database.
 */
const SUBJECT_SALT = "keymoura.ratelimit.v1";

export function rateLimitSubject(identity: string): string {
  return createHash("sha256").update(`${SUBJECT_SALT}:${identity}`).digest("base64url").slice(0, 43);
}

export type RateLimitVerdict = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

/**
 * Records one attempt against a rule.
 *
 * Fails **open** on an infrastructure error. A limiter that cannot reach the
 * database must not take the whole feature down with it; the alternative is
 * that a transient Postgres blip logs every customer out of their own wishlist.
 * Anything the limiter genuinely has to gate on — authorization, ownership,
 * purchase mode — is enforced separately and does not depend on this call.
 */
export async function consumeRateLimit(rule: RateLimitRule, identity: string): Promise<RateLimitVerdict> {
  if (!identity) return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0 };

  const { data, error } = await routeServiceClient.rpc("consume_rate_limit", {
    p_bucket: rule.bucket,
    p_subject: rateLimitSubject(identity),
    p_limit: rule.limit,
    p_window_seconds: rule.windowSeconds,
  });

  if (error || !data) return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0 };

  const result = data as { allowed?: boolean; remaining?: number; retry_after_seconds?: number };
  return {
    allowed: result.allowed !== false,
    remaining: Number(result.remaining ?? 0),
    retryAfterSeconds: Number(result.retry_after_seconds ?? 0),
  };
}

/** The standard refusal, with a Retry-After the browser and a human can both use. */
export function rateLimitMessage(verdict: RateLimitVerdict): string {
  const minutes = Math.ceil(verdict.retryAfterSeconds / 60);
  if (verdict.retryAfterSeconds <= 90) return "That was a bit quick. Try again in a moment.";
  return `That was a bit quick. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}
