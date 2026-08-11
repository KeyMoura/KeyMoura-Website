/**
 * Who may change whose access, and to what.
 *
 * Pure and dependency-free, deliberately. These are the rules that stop a
 * support account making itself an admin, and a rule that can only be exercised
 * by standing up Postgres and a session is a rule that gets tested once. Every
 * decision here is a function of values the caller already has, so the API route
 * and the tests evaluate the *same* function rather than two readings of the
 * same paragraph.
 *
 * The route is still the enforcement point — this module decides, it does not
 * guard. Nothing here is reachable from a browser, and no UI check substitutes
 * for the server calling these before it writes.
 *
 * ## The hierarchy
 *
 * `roles.rank` is the existing column and this uses it rather than inventing a
 * second ordering. Live values: admin 100, moderator 60, support 40, member 10,
 * maker 0. Higher is stronger.
 *
 * Two separate rules fall out of it, and both are needed:
 *
 *  * **You cannot reach above yourself.** Acting on a target whose role is at or
 *    above your own is refused — otherwise a moderator demotes an admin.
 *  * **You cannot grant above yourself.** Assigning a role at or above your own
 *    rank is refused — otherwise a moderator promotes a sock puppet to admin and
 *    reaches everything indirectly.
 *
 * Leaving either one out leaves the escalation open, which is why they are two
 * checks and not one.
 */

export type AccessActor = {
  userId: string;
  roleKey: string;
  roleRank: number;
  /** The site owner flag. Bypasses rank, never the last-admin rule. */
  isOp: boolean;
  permissions: ReadonlySet<string>;
};

export type AccessTarget = {
  userId: string;
  roleKey: string;
  roleRank: number;
};

export type AccessDecision = { allowed: true } | { allowed: false; reason: string; status: number };

const ALLOW: AccessDecision = { allowed: true };

function deny(reason: string, status: number): AccessDecision {
  return { allowed: false, reason, status };
}

/**
 * The roles a given actor is permitted to hand out.
 *
 * The UI uses this to build its dropdown and the route uses it to check the
 * submission, so an option that appears is an option that works, and an option
 * that does not appear is refused if somebody posts it anyway.
 */
export function assignableRoles<T extends { key: string; rank: number }>(
  actor: Pick<AccessActor, "roleRank" | "isOp" | "permissions">,
  roles: readonly T[]
): T[] {
  if (!actor.permissions.has("roles.assign")) return [];
  if (actor.isOp) return [...roles];
  return roles.filter((role) => role.rank < actor.roleRank);
}

/**
 * May this actor change this target's role to this role?
 *
 * Ordered so the most specific refusal wins: a self-edit is reported as a
 * self-edit rather than as a rank problem, because the two have different fixes.
 */
export function canAssignRole(input: {
  actor: AccessActor;
  target: AccessTarget;
  nextRoleKey: string;
  nextRoleRank: number;
}): AccessDecision {
  const { actor, target, nextRoleKey, nextRoleRank } = input;

  if (!actor.permissions.has("roles.assign")) {
    return deny("You do not have permission to assign roles.", 403);
  }

  /*
   * Self-service role changes are refused outright, including for the owner.
   *
   * A promotion needs somebody else to agree, and a demotion performed on
   * yourself is the last thing an account does before it stops being able to
   * undo it. Neither is a thing this screen should make easy, and both have a
   * clean alternative: ask another admin.
   */
  if (actor.userId === target.userId) {
    return deny("You cannot change your own role. Ask another admin.", 403);
  }

  if (!actor.isOp) {
    if (target.roleRank >= actor.roleRank) {
      return deny("You cannot change the role of somebody at or above your own level.", 403);
    }
    if (nextRoleRank >= actor.roleRank) {
      return deny("You cannot assign a role at or above your own level.", 403);
    }
  }

  if (target.roleKey === nextRoleKey) {
    return deny("That user already has this role.", 409);
  }

  return ALLOW;
}

