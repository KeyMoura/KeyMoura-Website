import "server-only";

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { routeServiceClient } from "@/lib/api/routeAuth";
import { createGuestOrderToken, guestAccessExpiry, hashGuestOrderToken } from "@/lib/commerce/guestOrders";
import { GUEST_CODE_LENGTH, GUEST_CODE_TTL_MINUTES } from "@/lib/commerce/guestAccessWindow";

/**
 * The six-digit email challenge that opens a guest order on a new device.
 *
 * ## What the code is, and what it is not
 *
 * It is a **second factor for a mailbox**, not a password. It is six digits
 * because a customer has to read it off a phone and type it, and every property
 * that makes six digits survivable is enforced somewhere it cannot be skipped:
 *
 * - Minted with `randomInt`, which is CSPRNG-backed and rejection-samples, so
 *   the distribution is uniform. `Math.random()` here would be guessable and
 *   `% 1000000` on raw bytes would be biased.
 * - Stored only as an **HMAC-SHA-256 digest**. A database dump, a log, or a
 *   support screen yields nothing replayable. The message is domain-separated
 *   and bound to the order id, so a digest lifted from order A cannot be
 *   replayed against order B even if the same six digits were issued for both.
 * - Keyed by a secret that is *not* the Supabase, Stripe, Resend or JWT secret.
 *   One compromised integration key must not become the ability to mint order
 *   access codes.
 * - 15-minute life, 5 attempts, 60-second resend cooldown, one active challenge
 *   per order, single use. The first three bound guessing to a rate no attacker
 *   profits from; the last two are enforced by the database, not here, so two
 *   concurrent requests cannot both win.
 *
 * ## Why the limits live in SQL
 *
 * `replace_guest_order_access_code` takes a row lock on the order before it
 * looks at the cooldown, and a partial unique index permits exactly one
 * unconsumed row per order. Expiry, the attempt ceiling and consumption are
 * re-checked inside `consume_guest_order_access_code` in the same statement
 * that consumes the row. Checking any of that in TypeScript and then acting on
 * it would be a read followed by a write with a gap in between — which is the
 * shape of every double-spend bug. The checks below are the fast path and the
 * useful error message; the database is the authority.
 */

export const GUEST_CODE_TTL_SECONDS = GUEST_CODE_TTL_MINUTES * 60;
export const GUEST_CODE_RESEND_SECONDS = 60;
export const GUEST_CODE_MAX_ATTEMPTS = 5;
export { GUEST_CODE_LENGTH };

/**
 * The HMAC key, or null when it is not configured.
 *
 * Returning null rather than throwing is the whole of the fix for the defect
 * this feature shipped with the first time. `digestGuestVerificationCode` used
 * to throw when the variable was missing, and nothing caught it: a deployment
 * without the secret answered a routine page load with an uncaught exception
 * and an HTTP 500. That is the worst of both outcomes — it fails *open* in the
 * sense that it tells an anonymous caller the server is misconfigured, and it
 * fails *closed* in the sense that the guest is stuck at a stack trace.
 *
 * Now the absence is a first-class, checkable state. Every entry point tests it
 * before it touches the database, returns `not_configured`, and the route turns
 * that into a calm "temporarily unavailable" with no mention of environment
 * variables. The order is never exposed as a consolation.
 */
function verificationKey(): string | null {
  const key = process.env.GUEST_ORDER_VERIFICATION_SECRET;
  return key && key.length > 0 ? key : null;
}

/** Whether guest verification can run at all. Cheap, and safe to call anywhere. */
export function guestVerificationConfigured(): boolean {
  return verificationKey() !== null;
}

/**
 * One server-side line when the secret is missing, and nothing more.
 *
 * Named so an operator reading logs knows exactly which variable to set. It
 * never prints a value, never prints a code, and is not reachable from the
 * response body — the customer is told only that verification is briefly
 * unavailable.
 */
function reportMisconfiguration(where: string): void {
  console.error(
    `[guest-order-verification] GUEST_ORDER_VERIFICATION_SECRET is not configured; ${where} cannot run.`
  );
}

/** Six uniform digits from a CSPRNG, zero-padded so "000042" stays six long. */
export function createGuestVerificationCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(GUEST_CODE_LENGTH, "0");
}

