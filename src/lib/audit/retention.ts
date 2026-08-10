/**
 * Which events the audit log keeps.
 *
 * A rule, so it lives in a pure module and can be tested against the event
 * names the codebase actually uses rather than by matching source text.
 *
 * The filter exists to keep high-volume *user* activity — posts, edits, votes,
 * blocks — out of a table meant for staff and system actions. It is not a
 * security control; it is a volume control.
 *
 * It is also a trap worth naming: an event whose type matches no prefix is
 * dropped **silently**. That is why the canonical taxonomy added in the audit
 * pass is enumerated here alongside the legacy prefixes, and why
 * `tests/audit-log.test.ts` asserts that every event type appearing in the
 * source is retained. A correctly-named event that vanishes without a word is
 * the worst failure mode this module has.
 */

export const RETAINED_AUDIT_PREFIXES = [
  // Legacy families, live since the forum era.
  "admin.",
  "security.",
  "approvals.",
  "moderation.",
  // Staff commerce actions are audited whichever staff role performed them.
  // Without this prefix a non-admin staff member's category and pricing changes
  // were silently dropped instead of recorded.
  "staff.",
  /*
   * Named individually, not as a `forum.` prefix.
   *
   * A blanket `forum.` would retain post votes, edits and views — precisely the
   * high-volume member activity this filter exists to keep out, and enough of
   * it to make the audit log the largest table in the database. Only the two
   * destructive moderation actions are kept.
   */
  "forum.post_delete",
  "forum.thread_delete",
  "community.category_",
  "users.create",
  // Canonical taxonomy.
  "order.",
  // Support conversations. Named here for the reason the file's header warns
  // about: an event whose type matches no prefix is dropped **silently**, so a
  // correctly-named `support.staff_replied` would have vanished without a word.
  "support.",
  "production.",
  "fulfillment.",
  "inventory.",
  "product.",
  "category.",
  "discount.",
  "role.",
  "permission.",
  "settings.",
  "email.",
] as const;

/** Roles whose actions are retained regardless of the event's prefix. */
export const AUDIT_STAFF_ROLES: ReadonlySet<string> = new Set(["admin", "support", "moderator", "staff"]);

/**
 * True when this event should be written.
 *
 * Retained if either the actor is staff or the event names a retained family —
 * the first covers "a moderator did something", the second covers system and
 * provider events that have no staff actor at all.
 */
export function isRetainedAuditEvent(eventType: string, actorRole?: string | null): boolean {
  const type = (eventType ?? "").toLowerCase();
  const role = (actorRole ?? "").toLowerCase();
  if (AUDIT_STAFF_ROLES.has(role)) return true;
  return RETAINED_AUDIT_PREFIXES.some((prefix) => type.startsWith(prefix));
}