/**
 * The last admin cannot be demoted.
 *
 * Separate from {@link canAssignRole} because it needs a count the caller has to
 * go and fetch, and because it applies to the owner too. An installation with no
 * admin has nobody who can appoint one; the recovery is a database edit, which
 * is not a recovery.
 */
export function wouldRemoveLastAdmin(input: {
  currentRoleKey: string;
  nextRoleKey: string;
  adminCount: number;
}): boolean {
  return input.currentRoleKey === "admin" && input.nextRoleKey !== "admin" && input.adminCount <= 1;
}

/**
 * A role change loud enough to require an explicit confirmation in the UI.
 *
 * Granting staff standing, or taking it away, is the change somebody should have
 * to mean. Moving a member between two non-staff roles is not.
 */
export function isDangerousRoleChange(input: {
  currentIsStaff: boolean;
  nextIsStaff: boolean;
  nextRoleKey: string;
}): boolean {
  return input.nextRoleKey === "admin" || input.currentIsStaff !== input.nextIsStaff;
}

// ---------------------------------------------------------------------------
// Account status
// ---------------------------------------------------------------------------

/**
 * Status is derived from `user_bans` and `user_restrictions`, so "changing" it
 * means applying or lifting one of those. These are the four things a staff
 * member can actually do, named as intents rather than as table writes.
 */
export const STATUS_ACTIONS = ["suspend", "unsuspend", "restrict", "unrestrict"] as const;
export type StatusAction = (typeof STATUS_ACTIONS)[number];

/** The permission each intent needs, and whether a request-only variant exists. */
export const STATUS_ACTION_PERMISSIONS: Readonly<
  Record<StatusAction, { direct: string; request: string | null }>
> = {
  suspend: { direct: "moderation.ban", request: "moderation.ban.request" },
  unsuspend: { direct: "moderation.ban", request: null },
  restrict: { direct: "moderation.restrict", request: "moderation.restrict.request" },
  unrestrict: { direct: "moderation.restrict", request: null },
};

/**
 * The three areas a restriction can withhold, and what each one actually costs
 * the person.
 *
 * The old panel offered "Site / Community / Direct messages" in a bare dropdown
 * beside a second dropdown of verbs, and nothing on screen said what any of them
 * meant. These sentences are the screen's only description of the consequence,
 * so they live here where a test can hold them to naming what survives as well
 * as what is withheld.
 */
export const RESTRICTION_KINDS = ["site", "community", "dm"] as const;
export type RestrictionKind = (typeof RESTRICTION_KINDS)[number];

export const RESTRICTION_KIND_LABELS: Readonly<Record<RestrictionKind, string>> = {
  site: "Site access",
  community: "Community",
  dm: "Direct messages",
};

export const RESTRICTION_KIND_MEANING: Readonly<Record<RestrictionKind, string>> = {
  site: "Cannot browse or order while it lasts. Paid orders already placed are unaffected.",
  community: "Cannot post, reply or start threads. Can still sign in, browse and order.",
  dm: "Cannot send direct messages. Everything else is unaffected.",
};

export const MIN_STATUS_REASON_LENGTH = 8;
export const MAX_STATUS_REASON_LENGTH = 500;

/**
 * How each status action is described before it is taken.
 *
 * One sentence for what happens, one for what keeps working. The second sentence
 * is the one that stops a staff member hesitating over whether suspending an
 * account also cancels the order it already paid for — it does not, and nothing
 * on the old screen said so.
 */
export const STATUS_ACTION_COPY: Readonly<
  Record<StatusAction, { title: string; verb: string; effect: string; preserved: string; danger: boolean }>
> = {
  suspend: {
    title: "Suspend account",
    verb: "Suspend",
    effect: "This person will not be able to sign in.",
    preserved: "Paid orders, their history and their delivery email are unaffected.",
    danger: true,
  },
  unsuspend: {
    title: "Restore access",
    verb: "Restore access",
    effect: "This person will be able to sign in again.",
    preserved: "Any separate area restrictions stay in place until lifted individually.",
    danger: false,
  },
  restrict: {
    title: "Restrict account",
    verb: "Restrict",
    effect: "One area is withheld. They can still sign in.",
    preserved: "Paid orders, their history and their delivery email are unaffected.",
    danger: true,
  },
  unrestrict: {
    title: "Lift restriction",
    verb: "Lift restriction",
    effect: "The chosen area becomes available again.",
    preserved: "Any suspension stays in place until lifted separately.",
    danger: false,
  },
};