/**
 * The digest stored for a code.
 *
 * Throws only when called without a configured secret, which every caller in
 * this module rules out first via `guestVerificationConfigured()`. It stays a
 * throw rather than returning null so that a *future* caller that forgets the
 * check fails loudly in tests instead of silently writing a digest of "".
 */
export function digestGuestVerificationCode(orderId: string, code: string): string {
  const key = verificationKey();
  if (!key) throw new Error("Guest order verification is not configured");
  return createHmac("sha256", key)
    .update(`keymoura.guest-order-code.v1:${orderId}:${code}`)
    .digest("base64url");
}

/** Constant-time digest comparison, so a wrong code leaks nothing by timing. */
export function verificationDigestMatches(orderId: string, code: string, stored: string): boolean {
  const actual = Buffer.from(digestGuestVerificationCode(orderId, code));
  const expected = Buffer.from(stored);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * `ethan@keymoura.com` → `e••••@keymoura.com`.
 *
 * Enough for a customer to recognise which of their addresses to open, and not
 * enough to be worth harvesting. The local part is never revealed beyond its
 * first character, and the number of dots is clamped so the mask does not
 * disclose the real length.
 */
export function maskGuestEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••••";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 1)}${"•".repeat(Math.max(4, Math.min(local.length - 1, 8)))}@${domain}`;
}

type ChallengeRow = {
  id: string;
  code_digest: string;
  expires_at: string;
  consumed_at: string | null;
  failed_attempts: number;
  created_at: string;
};

/** The most recent challenge for an order, whatever state it is in. */
async function latestChallenge(orderId: string): Promise<ChallengeRow | null> {
  const found = await routeServiceClient
    .from("guest_order_access_codes")
    .select("id,code_digest,expires_at,consumed_at,failed_attempts,created_at")
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return found.error ? null : ((found.data as ChallengeRow | null) ?? null);
}

/** A challenge the guest can still type a code into. */
function stillUsable(row: ChallengeRow | null, now = Date.now()): boolean {
  if (!row) return false;
  return (
    row.consumed_at === null &&
    row.failed_attempts < GUEST_CODE_MAX_ATTEMPTS &&
    Date.parse(row.expires_at) > now
  );
}

/**
 * The order a challenge may be issued for, or why it may not.
 *
 * Both conditions matter. `customer_id is null` keeps this away from an order
 * that belongs to an account — those are reached by signing in, and a code sent
 * to an address that merely *matches* an account's would be an alternate login.
 * `guest_email is not null` is simply the address the code has to go to.
 */
async function eligibleGuestOrder(orderId: string): Promise<{ guestEmail: string } | null> {
  const result = await routeServiceClient
    .from("orders")
    .select("customer_id,guest_email")
    .eq("id", orderId)
    .maybeSingle();
  const order = result.data as { customer_id: string | null; guest_email: string | null } | null;
  if (result.error || !order || order.customer_id || !order.guest_email) return null;
  return { guestEmail: order.guest_email };
}

export type IssueResult =
  | { ok: true; sent: true; code: string; challengeId: string; email: string; maskedEmail: string }
  /** A usable challenge already exists — say where it went, send nothing. */
  | { ok: true; sent: false; maskedEmail: string }
  | { ok: false; reason: "cooldown" | "not_configured" | "unavailable" };

/**
 * Make sure a usable challenge exists, **without emailing if one already does**.
 *
 * This is the anti-spam rule, and it is here rather than in the component
 * because a client-side guard is a suggestion. Opening or refreshing the guest
 * order page calls this; a guest who reloads five times while their code is
 * still valid gets one email, not five. The 60-second cooldown alone did not
 * achieve that — it only rate-limits, so a refresh every 61 seconds for fifteen
 * minutes would have delivered fourteen codes.
 *
 * The check-then-insert race is benign: the insert is serialised by the row
 * lock `replace_guest_order_access_code` takes on the order, and the loser of
 * the race hits the cooldown and sends nothing.
 */
export async function ensureGuestCode(orderId: string): Promise<IssueResult> {
  if (!guestVerificationConfigured()) {
    reportMisconfiguration("issuing a guest order code");
    return { ok: false, reason: "not_configured" };
  }

  const order = await eligibleGuestOrder(orderId);
  if (!order) return { ok: false, reason: "unavailable" };

  if (stillUsable(await latestChallenge(orderId))) {
    return { ok: true, sent: false, maskedEmail: maskGuestEmail(order.guestEmail) };
  }
  return issueGuestCode(orderId);
}

