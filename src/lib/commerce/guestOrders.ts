/**
 * Guest identity for orders and custom requests.
 *
 * Pure and dependency-free apart from `node:crypto`, so the validation rules
 * are testable directly rather than only through a route.
 *
 * ## The credential
 *
 * A guest who checks out gets an opaque token in an **httpOnly** cookie. Only
 * a salted digest of it is stored on the order, so a database read — a dump, a
 * log, a support screen — never yields something that can be replayed.
 *
 * The raw token is never put in a URL. A URL lands in browser history, in a
 * `Referer` header on the next outbound link, and in whatever the customer
 * pastes into a chat window when they ask for help. A cookie does none of
 * that, and the only place a guest needs the credential is the browser that
 * just checked out.
 *
 * The cost is stated rather than hidden: the credential is per-browser, so a
 * guest who checks out on a phone cannot open the order on a laptop. Their
 * confirmation email carries the order number and the details; a cross-device
 * lookup by order number and email is a separate piece of work and is recorded
 * as not built.
 *
 * The salt differs from the rate limiter's and the shared-cart owner hash's,
 * so no two of those tables' digests can be joined against each other.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const GUEST_ORDER_COOKIE = "km_guest_order";

/** Long enough that a guest who came back a month later still gets their order. */
export const GUEST_ORDER_COOKIE_MAX_AGE = 60 * 60 * 24 * 90;

const GUEST_SALT = "keymoura.guestorder.v1";

/** 32 random bytes, base64url — the same shape as the guest cart token. */
export function createGuestOrderToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A token from a cookie, or null.
 *
 * Anything that is not the exact shape this module mints is a forged or
 * corrupted cookie and is dropped rather than used as a lookup key.
 */
export function normalizeGuestOrderToken(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  return /^[A-Za-z0-9_-]{40,64}$/.test(value) ? value : null;
}

export function hashGuestOrderToken(token: string): string {
  return createHash("sha256").update(`${GUEST_SALT}:${token}`).digest("base64url").slice(0, 43);
}

/**
 * Constant-time comparison of two digests.
 *
 * The lookup itself is by indexed equality, so this is belt and braces — but a
 * `===` on a secret-derived value is the kind of thing that gets copied into a
 * place where the timing does matter.
 */
export function guestTokenMatches(token: string | null, storedHash: string | null | undefined): boolean {
  if (!token || !storedHash) return false;
  const computed = Buffer.from(hashGuestOrderToken(token));
  const stored = Buffer.from(storedHash);
  return computed.length === stored.length && timingSafeEqual(computed, stored);
}

/** How long a guest may reach their order for. Matches the cookie's life. */
export const GUEST_ACCESS_WINDOW_DAYS = 90;

export function guestAccessExpiry(from: Date = new Date()): string {
  return new Date(from.getTime() + GUEST_ACCESS_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export type GuestAccessRow = {
  guest_token_hash: string | null;
  guest_access_expires_at: string | null;
};

export type GuestAccessResult = "granted" | "no_token" | "revoked" | "expired" | "mismatch";

/**
 * Whether a token opens this order, and if not, why.
 *
 * Three independent conditions, each of which alone denies access:
 *
 * - **Revoked.** A null hash is not "no rule", it is "there is nothing to
 *   match" — clearing the hash is how revocation works, following the rule
 *   pass 3 set for share links.
 * - **Expired.** A null or past expiry denies. Treating a missing expiry as
 *   "forever" would make a row that lost the column the most permissive one in
 *   the table; failing closed is the only safe direction here.
 * - **Mismatch.** Compared in constant time.
 *
 * The reason is returned so the page can say "that link has expired" rather
 * than "not found" — but it is deliberately *not* said before the token
 * matches: telling an unauthenticated caller that an order exists and its link
 * merely expired is an existence oracle over order ids.
 */
export function evaluateGuestAccess(
  token: string | null,
  row: GuestAccessRow | null,
  now: Date = new Date()
): GuestAccessResult {
  if (!token) return "no_token";
  if (!row) return "mismatch";
  if (!row.guest_token_hash) return "revoked";
  if (!guestTokenMatches(token, row.guest_token_hash)) return "mismatch";
  const expiry = row.guest_access_expires_at ? Date.parse(row.guest_access_expires_at) : NaN;
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) return "expired";
  return "granted";
}

// ---------------------------------------------------------------------------
// Contact details
// ---------------------------------------------------------------------------

export const GUEST_EMAIL_MAX = 254;
export const GUEST_NAME_MAX = 120;

export type GuestContact = { email: string; name: string | null };

export type GuestContactProblem =
  | { ok: true; contact: GuestContact }
  | { ok: false; field: "email" | "name"; message: string };

/**
 * The address a guest's order confirmation goes to.
 *
 * Deliberately a *shape* check and not an attempt at RFC 5322: a regex that
 * tries to be authoritative rejects real addresses, and the only thing that
 * can actually confirm an address is a message arriving at it. What this has
 * to stop is a value that is not an address at all reaching a mail send —
 * including one carrying CR or LF, which is how a header is injected into a
 * message somebody else receives.
 */
export function parseGuestContact(input: {
  email?: unknown;
  name?: unknown;
}): GuestContactProblem {
  const rawEmail = typeof input.email === "string" ? input.email.trim() : "";
  if (!rawEmail) {
    return { ok: false, field: "email", message: "Enter an email address so we can send your receipt." };
  }
  if (rawEmail.length > GUEST_EMAIL_MAX) {
    return { ok: false, field: "email", message: "That email address is too long." };
  }
  if (/[\r\n\t]/.test(rawEmail) || /\s/.test(rawEmail)) {
    return { ok: false, field: "email", message: "That does not look like an email address." };
  }
  // Exactly one @, something before it, and a dotted domain after it.
  if (!/^[^@]+@[^@\s]+\.[^@\s]+$/.test(rawEmail)) {
    return { ok: false, field: "email", message: "That does not look like an email address." };
  }

  const rawName = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  if (rawName.length > GUEST_NAME_MAX) {
    return { ok: false, field: "name", message: "That name is too long." };
  }

  return {
    ok: true,
    // Lower-cased, because it is used as a lookup key and "A@b.com" and
    // "a@b.com" are the same mailbox everywhere it matters.
    contact: { email: rawEmail.toLowerCase(), name: rawName || null },
  };
}

/**
 * The name to greet a guest by in an email.
 *
 * Falls back to the local part of the address rather than to "Customer" when
 * there is one, matching what the account path does with a display name.
 */
export function guestDisplayName(contact: { email: string; name?: string | null }): string {
  return contact.name?.trim() || contact.email.split("@")[0] || "Customer";
}