/** Restriction lengths the panel offers. `null` means until manually lifted. */
export const RESTRICTION_DURATIONS: readonly { hours: number | null; label: string }[] = [
  { hours: null, label: "Until manually lifted" },
  { hours: 24, label: "24 hours" },
  { hours: 24 * 7, label: "7 days" },
  { hours: 24 * 30, label: "30 days" },
  { hours: 24 * 90, label: "90 days" },
];

/**
 * Every status change carries a reason, and a blank one is not a reason.
 *
 * The minimum length is small on purpose — it is there to refuse `.` and `x`,
 * not to make somebody write an essay. A status change with no explanation is
 * the one an audit log cannot make sense of six months later.
 */
export function isValidStatusReason(reason: unknown): reason is string {
  if (typeof reason !== "string") return false;
  const trimmed = reason.trim();
  return trimmed.length >= MIN_STATUS_REASON_LENGTH && trimmed.length <= MAX_STATUS_REASON_LENGTH;
}

/**
 * May this actor change this target's account status?
 *
 * Same two rank rules as roles, for the same reason: suspending the admin who
 * is investigating you is a privilege escalation with extra steps.
 */
export function canChangeStatus(input: {
  actor: AccessActor;
  target: AccessTarget;
  action: StatusAction;
  reason: unknown;
}): AccessDecision {
  const { actor, target, action, reason } = input;

  const required = STATUS_ACTION_PERMISSIONS[action];
  if (!required) return deny("Unknown status action.", 400);

  const canDirect = actor.permissions.has(required.direct);
  const canRequest = required.request ? actor.permissions.has(required.request) : false;
  if (!canDirect && !canRequest) {
    return deny("You do not have permission to change this account's status.", 403);
  }

  if (actor.userId === target.userId) {
    return deny("You cannot change your own account status.", 403);
  }

  if (!actor.isOp && target.roleRank >= actor.roleRank) {
    return deny("You cannot change the status of somebody at or above your own level.", 403);
  }

  if (!isValidStatusReason(reason)) {
    return deny(`A reason of at least ${MIN_STATUS_REASON_LENGTH} characters is required.`, 400);
  }

  return ALLOW;
}

/** True when the actor may only file a request rather than apply the change. */
export function statusChangeNeedsApproval(input: {
  actor: Pick<AccessActor, "permissions">;
  action: StatusAction;
}): boolean {
  const required = STATUS_ACTION_PERMISSIONS[input.action];
  if (!required) return false;
  return !input.actor.permissions.has(required.direct);
}

// ---------------------------------------------------------------------------
// Profile edits
// ---------------------------------------------------------------------------

/**
 * The only profile fields staff may write.
 *
 * An allowlist, not a denylist. A denylist has to be updated every time the
 * profiles table grows a column, and the failure mode of forgetting is that
 * something private becomes editable — whereas forgetting to add to an allowlist
 * just means a field stays read-only until somebody asks.
 *
 * Absent on purpose, and each for its own reason:
 *
 *  * `email` — lives in `auth.users` and changing it there has no verification
 *    flow in this codebase. An unverified email change is an account takeover
 *    primitive, so email stays read-only until that flow exists.
 *  * `is_verified`, `donation_rank` — real fields, but each has its own
 *    permission and its own route already. They are not general profile edits.
 *  * `karma`, `is_op`, `role` — derived, owner-only, or owned by `user_roles`.
 *  * Anything in `auth.users` — password, provider identities, MFA, confirmed
 *    status. Staff have no business writing any of it from here.
 */
export const EDITABLE_PROFILE_FIELDS = ["username", "display_name", "bio", "location"] as const;
export type EditableProfileField = (typeof EDITABLE_PROFILE_FIELDS)[number];