/**
 * Mint a new challenge, replacing any previous one.
 *
 * Reached by an explicit "send a new code", and by `ensureGuestCode` when there
 * is nothing usable to reuse. Replacement is what invalidates the old code:
 * the RPC consumes the previous unconsumed row in the same transaction that
 * inserts the new one, so there is never a moment when two codes both work.
 */
export async function issueGuestCode(orderId: string): Promise<IssueResult> {
  if (!guestVerificationConfigured()) {
    reportMisconfiguration("issuing a guest order code");
    return { ok: false, reason: "not_configured" };
  }

  const order = await eligibleGuestOrder(orderId);
  if (!order) return { ok: false, reason: "unavailable" };

  const code = createGuestVerificationCode();
  const result = await routeServiceClient.rpc("replace_guest_order_access_code", {
    p_order_id: orderId,
    p_code_digest: digestGuestVerificationCode(orderId, code),
    p_expires_at: new Date(Date.now() + GUEST_CODE_TTL_SECONDS * 1000).toISOString(),
    p_cooldown_seconds: GUEST_CODE_RESEND_SECONDS,
  });

  if (result.error) {
    return { ok: false, reason: result.error.code === "P0001" ? "cooldown" : "unavailable" };
  }

  return {
    ok: true,
    sent: true,
    code,
    challengeId: String(result.data),
    email: order.guestEmail,
    maskedEmail: maskGuestEmail(order.guestEmail),
  };
}

export type VerificationResult =
  | { ok: true; token: string }
  | { ok: false; reason: "invalid" | "expired" | "consumed" | "attempt_limit" | "not_configured" | "unavailable" };

/**
 * Check a typed code and, if it is right, mint the guest session.
 *
 * The order of the checks is deliberate. Shape first, so a non-numeric string
 * never reaches the HMAC. Then consumed / attempt-limit / expiry, each of which
 * is a *distinct* message the customer can act on — "send a new code" is useless
 * advice if we only ever say "invalid". Only then the digest comparison, and a
 * failure there increments the counter through the database rather than here,
 * so five parallel wrong guesses cost five attempts rather than one.
 *
 * On success the raw session token is returned for the caller to put in an
 * httpOnly cookie. It is deliberately *returned* rather than logged or included
 * in any response body — only `Set-Cookie` ever carries it.
 */
export async function verifyGuestCode(orderId: string, code: string): Promise<VerificationResult> {
  if (!guestVerificationConfigured()) {
    reportMisconfiguration("verifying a guest order code");
    return { ok: false, reason: "not_configured" };
  }

  if (!new RegExp(`^\\d{${GUEST_CODE_LENGTH}}$`).test(code)) return { ok: false, reason: "invalid" };

  const row = await latestChallenge(orderId);
  if (!row) return { ok: false, reason: "invalid" };
  if (row.consumed_at) return { ok: false, reason: "consumed" };
  if (row.failed_attempts >= GUEST_CODE_MAX_ATTEMPTS) return { ok: false, reason: "attempt_limit" };
  if (Date.parse(row.expires_at) <= Date.now()) return { ok: false, reason: "expired" };

  if (!verificationDigestMatches(orderId, code, row.code_digest)) {
    await routeServiceClient.rpc("record_guest_order_code_failure", {
      p_code_id: row.id,
      p_max_attempts: GUEST_CODE_MAX_ATTEMPTS,
    });
    return { ok: false, reason: "invalid" };
  }

  const token = createGuestOrderToken();
  const consumed = await routeServiceClient.rpc("consume_guest_order_access_code", {
    p_code_id: row.id,
    p_order_id: orderId,
    p_session_digest: hashGuestOrderToken(token),
    p_session_expires_at: guestAccessExpiry(),
  });

  // The RPC re-checks everything above inside the consuming statement. A false
  // here means another request consumed the row first — the code was right, but
  // it is spent, and saying so is honest.
  if (consumed.error || consumed.data !== true) return { ok: false, reason: "consumed" };
  return { ok: true, token };
}
