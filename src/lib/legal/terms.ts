/**
 * The Terms a customer is agreeing to, and when.
 *
 * ## Versioning, without a schema change
 *
 * Phase 100 of this pass asks that a contractual acceptance be durably tied to
 * *which* Terms governed it, so that revising the Terms cannot silently rewrite
 * what somebody agreed to last month. Doing that needs three things: a version
 * identifier, a place to record it, and a server that refuses the contractual
 * action without one.
 *
 * The identifier is here. It is the published "Last updated" date of
 * `/terms`, which is the only version marker the documents have ever carried
 * and the one a customer can actually see. Changing the Terms means changing
 * that date and this constant together — `tests/legal-terms.test.ts` asserts
 * they match, so they cannot drift.
 *
 * The place to record it is `audit_logs`, which already carries actor, actor
 * IP, `related_order_id`, an `occurred_at` timestamp and a `metadata` jsonb —
 * exactly the tuple an acceptance record needs. Reusing it is why **this pass
 * needs no storefront schema change at all**. See `docs/storage-and-terms-audit
 * .md` for the rejected alternatives and for the migration that would be
 * required if a dedicated table is ever wanted.
 *
 * ## What is deliberately *not* recorded
 *
 * No browser fingerprint, no screen resolution, no canvas hash. Proving that a
 * particular account approved a particular quote at a particular time under a
 * named Terms version is the evidentiary question; collecting a device profile
 * to go with it would be gathering personal data for an argument nobody is
 * having.
 */

/**
 * The published version of the Terms of Service.
 *
 * Kept as the human date rather than a semver so it matches the words on the
 * page. Bumping this without changing `/terms` is a lie; changing `/terms`
 * without bumping this loses the association for every acceptance afterwards.
 */
export const TERMS_VERSION = "2026-08-01";

/** The published version of the Privacy Policy, tracked the same way. */
export const PRIVACY_VERSION = "2026-08-01";

/** The date as `/terms` and `/privacy` print it. */
export const TERMS_UPDATED_LABEL = "August 1, 2026";

/**
 * Where an acceptance came from.
 *
 * Recorded alongside the version, because "agreed at checkout" and "approved a
 * custom manufacturing quote" are different acts with different consequences,
 * and a single boolean cannot tell them apart later.
 */
export const ACCEPTANCE_CONTEXTS = ["quote_approval", "proposal_acceptance"] as const;
export type AcceptanceContext = (typeof ACCEPTANCE_CONTEXTS)[number];

export function isAcceptanceContext(value: unknown): value is AcceptanceContext {
  return typeof value === "string" && (ACCEPTANCE_CONTEXTS as readonly string[]).includes(value);
}

/**
 * Whether a submitted acceptance is usable.
 *
 * **Total**: any input at all yields a verdict, and only an exact match against
 * the currently published version passes. A stale client that still holds last
 * month's version is refused rather than quietly accepted, which is the whole
 * point of sending the version at all — otherwise the field is decoration and
 * the server is trusting a checkbox it cannot see.
 */
export type AcceptanceProblem = "missing" | "not_agreed" | "stale_version" | null;

export function acceptanceProblem(input: {
  agreed?: unknown;
  termsVersion?: unknown;
}): AcceptanceProblem {
  if (input.agreed !== true) return "not_agreed";
  if (typeof input.termsVersion !== "string" || !input.termsVersion.trim()) return "missing";
  return input.termsVersion.trim() === TERMS_VERSION ? null : "stale_version";
}

export function acceptanceProblemMessage(problem: Exclude<AcceptanceProblem, null>): string {
  switch (problem) {
    case "not_agreed":
      return "Tick the box to confirm you agree to the Terms of Service before approving.";
    case "missing":
      return "Your agreement could not be recorded. Reload the page and try again.";
    case "stale_version":
      return "The Terms of Service have been updated since this page loaded. Reload and review them before approving.";
  }
}

/** The audit event that records a contractual acceptance. */
export const TERMS_ACCEPTED_EVENT = "order.terms_accepted";