export const PROFILE_FIELD_LIMITS: Readonly<Record<EditableProfileField, number>> = {
  username: 32,
  display_name: 48,
  bio: 500,
  location: 80,
};

/** Fields that must never be written by the staff profile route, whatever is posted. */
export const FORBIDDEN_PROFILE_FIELDS = [
  "id",
  "email",
  "role",
  "karma",
  "is_op",
  "is_verified",
  "donation_rank",
  "password",
  "encrypted_password",
  "email_confirmed_at",
  "phone",
  "raw_app_meta_data",
  "raw_user_meta_data",
] as const;

export function isEditableProfileField(field: string): field is EditableProfileField {
  return (EDITABLE_PROFILE_FIELDS as readonly string[]).includes(field);
}

/**
 * Filters a submitted patch down to what may actually be written.
 *
 * Returns only recognised fields, trimmed and length-capped. An empty string
 * becomes `null` so "clear this field" is expressible, which it would not be if
 * blanks were simply dropped.
 */
export function sanitizeProfilePatch(input: Record<string, unknown>): Partial<Record<EditableProfileField, string | null>> {
  const output: Partial<Record<EditableProfileField, string | null>> = {};

  for (const field of EDITABLE_PROFILE_FIELDS) {
    const raw = input[field];
    if (raw === undefined) continue;
    if (raw === null) {
      output[field] = null;
      continue;
    }
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    output[field] = trimmed ? trimmed.slice(0, PROFILE_FIELD_LIMITS[field]) : null;
  }

  return output;
}

/**
 * May this actor edit this target's profile?
 *
 * Rank applies here too, though less obviously than it does to roles: a display
 * name is also how a person is identified in the audit log, and renaming the
 * admin who is about to review your work is not a cosmetic change.
 */
export function canEditProfile(input: { actor: AccessActor; target: AccessTarget }): AccessDecision {
  const { actor, target } = input;

  if (!actor.permissions.has("users.profile.edit")) {
    return deny("You do not have permission to edit profiles.", 403);
  }

  // Editing your own profile from the staff tool is allowed — it is the same
  // power the account settings page already gives, and refusing it here would
  // only send somebody to a different screen to do the identical thing.
  if (actor.userId === target.userId) return ALLOW;

  if (!actor.isOp && target.roleRank >= actor.roleRank) {
    return deny("You cannot edit the profile of somebody at or above your own level.", 403);
  }

  return ALLOW;
}

// ---------------------------------------------------------------------------
// Staff notes
// ---------------------------------------------------------------------------

export const NOTE_CATEGORIES = [
  "general",
  "preference",
  "manufacturing",
  "billing",
  "shipping",
  "warning",
] as const;
export type NoteCategory = (typeof NOTE_CATEGORIES)[number];

export const NOTE_CATEGORY_LABELS: Readonly<Record<NoteCategory, string>> = {
  general: "General",
  preference: "Preference",
  manufacturing: "Manufacturing",
  billing: "Billing",
  shipping: "Shipping",
  warning: "Warning",
};

export const MAX_NOTE_LENGTH = 4000;

export function isNoteCategory(value: unknown): value is NoteCategory {
  return typeof value === "string" && (NOTE_CATEGORIES as readonly string[]).includes(value);
}

export function isValidNoteBody(body: unknown): body is string {
  if (typeof body !== "string") return false;
  const trimmed = body.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_NOTE_LENGTH;
}

/**
 * A one-line description of a note, for the audit event.
 *
 * The note body is **not** copied into audit metadata. A note can carry a
 * customer's circumstances, and duplicating that into a second table doubles the
 * places it has to be protected and redacted. The audit row carries the note id,
 * its category and its length — enough to prove what happened and to find the
 * note, and nothing that has to be redacted twice.
 */
export function noteAuditSummary(input: { category: string; bodyLength: number }): string {
  const label = NOTE_CATEGORY_LABELS[input.category as NoteCategory] ?? "Note";
  return `${label} note (${input.bodyLength} characters)`;
}
