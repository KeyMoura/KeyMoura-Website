import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assignableRoles,
  canAssignRole,
  canChangeStatus,
  canEditProfile,
  EDITABLE_PROFILE_FIELDS,
  FORBIDDEN_PROFILE_FIELDS,
  isDangerousRoleChange,
  isNoteCategory,
  isValidNoteBody,
  isValidStatusReason,
  MAX_NOTE_LENGTH,
  MIN_STATUS_REASON_LENGTH,
  noteAuditSummary,
  NOTE_CATEGORIES,
  sanitizeProfilePatch,
  statusChangeNeedsApproval,
  STATUS_ACTION_PERMISSIONS,
  wouldRemoveLastAdmin,
  type AccessActor,
  type AccessTarget,
} from "../src/lib/staff/userAccess.ts";
import {
  ACCOUNT_STATUSES,
  averageOrderValueCents,
  emptyUserFilters,
  formatCents,
  hasActiveUserFilters,
  isUserUuid,
  looksLikeEmail,
  looksLikeOrderNumber,
  normalizeOrderNumber,
  parseUserFilters,
  USER_SORTS,
  USER_SORT_COLUMNS,
  USER_SORT_LABELS,
  userDisplayLabel,
  userFiltersToQuery,
  userInitial,
} from "../src/lib/staff/userDirectory.ts";
import { AUDIT_ACTIONS, describeAction } from "../src/lib/audit/actions.ts";
import { PERMISSIONS, PERMISSION_META, ROLE_PERMISSIONS } from "../src/lib/permissions.ts";

/**
 * User management — the rules, the query model, and the boundaries.
 *
 * The security assertions here are the point of the file. Role rank, privilege
 * escalation and "a customer must never read staff data" are properties that
 * cannot be checked by looking at a screen, and the two ways this codebase has
 * historically shipped them broken — a missing grant, and a guard that lives
 * only in the UI — are both invisible to TypeScript.
 */

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

/** Source with comments stripped — the comments quote the very things asserted. */
const readCode = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** Executable SQL only, for the same reason. */
const sqlOf = (source: string) => source.replace(/--[^\n]*/g, "");

const MIGRATION = read("supabase/migrations/20260809210000_user_management.sql");
const MIGRATION_SQL = sqlOf(MIGRATION);

// ---------------------------------------------------------------------------
// Role hierarchy and privilege escalation
// ---------------------------------------------------------------------------

/** Live ranks, from `public.roles`. */
const ADMIN = 100;
const MODERATOR = 60;
const SUPPORT = 40;
const MEMBER = 10;

function actor(overrides: Partial<AccessActor> = {}): AccessActor {
  return {
    userId: "actor-1",
    roleKey: "moderator",
    roleRank: MODERATOR,
    isOp: false,
    permissions: new Set(["roles.assign"]),
    ...overrides,
  };
}

function target(overrides: Partial<AccessTarget> = {}): AccessTarget {
  return { userId: "target-1", roleKey: "member", roleRank: MEMBER, ...overrides };
}

test("assigning a role needs the permission at all", () => {
  const decision = canAssignRole({
    actor: actor({ permissions: new Set() }),
    target: target(),
    nextRoleKey: "support",
    nextRoleRank: SUPPORT,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.status, 403);
});

test("a moderator cannot demote an admin — you cannot reach above yourself", () => {
  const decision = canAssignRole({
    actor: actor(),
    target: target({ roleKey: "admin", roleRank: ADMIN }),
    nextRoleKey: "member",
    nextRoleRank: MEMBER,
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.allowed === false ? decision.reason : "", /at or above your own level/);
});

test("a moderator cannot promote anybody to admin — you cannot grant above yourself", () => {
  /*
   * The escalation this closes: without it, a moderator promotes a second
   * account to admin and reaches everything through it. Reach and grant are two
   * checks because dropping either one leaves the hole open.
   */
  const decision = canAssignRole({
    actor: actor(),
    target: target(),
    nextRoleKey: "admin",
    nextRoleRank: ADMIN,
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.allowed === false ? decision.reason : "", /at or above your own level/);
});

test("a moderator cannot clone their own rank onto somebody else", () => {
  const decision = canAssignRole({
    actor: actor(),
    target: target(),
    nextRoleKey: "moderator",
    nextRoleRank: MODERATOR,
  });
  assert.equal(decision.allowed, false, "equal rank is as dangerous as higher — the target can then act on peers");
});

test("a moderator may promote a member to support", () => {
  const decision = canAssignRole({
    actor: actor(),
    target: target(),
    nextRoleKey: "support",
    nextRoleRank: SUPPORT,
  });
  assert.equal(decision.allowed, true);
});

test("nobody changes their own role, not even the owner", () => {
  for (const isOp of [false, true]) {
    const decision = canAssignRole({
      actor: actor({ userId: "same", isOp, roleRank: ADMIN }),
      target: target({ userId: "same", roleKey: "admin", roleRank: ADMIN }),
      nextRoleKey: "member",
      nextRoleRank: MEMBER,
    });
    assert.equal(decision.allowed, false, `isOp=${isOp} must still be refused`);
    assert.match(decision.allowed === false ? decision.reason : "", /your own role/);
  }
});

test("the owner bypasses rank but is still refused a no-op", () => {
  const promote = canAssignRole({
    actor: actor({ isOp: true, roleRank: 0 }),
    target: target({ roleKey: "member", roleRank: MEMBER }),
    nextRoleKey: "admin",
    nextRoleRank: ADMIN,
  });
  assert.equal(promote.allowed, true, "the owner may appoint an admin from a rank-0 role row");

  const noop = canAssignRole({
    actor: actor({ isOp: true }),
    target: target({ roleKey: "member", roleRank: MEMBER }),
    nextRoleKey: "member",
    nextRoleRank: MEMBER,
  });
  assert.equal(noop.allowed, false);
  assert.equal(noop.allowed === false && noop.status, 409);
});

test("assignableRoles offers only what the actor may actually grant", () => {
  const roles = [
    { key: "admin", rank: ADMIN },
    { key: "moderator", rank: MODERATOR },
    { key: "support", rank: SUPPORT },
    { key: "member", rank: MEMBER },
  ];

  const forModerator = assignableRoles(
    { roleRank: MODERATOR, isOp: false, permissions: new Set(["roles.assign"]) },
    roles
  );
  assert.deepEqual(forModerator.map((r) => r.key), ["support", "member"]);

  // Every offered option must also pass the route's own check. An option that
  // appears and then refuses teaches staff to distrust the whole control.
  for (const role of forModerator) {
    const decision = canAssignRole({
      actor: actor(),
      target: target(),
      nextRoleKey: role.key,
      nextRoleRank: role.rank,
    });
    assert.ok(decision.allowed || role.key === "member", `${role.key} was offered but refused`);
  }

  assert.deepEqual(
    assignableRoles({ roleRank: MODERATOR, isOp: false, permissions: new Set() }, roles),
    [],
    "no permission means no options at all"
  );
  assert.equal(
    assignableRoles({ roleRank: 0, isOp: true, permissions: new Set(["roles.assign"]) }, roles).length,
    4
  );
});

test("the last admin cannot be demoted, by anyone", () => {
  assert.equal(wouldRemoveLastAdmin({ currentRoleKey: "admin", nextRoleKey: "member", adminCount: 1 }), true);
  assert.equal(wouldRemoveLastAdmin({ currentRoleKey: "admin", nextRoleKey: "member", adminCount: 2 }), false);
  assert.equal(wouldRemoveLastAdmin({ currentRoleKey: "member", nextRoleKey: "admin", adminCount: 1 }), false);
  assert.equal(
    wouldRemoveLastAdmin({ currentRoleKey: "admin", nextRoleKey: "admin", adminCount: 1 }),
    false,
    "keeping an admin an admin removes nobody"
  );
});

test("crossing the staff boundary is a dangerous change and asks first", () => {
  assert.equal(isDangerousRoleChange({ currentIsStaff: false, nextIsStaff: true, nextRoleKey: "support" }), true);
  assert.equal(isDangerousRoleChange({ currentIsStaff: true, nextIsStaff: false, nextRoleKey: "member" }), true);
  assert.equal(isDangerousRoleChange({ currentIsStaff: false, nextIsStaff: false, nextRoleKey: "member" }), false);
  assert.equal(
    isDangerousRoleChange({ currentIsStaff: true, nextIsStaff: true, nextRoleKey: "admin" }),
    true,
    "admin is always dangerous even between two staff roles"
  );
});

// ---------------------------------------------------------------------------
// Account status
// ---------------------------------------------------------------------------

test("a status change always carries a reason", () => {
  assert.equal(isValidStatusReason(""), false);
  assert.equal(isValidStatusReason("   "), false);
  assert.equal(isValidStatusReason("."), false);
  assert.equal(isValidStatusReason("x".repeat(MIN_STATUS_REASON_LENGTH - 1)), false);
  assert.equal(isValidStatusReason("x".repeat(MIN_STATUS_REASON_LENGTH)), true);
  assert.equal(isValidStatusReason("Chargeback fraud, third occurrence."), true);
  assert.equal(isValidStatusReason(null), false);
  assert.equal(isValidStatusReason(123), false);
});

test("suspending needs a moderation permission, and a reason", () => {
  const withBan = actor({ permissions: new Set(["moderation.ban"]) });

  assert.equal(
    canChangeStatus({ actor: withBan, target: target(), action: "suspend", reason: "Repeated chargebacks" }).allowed,
    true
  );

  const noReason = canChangeStatus({ actor: withBan, target: target(), action: "suspend", reason: "" });
  assert.equal(noReason.allowed, false);
  assert.equal(noReason.allowed === false && noReason.status, 400);

  const noPermission = canChangeStatus({
    actor: actor({ permissions: new Set(["users.view"]) }),
    target: target(),
    action: "suspend",
    reason: "Repeated chargebacks",
  });
  assert.equal(noPermission.allowed, false);
  assert.equal(noPermission.allowed === false && noPermission.status, 403);
});

test("you cannot suspend somebody at or above your own level, or yourself", () => {
  const withBan = actor({ permissions: new Set(["moderation.ban"]) });

  const upward = canChangeStatus({
    actor: withBan,
    target: target({ roleKey: "admin", roleRank: ADMIN }),
    action: "suspend",
    reason: "Investigating an incident",
  });
  assert.equal(upward.allowed, false, "suspending the admin investigating you is escalation with extra steps");

  const self = canChangeStatus({
    actor: withBan,
    target: target({ userId: withBan.userId }),
    action: "suspend",
    reason: "Investigating an incident",
  });
  assert.equal(self.allowed, false);
});

test("holding only the request permission files a request rather than applying", () => {
  assert.equal(
    statusChangeNeedsApproval({ actor: { permissions: new Set(["moderation.ban.request"]) }, action: "suspend" }),
    true
  );
  assert.equal(
    statusChangeNeedsApproval({ actor: { permissions: new Set(["moderation.ban"]) }, action: "suspend" }),
    false
  );
});

test("every status action names permissions the application actually defines", () => {
  for (const [action, keys] of Object.entries(STATUS_ACTION_PERMISSIONS)) {
    assert.ok(
      (PERMISSIONS as readonly string[]).includes(keys.direct),
      `${action} requires "${keys.direct}", which is not a real permission key`
    );
    if (keys.request) {
      assert.ok(
        (PERMISSIONS as readonly string[]).includes(keys.request),
        `${action} names "${keys.request}", which is not a real permission key`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Profile edits
// ---------------------------------------------------------------------------

test("the profile allowlist never admits an auth field", () => {
  for (const forbidden of FORBIDDEN_PROFILE_FIELDS) {
    assert.ok(
      !(EDITABLE_PROFILE_FIELDS as readonly string[]).includes(forbidden),
      `${forbidden} must never be staff-editable`
    );
  }
  // Email specifically: there is no verified change flow, so an unverified
  // change would be an account-takeover primitive.
  assert.ok(!(EDITABLE_PROFILE_FIELDS as readonly string[]).includes("email"));
});

test("a profile patch keeps only allowlisted fields", () => {
  const patch = sanitizeProfilePatch({
    display_name: "  Ada  ",
    username: "ada",
    email: "attacker@example.com",
    is_verified: true,
    role: "admin",
    id: "someone-else",
    encrypted_password: "$2a$10$abc",
  });

  assert.deepEqual(Object.keys(patch).sort(), ["display_name", "username"]);
  assert.equal(patch.display_name, "Ada", "values are trimmed");
  assert.equal((patch as Record<string, unknown>).email, undefined);
  assert.equal((patch as Record<string, unknown>).role, undefined);
});

test("an empty string clears a field rather than being dropped", () => {
  const patch = sanitizeProfilePatch({ bio: "   ", location: "" });
  assert.equal(patch.bio, null);
  assert.equal(patch.location, null);
  assert.ok("bio" in patch, "clearing must be expressible, not silently ignored");
});

test("a profile patch is length-capped", () => {
  const patch = sanitizeProfilePatch({ bio: "x".repeat(5000), username: "u".repeat(200) });
  assert.equal(patch.bio?.length, 500);
  assert.equal(patch.username?.length, 32);
});

test("editing your own profile is allowed; editing upward is not", () => {
  const editor = actor({ permissions: new Set(["users.profile.edit"]) });

  assert.equal(canEditProfile({ actor: editor, target: target({ userId: editor.userId }) }).allowed, true);
  assert.equal(canEditProfile({ actor: editor, target: target() }).allowed, true);
  assert.equal(
    canEditProfile({ actor: editor, target: target({ roleKey: "admin", roleRank: ADMIN }) }).allowed,
    false
  );
  assert.equal(
    canEditProfile({ actor: actor({ permissions: new Set() }), target: target() }).allowed,
    false
  );
});

// ---------------------------------------------------------------------------
// Staff notes
// ---------------------------------------------------------------------------

test("a note needs text and is bounded", () => {
  assert.equal(isValidNoteBody(""), false);
  assert.equal(isValidNoteBody("   "), false);
  assert.equal(isValidNoteBody("Prefers email"), true);
  assert.equal(isValidNoteBody("x".repeat(MAX_NOTE_LENGTH)), true);
  assert.equal(isValidNoteBody("x".repeat(MAX_NOTE_LENGTH + 1)), false);
  assert.equal(isValidNoteBody(null), false);
});

test("note categories are an enum, and match the database CHECK constraint", () => {
  assert.equal(isNoteCategory("preference"), true);
  assert.equal(isNoteCategory("nonsense"), false);

  const constraint = MIGRATION_SQL.match(/category in \(([^)]+)\)/);
  assert.ok(constraint, "the migration must constrain the category column");
  const inDatabase = [...constraint[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  const inCode = [...NOTE_CATEGORIES].sort();
  assert.deepEqual(
    inDatabase,
    inCode,
    "a category the code offers and the constraint refuses is a 23514 the first time somebody picks it"
  );
});

test("the note audit summary describes the note without quoting it", () => {
  const summary = noteAuditSummary({ category: "billing", bodyLength: 142 });
  assert.match(summary, /Billing/);
  assert.match(summary, /142/);
  assert.ok(
    !summary.includes("customer"),
    "the summary is built from category and length only — the body must not reach the audit log"
  );
});

test("the notes route never writes the note body into audit metadata", () => {
  const source = readCode("src/app/api/staff/users/[id]/notes/route.ts");
  const metadata = source.match(/metadata:\s*\{[^}]*\}/g) ?? [];
  assert.ok(metadata.length > 0, "the route must record audit metadata");

  for (const block of metadata) {
    /*
     * A `.length` of the text is a measurement, not the text, so those
     * expressions are collapsed before the check. What must not survive is the
     * body itself reaching the audit row — `body: noteText` would, and does not.
     */
    const withoutLengths = block.replace(/\b[\w.]+\.length\b/g, "LENGTH");
    assert.ok(
      !/\bnoteText\b|\bbody\b/.test(withoutLengths),
      `audit metadata must not carry the note text: ${block}`
    );
    assert.match(block, /noteId/, "the metadata must identify which note it was");
  }
});

// ---------------------------------------------------------------------------
// The query model
// ---------------------------------------------------------------------------

test("unknown filter values are refused rather than passed through", () => {
  const filters = parseUserFilters(
    new URLSearchParams("status=exploded&kind=wizard&sort=chaos&orders=maybe&provider=myspace&active=999")
  );
  assert.equal(filters.status, null);
  assert.equal(filters.kind, null);
  assert.equal(filters.orders, null);
  assert.equal(filters.provider, null);
  assert.equal(filters.activeWithinDays, null);
  assert.equal(filters.sort, "newest", "an unknown sort falls back rather than reaching the database");
});

test("filters round-trip through the URL", () => {
  const filters = parseUserFilters(
    new URLSearchParams("q=ada&role=support&kind=staff&status=restricted&orders=has_orders&sort=spend_desc&page=3")
  );
  assert.equal(filters.search, "ada");
  assert.equal(filters.role, "support");
  assert.equal(filters.kind, "staff");
  assert.equal(filters.status, "restricted");
  assert.equal(filters.orders, "has_orders");
  assert.equal(filters.sort, "spend_desc");
  assert.equal(filters.page, 3);

  assert.deepEqual(parseUserFilters(new URLSearchParams(userFiltersToQuery(filters))), filters);
});

test("the default filter set serializes to nothing", () => {
  assert.equal(userFiltersToQuery(emptyUserFilters()), "");
  assert.equal(hasActiveUserFilters(emptyUserFilters()), false);
  assert.equal(hasActiveUserFilters({ ...emptyUserFilters(), status: "suspended" }), true);
  assert.equal(
    hasActiveUserFilters({ ...emptyUserFilters(), sort: "spend_desc", page: 4 }),
    false,
    "sorting and paging are not filters — the Clear button must not appear for them"
  );
});

test("page size and page number are bounded", () => {
  assert.equal(parseUserFilters(new URLSearchParams("size=100000")).pageSize, 100);
  assert.equal(parseUserFilters(new URLSearchParams("size=-4")).pageSize, 25);
  assert.equal(parseUserFilters(new URLSearchParams("page=0")).page, 1);
  assert.equal(parseUserFilters(new URLSearchParams("page=-3")).page, 1);
});

test("search is length-capped so a pasted essay cannot become an unbounded scan", () => {
  assert.equal(parseUserFilters(new URLSearchParams(`q=${"x".repeat(500)}`)).search.length, 120);
});

test("every sort names a column the directory view actually has", () => {
  const viewBody = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf("create or replace view public.staff_user_directory"));
  for (const sort of USER_SORTS) {
    const { column } = USER_SORT_COLUMNS[sort];
    assert.ok(
      new RegExp(`\\b${column}\\b`).test(viewBody),
      `the "${sort}" sort orders by ${column}, which the view does not expose`
    );
    assert.ok(USER_SORT_LABELS[sort], `${sort} has no label`);
  }
});

test("never-active users sort last, not first", () => {
  // `last_seen_at` is null for somebody who has never signed in. With
  // nullsFirst, "recent activity" would open on the least active accounts.
  assert.equal(USER_SORT_COLUMNS.recent_activity.nullsFirst, false);
  assert.equal(USER_SORT_COLUMNS.recent_activity.ascending, false);
});

test("search input is classified by shape", () => {
  assert.equal(isUserUuid("3f6c1a2e-9b4d-4c7a-8e21-5d0f7b3a9c11"), true);
  assert.equal(isUserUuid("not-a-uuid"), false);
  assert.equal(looksLikeEmail("ada@example.com"), true);
  assert.equal(looksLikeEmail("ada"), false);
  assert.equal(looksLikeOrderNumber("KM-0012"), true);
  assert.equal(looksLikeOrderNumber("km12"), true);
  assert.equal(looksLikeOrderNumber("ada@example.com"), false);
});

test("order numbers normalize the way staff type them", () => {
  assert.equal(normalizeOrderNumber("km12"), "KM-0012");
  assert.equal(normalizeOrderNumber("KM-12"), "KM-0012");
  assert.equal(normalizeOrderNumber("km-0012"), "KM-0012");
  assert.equal(normalizeOrderNumber("KM-10234"), "KM-10234");
  assert.equal(normalizeOrderNumber("hello"), null);
});

test("a user always has something to be called", () => {
  assert.equal(userDisplayLabel({ displayName: "Ada", username: "ada", id: "x" }), "Ada");
  assert.equal(userDisplayLabel({ displayName: null, username: "ada", id: "x" }), "ada");
  assert.equal(userDisplayLabel({ displayName: null, username: null, email: "a@b.c", id: "x" }), "a@b.c");
  assert.equal(
    userDisplayLabel({ displayName: "   ", username: null, email: null, id: "3f6c1a2e-9b4d" }),
    "User 3f6c1a2e"
  );
  assert.equal(userInitial({ displayName: "ada", id: "x" }), "A");
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

test("average order value is over paid orders, and is null when there are none", () => {
  assert.equal(averageOrderValueCents(0, 0), null, "no average yet is not an average of zero");
  assert.equal(averageOrderValueCents(13950, 3), 4650);
  assert.equal(averageOrderValueCents(10000, 3), 3333, "rounded to the nearest cent");
});

test("money is formatted from cents, never from a float", () => {
  assert.equal(formatCents(0), "$0.00");
  assert.equal(formatCents(1395), "$13.95");
  assert.equal(formatCents(13950), "$139.50");
  assert.equal(formatCents(-500), "-$5.00");
});

test("the view's spend definition counts received money and floors the net at zero", () => {
  const viewBody = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf("create or replace view public.staff_user_directory"));

  assert.match(
    viewBody,
    /sum\(o2\.amount_paid_cents\)/,
    "spend must be money received, so an unpaid quote contributes nothing without being excluded by name"
  );
  assert.match(
    viewBody,
    /greatest\(0,\s*coalesce\(o\.paid_cents, 0\) - coalesce\(o\.refunded_cents, 0\)\)/,
    "an over-refund must not render as negative lifetime spend"
  );
  assert.match(viewBody, /count\(\*\) filter \(where o2\.amount_paid_cents > 0\)/, "paid order count drives the average");
  assert.match(
    viewBody,
    /count\(\*\) filter \(where o2\.status = 'completed'\)/,
    "completed is a status, not an inference from payment"
  );
});

// ---------------------------------------------------------------------------
// Guest orders are never claimed
// ---------------------------------------------------------------------------

test("the directory view aggregates account-owned orders only", () => {
  const viewBody = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf("create or replace view public.staff_user_directory"));
  const lateral = viewBody.slice(viewBody.indexOf("left join lateral"));

  assert.match(lateral, /where o2\.customer_id = p\.id/, "ownership is customer_id equality and nothing else");
  assert.ok(
    !/guest_email/.test(lateral),
    "no aggregate may consult guest_email — email equality is not proof of ownership"
  );
});

test("the orders route keeps guest matches out of the owned list", () => {
  const source = readCode("src/app/api/staff/users/[id]/orders/route.ts");

  // The owned query filters on customer_id.
  assert.match(source, /\.eq\("customer_id", id\)/);
  // The guest query requires customer_id to be null, so an owned order can
  // never arrive through it.
  assert.match(source, /\.is\("customer_id", null\)/);
  assert.match(source, /possibleGuestOrders/, "guest matches live under their own key");
  assert.match(source, /owned: false/, "each guest row states it is not owned");
  assert.match(source, /guestOrdersAreUnclaimed/);
});

test("the workspace excludes guest orders from every metric", () => {
  const source = readCode("src/app/api/staff/users/[id]/route.ts");
  // The guest count is returned as its own field and is never folded into
  // `metrics`, which is built entirely from the directory view's columns.
  assert.match(source, /possibleGuestOrderCount/);
  const metricsBlock = source.slice(source.indexOf("const metrics"), source.indexOf("const targetRank"));
  assert.ok(
    !/guest/i.test(metricsBlock),
    "no metric may be derived from a guest order"
  );
});

// ---------------------------------------------------------------------------
// Audit integration
// ---------------------------------------------------------------------------

test("the four user-management actions are registered in the taxonomy", () => {
  for (const action of ["user.profile_changed", "user.status_changed", "user.note_created", "user.note_archived"]) {
    assert.ok(action in AUDIT_ACTIONS, `${action} is not registered, so it would render with a guessed label`);
    const definition = describeAction(action);
    assert.equal(definition.entityType, "user");
    assert.ok(definition.label.length > 0);
  }
  assert.equal(
    describeAction("user.status_changed").sensitive,
    true,
    "a suspension is a sensitive action and must be called out as one"
  );
});

test("an unregistered user action still resolves to the security area", () => {
  const definition = describeAction("user.something_added_later");
  assert.equal(definition.area, "security");
  assert.equal(definition.entityType, "user");
  assert.ok(definition.label.length > 0, "a log that hides rows it does not recognise is worse than an ugly label");
});

test("role assignment stays strict, and carries a before and after", () => {
  const source = readCode("src/app/api/staff/security/users/[id]/role/route.ts");
  assert.match(source, /recordAuditEventStrict/, "an unlogged role change is itself the incident");
  assert.match(source, /changes: \{ role: \{ before: currentRole, after: nextRole \} \}/);
  assert.match(source, /canAssignRole/, "the route must use the shared rule, not its own copy");
  assert.match(source, /wouldRemoveLastAdmin/);
  assert.match(source, /expectedRole/, "stale-state protection");
});

test("status, profile, verification and donation rank all record a before and after", () => {
  for (const path of [
    "src/app/api/staff/users/[id]/status/route.ts",
    "src/app/api/staff/security/users/[id]/profile/route.ts",
    "src/app/api/staff/security/users/[id]/verify/route.ts",
    "src/app/api/staff/security/users/[id]/donation-rank/route.ts",
  ]) {
    const source = readCode(path);
    assert.match(source, /before/, `${path} records no "before"`);
    assert.match(source, /after/, `${path} records no "after"`);
    assert.match(source, /recordAudit(Change|Event)/, `${path} writes no audit event`);
  }
});

test("no user-management route writes a sensitive field into an audit change set", () => {
  for (const path of [
    "src/app/api/staff/users/[id]/status/route.ts",
    "src/app/api/staff/users/[id]/notes/route.ts",
    "src/app/api/staff/security/users/[id]/profile/route.ts",
  ]) {
    const source = readCode(path);
    for (const forbidden of ["encrypted_password", "access_token", "refresh_token", "raw_user_meta_data"]) {
      assert.ok(!source.includes(forbidden), `${path} names ${forbidden}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

test("the two note permissions are declared and described", () => {
  for (const key of ["users.notes.view", "users.notes.manage"]) {
    assert.ok((PERMISSIONS as readonly string[]).includes(key), `${key} is missing from PERMISSIONS`);
    const meta = (PERMISSION_META as Record<string, { label: string; description: string } | undefined>)[key];
    assert.ok(meta, `${key} has no metadata, so the permission editor would hide it`);
    assert.ok(meta.description.length > 20, `${key} needs a description a person can act on`);
  }
});

test("no non-admin role gets note permissions by default", () => {
  for (const [role, keys] of Object.entries(ROLE_PERMISSIONS)) {
    if (role === "admin") continue;
    for (const key of ["users.notes.view", "users.notes.manage"]) {
      assert.ok(
        !(keys as readonly string[]).includes(key),
        `${role} is granted ${key} by default; notes are opt-in`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Route authorization — every endpoint is gated
// ---------------------------------------------------------------------------

const USER_ROUTES = [
  "src/app/api/staff/users/route.ts",
  "src/app/api/staff/users/[id]/route.ts",
  "src/app/api/staff/users/[id]/orders/route.ts",
  "src/app/api/staff/users/[id]/activity/route.ts",
  "src/app/api/staff/users/[id]/communications/route.ts",
  "src/app/api/staff/users/[id]/notes/route.ts",
  "src/app/api/staff/users/[id]/notes/[noteId]/archive/route.ts",
  "src/app/api/staff/users/[id]/status/route.ts",
];

test("every user-management route checks a permission before it reads anything", () => {
  for (const path of USER_ROUTES) {
    const source = readCode(path);
    assert.match(
      source,
      /require(Permission|AnyPermission)|getActorAccessFromRequest/,
      `${path} does not authorize its caller`
    );
    assert.match(source, /403|401/, `${path} never refuses`);
  }
});

test("no user-management route is reachable without the service client", () => {
  // A browser Supabase client on a security-sensitive surface is the pattern
  // pass 20 called out on the catalog page. These routes must not repeat it.
  for (const path of USER_ROUTES) {
    const source = readCode(path);
    assert.ok(!source.includes("supabaseBrowser"), `${path} uses a browser client`);
    assert.ok(!source.includes("NEXT_PUBLIC_SUPABASE_ANON_KEY"), `${path} names the anon key`);
  }
});

test("the service role key never reaches a client component", () => {
  for (const path of [
    "src/app/staff/users/page.tsx",
    "src/app/staff/users/[id]/page.tsx",
    "src/components/staff/UserWorkspaceTabs.tsx",
    "src/components/staff/UserProfileEditor.tsx",
    "src/components/staff/UserPermissionOverrides.tsx",
  ]) {
    const source = read(path);
    assert.ok(!source.includes("SERVICE_ROLE"), `${path} references the service role key`);
    assert.ok(
      !source.includes("staff_user_directory"),
      `${path} queries the directory view directly instead of going through the API`
    );
  }
});

test("the pages never write a user table from the browser", () => {
  for (const path of [
    "src/app/staff/users/page.tsx",
    "src/app/staff/users/[id]/page.tsx",
    "src/components/staff/UserWorkspaceTabs.tsx",
    "src/components/staff/UserProfileEditor.tsx",
    "src/components/staff/UserPermissionOverrides.tsx",
  ]) {
    const source = readCode(path);
    for (const table of ["user_roles", "user_permissions", "user_bans", "user_restrictions", "user_staff_notes", "profiles"]) {
      assert.ok(
        !new RegExp(`from\\("${table}"\\)`).test(source),
        `${path} writes ${table} from the browser; user mutations go through server routes`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Sensitive auth data never leaves the server
// ---------------------------------------------------------------------------

test("the directory view names auth columns one at a time and never selects them all", () => {
  const viewBody = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf("create or replace view public.staff_user_directory"));

  assert.ok(!/\bu\.\*/.test(viewBody), "selecting u.* would put password hashes one response away from a browser");

  for (const secret of [
    "encrypted_password",
    "confirmation_token",
    "recovery_token",
    "email_change_token_new",
    "email_change_token_current",
    "reauthentication_token",
    "raw_user_meta_data",
    "raw_app_meta_data",
    "is_super_admin",
    "phone",
  ]) {
    assert.ok(!viewBody.includes(secret), `the view exposes auth.users.${secret}`);
  }
});

test("only provider names are read from auth.identities", () => {
  const viewBody = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf("create or replace view public.staff_user_directory"));
  const identities = viewBody.slice(viewBody.indexOf("auth.identities") - 200, viewBody.indexOf("auth.identities") + 200);
  assert.match(identities, /i\.provider/);
  assert.ok(!identities.includes("identity_data"), "identity_data carries the provider's returned claims");
});

test("the communications route reuses the masked projection rather than a second one", () => {
  const source = readCode("src/app/api/staff/users/[id]/communications/route.ts");
  assert.match(source, /toDeliveryView/, "a second email log would be a second answer about what is safe to render");
  assert.ok(!source.includes("provider_id"), "the provider message id must not be selected");
  assert.ok(!source.includes("error_message"), "the raw provider error can quote the address it refused");
});

test("communications are scoped to this user, and a user with nothing matches nothing", () => {
  const source = readCode("src/app/api/staff/users/[id]/communications/route.ts");
  assert.match(
    source,
    /if \(!orderIds\.length && !email\)/,
    "without this guard an empty `or` would return every delivery in the system"
  );
  assert.match(source, /order_id\.is\.null/, "account-level mail only, so a guest order cannot arrive by address match");
});

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

test("the migration is additive: no drop, no destructive alter", () => {
  assert.ok(!/\bdrop\s+table\b/i.test(MIGRATION_SQL), "no table may be dropped");
  assert.ok(!/\bdrop\s+column\b/i.test(MIGRATION_SQL), "no column may be dropped");
  assert.ok(!/\bdelete\s+from\b/i.test(MIGRATION_SQL), "no row may be deleted");
  assert.ok(!/\btruncate\b/i.test(MIGRATION_SQL));
  // `drop trigger if exists` immediately before `create trigger` is the
  // idempotent re-run pattern and is the only permitted drop.
  const drops = [...MIGRATION_SQL.matchAll(/\bdrop\s+(\w+)/gi)].map((m) => m[1].toLowerCase());
  assert.deepEqual([...new Set(drops)], ["trigger"]);
});

test("both new objects are revoked from anon and authenticated, and granted to service_role", () => {
  /*
   * Postgres checks grants *before* RLS, so a missing revoke is the whole
   * exposure and a present policy proves nothing. Pass 5a shipped four tables
   * with correct RLS and no grants; pass 20 found `audit_logs` unreadable for
   * the opposite reason. This asserts the grants themselves.
   */
  for (const object of ["user_staff_notes", "staff_user_directory"]) {
    for (const role of ["anon", "authenticated"]) {
      assert.match(
        MIGRATION_SQL,
        new RegExp(`revoke all on public\\.${object} from ${role}`),
        `public.${object} is not revoked from ${role}`
      );
    }
    assert.match(
      MIGRATION_SQL,
      new RegExp(`grant [^;]*on public\\.${object} to service_role`),
      `public.${object} has no service_role grant, so every read would fail with 42501`
    );
  }
});

test("staff notes are append-only at the database, not merely by convention", () => {
  assert.match(MIGRATION_SQL, /alter table public\.user_staff_notes enable row level security/);

  // No DELETE grant to anyone — the refusal happens before the trigger is
  // reached.
  const notesGrants = [...MIGRATION_SQL.matchAll(/grant ([^;]*?) on public\.user_staff_notes to (\w+)/g)];
  assert.ok(notesGrants.length > 0);
  for (const [, privileges] of notesGrants) {
    assert.ok(!/delete/i.test(privileges), `user_staff_notes grants DELETE: ${privileges}`);
  }

  // And a trigger that refuses a rewrite even for a role that could otherwise.
  assert.match(MIGRATION_SQL, /create trigger user_staff_notes_no_rewrite/);
  assert.match(MIGRATION_SQL, /before update or delete on public\.user_staff_notes/);
  assert.match(MIGRATION_SQL, /cannot be un-archived/);
});

test("the append-only trigger pins its search_path", () => {
  // A `security definer` function without a pinned search_path is a privilege
  // escalation: the caller chooses which schema its unqualified names resolve to.
  const fn = MIGRATION_SQL.slice(
    MIGRATION_SQL.indexOf("create or replace function public.user_staff_notes_append_only"),
    MIGRATION_SQL.indexOf("drop trigger if exists")
  );
  assert.match(fn, /security definer/);
  assert.match(fn, /set search_path = ''/);
});

test("the notes table's foreign keys state what happens on delete", () => {
  const table = MIGRATION_SQL.slice(
    MIGRATION_SQL.indexOf("create table if not exists public.user_staff_notes"),
    MIGRATION_SQL.indexOf("comment on table")
  );
  const references = [...table.matchAll(/references public\.\w+ \(\w+\) on delete (\w+(?: \w+)?)/g)].map((m) => m[1]);
  assert.equal(references.length, 4, "every FK must name its delete behaviour explicitly");
  assert.deepEqual(references, ["cascade", "set null", "set null", "set null"]);
});

test("the directory view is indexed for what it joins on", () => {
  for (const index of ["user_staff_notes_user_idx", "user_staff_notes_open_idx", "user_staff_notes_order_idx"]) {
    assert.match(MIGRATION_SQL, new RegExp(`create index if not exists ${index}`), `${index} is missing`);
  }
});

test("the account status vocabulary matches what the view can produce", () => {
  const viewBody = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf("create or replace view public.staff_user_directory"));
  const statusCase = viewBody.slice(viewBody.indexOf("case"), viewBody.indexOf("as account_status"));
  const produced = [...statusCase.matchAll(/then '(\w+)'|else '(\w+)'/g)].map((m) => m[1] ?? m[2]).sort();
  assert.deepEqual(
    produced,
    [...ACCOUNT_STATUSES].sort(),
    "a status the view produces and the filter does not offer is unreachable, and vice versa"
  );
});

test("the migration does not touch Supabase Auth", () => {
  assert.ok(
    !/\b(insert|update|delete)\s+(into\s+)?auth\./i.test(MIGRATION_SQL),
    "auth.users is read by the view and must never be written by this pass"
  );
});

// ---------------------------------------------------------------------------
// The workspace: tabs, and what each one is allowed to open
// ---------------------------------------------------------------------------

const WORKSPACE = readCode("src/app/staff/users/[id]/page.tsx");
const TABS = readCode("src/components/staff/UserWorkspaceTabs.tsx");

test("the workspace declares the six tabs, and each has a panel", () => {
  /*
   * Six, not seven. "Roles & access" became "Access" and Communications became
   * a view inside Activity — at 375px the seven-tab strip was 681px of content
   * in a 342px box, so half of it was unreachable behind a sideways scroll
   * nothing signalled.
   */
  for (const [id, label] of [
    ["overview", "Overview"],
    ["orders", "Orders"],
    ["support", "Support"],
    ["access", "Access"],
    ["notes", "Notes"],
    ["activity", "Activity"],
  ]) {
    assert.ok(
      new RegExp(`\\{\\s*id: "${id}",\\s*\\n?\\s*label: "${label}"`).test(WORKSPACE),
      `the "${label}" tab is not declared`
    );
    assert.ok(
      new RegExp(`<TabPanel id="${id}"`).test(WORKSPACE),
      `the "${label}" tab has no panel, so selecting it would show an empty frame`
    );
  }

  assert.ok(
    !/\{\s*id: "communications"/.test(WORKSPACE),
    "Communications is a view inside Activity now; a seventh tab would put the strip back over the width"
  );
});

test("a tab the viewer may not open is dropped, not disabled", () => {
  /*
   * `PageTabs` filters on `available`, and a tab that refuses when pressed
   * teaches a staff member to distrust the whole strip. Each gated tab must
   * derive its availability from the server's `viewer` block rather than from a
   * client-side guess.
   */
  for (const [id, flag] of [
    ["activity", "canViewActivity"],
    ["notes", "canViewNotes"],
    ["support", "canViewSupport"],
    ["orders", "canViewOrders"],
  ]) {
    const declaration = WORKSPACE.match(new RegExp(`\\{\\s*id: "${id}",[^}]*\\}`));
    assert.ok(declaration, `the ${id} tab is missing`);
    assert.match(declaration[0], /available:/, `the ${id} tab is never gated`);
    assert.ok(
      declaration[0].includes(flag),
      `the ${id} tab must be gated on viewer.${flag}, not on something the client decided`
    );
  }
});

test("communications keeps its own permission gate inside Activity", () => {
  // Folding a surface into another tab must not widen who can see it.
  assert.match(
    WORKSPACE,
    /canViewCommunications=\{state\.data\.viewer\.canViewCommunications\}/,
    "the Activity tab must pass the server's own flag through"
  );
  const segment = TABS.slice(TABS.indexOf("canViewCommunications ? ("));
  assert.ok(segment.length > 0, "the Communications segment is not gated at all");
  assert.match(
    segment.slice(0, segment.indexOf(") : null")),
    /Communications/,
    "the Communications segment must not render without the permission"
  );
  assert.ok(
    TABS.includes("You do not have permission to view email history."),
    "and the panel behind it still treats a refusal as an error"
  );
});

test("the workspace renders the identity header from the loaded user, not the URL", () => {
  assert.match(WORKSPACE, /userDisplayLabel\(user\)/, "the header names the user it actually loaded");
  assert.match(WORKSPACE, /404[\s\S]{0,80}No such user/, "a missing user is a 404, not an empty workspace");
  // The raw uuid moved off the top of Overview and into Advanced — it is still
  // stated, so the page can prove which record it opened.
  assert.match(
    readCode("src/components/staff/UserProfileEditor.tsx"),
    /Account ID/,
    "the account id is stated somewhere, so the page proves which record it opened"
  );
});

test("every viewer capability the workspace reads is one the API actually sends", () => {
  const route = readCode("src/app/api/staff/users/[id]/route.ts");
  const viewerBlock = route.slice(route.indexOf("viewer: {"));
  // Both `name: value` and the shorthand `name,` — the route uses shorthand for
  // `outranksViewer`, and a matcher that only understood colons would report a
  // field as missing when it is present.
  const sent = new Set(
    [...viewerBlock.matchAll(/\b(can[A-Z]\w+|isSelf|outranksViewer|assignableRoles)\s*[:,]/g)].map((m) => m[1])
  );

  // `viewer?.canViewOrders` as well as `viewer.canViewOrders`: the tabs array
  // is built before the workspace has loaded, so those reads are optional and a
  // matcher that only understood `.` reported the page as gating on nothing.
  const surfaces = [WORKSPACE, readCode("src/components/staff/UserAccessTab.tsx"), readCode("src/components/staff/UserOverviewTab.tsx")].join("\n");
  const used = new Set([...surfaces.matchAll(/viewer\??\.(\w+)/g)].map((m) => m[1]));

  for (const flag of used) {
    assert.ok(sent.has(flag), `the page reads viewer.${flag}, which the API never sends — it would be undefined`);
  }
  assert.ok(used.size >= 8, `expected the page to gate on several capabilities, found ${used.size}`);
});

// ---------------------------------------------------------------------------
// Old functionality was absorbed, not lost
// ---------------------------------------------------------------------------

test("/staff/security/users and /staff/info/users redirect to the new workspace", () => {
  for (const path of ["src/app/staff/security/users/page.tsx", "src/app/staff/info/users/page.tsx"]) {
    const source = read(path);
    assert.match(source, /redirect\("\/staff\/users"\)/, `${path} does not forward to /staff/users`);
  }
});

test("every capability the old people page offered is still reachable", () => {
  /*
   * The redirect is only honest if the destination does the same work. These
   * are the routes the 1,500-line page called; each must still be called from
   * the new surfaces, or the redirect quietly deleted a feature.
   */
  const SURFACES = [
    WORKSPACE,
    TABS,
    readCode("src/components/staff/UserAccessTab.tsx"),
    readCode("src/components/staff/UserOverviewTab.tsx"),
    readCode("src/components/staff/UserProfileEditor.tsx"),
    readCode("src/components/staff/UserPermissionOverrides.tsx"),
    readCode("src/app/staff/users/page.tsx"),
  ].join("\n");

  const capabilities: [string, RegExp][] = [
    ["role assignment", /\/api\/staff\/security\/users\/\$\{[^}]+\}\/role/],
    ["avatar replacement", /\/api\/staff\/security\/users\/\$\{[^}]+\}\/avatar/],
    ["permission overrides", /\/api\/staff\/security\/users\/\$\{[^}]+\}\/permissions/],
    ["verification", /\/api\/staff\/security\/users\/\$\{[^}]+\}\/verify/],
    ["donation rank", /\/api\/staff\/security\/users\/\$\{[^}]+\}\/donation-rank/],
    ["profile editing", /\/api\/staff\/security\/users\/\$\{[^}]+\}\/profile/],
    ["account status", /\/api\/staff\/users\/\$\{[^}]+\}\/status/],
  ];

  for (const [name, pattern] of capabilities) {
    assert.match(SURFACES, pattern, `${name} was lost when /staff/security/users became a redirect`);
  }
});

test("the workspace still shows the avatar, verification and donation rank", () => {
  const editor = readCode("src/components/staff/UserProfileEditor.tsx");
  assert.match(WORKSPACE, /UserAvatar/, "the avatar is still displayed");
  assert.match(editor, /donationRankOptions/, "the donation rank picker is still offered");
  assert.match(editor, /is_verified/, "verification is still settable");
  assert.match(readCode("src/components/staff/UserAvatar.tsx"), /onError/, "a stale avatar URL falls back to an initial");
});

test("verification and donation rank moved behind Advanced, and were not removed", () => {
  /*
   * Community-era attributes on a machine shop's customer record. The brief
   * asked for them to stop dominating the screen without losing any backend
   * support — so the routes, the permissions and the controls are all still
   * here, inside a disclosure.
   */
  const editor = read("src/components/staff/UserProfileEditor.tsx");
  const advanced = editor.slice(editor.indexOf("Advanced profile"));
  assert.ok(advanced.length > 0, "there is no Advanced disclosure");
  for (const capability of ["donationRankOptions", "is_verified", 'label="Bio"']) {
    assert.ok(advanced.includes(capability), `${capability} is not inside Advanced profile`);
  }
  // And the fields a shop reads every day are still outside it.
  const everyday = editor.slice(0, editor.indexOf("Advanced profile"));
  for (const field of ['label="Display name"', 'label="Username"', 'label="Email"']) {
    assert.ok(everyday.includes(field), `${field} should not be behind Advanced`);
  }
});

test("the profile editor shows email but offers no input for it", () => {
  const editor = readCode("src/components/staff/UserProfileEditor.tsx");
  const emailField = editor.slice(editor.indexOf('label="Email"'), editor.indexOf('label="Email"') + 400);
  assert.ok(emailField.length > 0, "email must still be visible");
  assert.ok(
    !/<input/.test(emailField),
    "email must be read-only: there is no verified change flow, and an unverified change is a takeover primitive"
  );
});

// ---------------------------------------------------------------------------
// Production relationships
// ---------------------------------------------------------------------------

test("production work is reached through the user's orders", () => {
  const route = readCode("src/app/api/staff/users/[id]/orders/route.ts");
  assert.match(route, /from\("production_jobs"\)/);
  assert.match(
    route,
    /\.in\("order_id", rows\.map\(\(r\) => r\.id\)\)/,
    "jobs are fetched for the orders on this page, not for the user's whole history"
  );
  assert.match(route, /production\.view/, "production detail is gated on its own permission");
  assert.match(TABS, /\/staff\/production\/\$\{job\.id\}/, "each job links to its own workspace");
});

test("the open-production count counts a job once, however it is linked", () => {
  const viewBody = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf("create or replace view public.staff_user_directory"));
  const block = viewBody.slice(viewBody.indexOf("from public.production_jobs j"), viewBody.indexOf("open_production_count"));
  assert.match(block, /j\.customer_id = p\.id/, "a directly linked job counts");
  assert.match(block, /jo\.customer_id = p\.id/, "a job linked through an order counts");
  assert.match(block, /\bor\b/, "the two paths are OR'd so a job linked both ways is not counted twice");
  assert.match(block, /status not in \('completed', 'cancelled'\)/, "only open work is counted");
});

// ---------------------------------------------------------------------------
// Role removal, and the events each direction writes
// ---------------------------------------------------------------------------

test("moving a user to member is recorded as a removal, not an assignment", () => {
  const source = readCode("src/app/api/staff/security/users/[id]/role/route.ts");
  assert.match(
    source,
    /nextRole === "member" && currentRole !== "member" \? "role\.removed" : "role\.assigned"/,
    "the audit action must follow the direction of travel"
  );
  for (const action of ["role.assigned", "role.removed"]) {
    assert.ok(action in AUDIT_ACTIONS, `${action} is not registered`);
    assert.equal(describeAction(action).sensitive, true, `${action} must be flagged sensitive`);
  }
});

test("permission overrides are audited by the existing route, not re-implemented", () => {
  const component = readCode("src/components/staff/UserPermissionOverrides.tsx");
  assert.match(component, /method: "PUT"/, "the component calls the existing route");
  assert.ok(
    !component.includes("recordAudit"),
    "a client component must never write an audit event — the route does it"
  );
  const route = readCode("src/app/api/staff/security/users/[id]/permissions/route.ts");
  assert.match(route, /recordPermissionSetChange/);
  assert.match(route, /permission\.changed/);
  assert.match(route, /diffPermissionSets/, "the event carries what changed, not merely that something did");
});

// ---------------------------------------------------------------------------
// Notes: archive, and the guard that makes it idempotent
// ---------------------------------------------------------------------------

test("archiving a note is guarded against a stale screen", () => {
  const source = readCode("src/app/api/staff/users/[id]/notes/[noteId]/archive/route.ts");
  assert.match(
    source,
    /\.is\("archived_at", null\)/,
    "the update itself must refuse a note archived between the read and the write"
  );
  assert.match(source, /409/, "a second archive is a conflict, not a silent success");
  assert.match(source, /users\.notes\.manage/, "archiving needs the write permission, not the read one");
  assert.match(source, /user\.note_archived/);
  assert.match(source, /\.eq\("user_id", id\)/, "a note can only be archived through the user it belongs to");
});

test("reading notes needs only the view permission; writing needs manage", () => {
  const source = readCode("src/app/api/staff/users/[id]/notes/route.ts");
  const get = source.slice(source.indexOf("export async function GET"), source.indexOf("export async function POST"));
  const post = source.slice(source.indexOf("export async function POST"));

  assert.match(get, /users\.notes\.view/);
  assert.match(post, /requirePermission\(req, "users\.notes\.manage"\)/);
  assert.ok(
    !/users\.notes\.view/.test(post),
    "the view permission must not be sufficient to write a permanent record"
  );
});

test("a note can only be filed against an order the account owns", () => {
  const source = readCode("src/app/api/staff/users/[id]/notes/route.ts");
  assert.match(
    source,
    /\.eq\("customer_id", id\)/,
    "without this a note could be attached to a stranger's order"
  );
});

// ---------------------------------------------------------------------------
// Communications: the order link, and what is withheld
// ---------------------------------------------------------------------------

test("a delivery links to its order and shows a masked recipient", () => {
  assert.match(TABS, /\/staff\/orders\/\$\{delivery\.orderId\}/, "a delivery must link to the order it was about");
  assert.match(TABS, /maskedRecipient/, "the list shows a masked address");
  assert.ok(!TABS.includes("providerId"), "the provider message id is not rendered");
  assert.ok(!TABS.includes("errorMessage"), "the raw provider error is not rendered");
});

test("re-sending goes through the existing audited route and asks first", () => {
  assert.match(
    TABS,
    /\/api\/staff\/emails\/deliveries\/\$\{deliveryId\}\/resend/,
    "no second sender is built here"
  );
  assert.match(TABS, /confirming/, "a real email leaving the building is not a mis-click away");
  const resend = readCode("src/app/api/staff/emails/deliveries/[id]/resend/route.ts");
  assert.match(resend, /email\.manual_resend|staff\.email\.resend/, "the resend must already be audited");
});

// ---------------------------------------------------------------------------
// Providers stay read-only
// ---------------------------------------------------------------------------

test("no route in this pass unlinks an identity or writes auth", () => {
  for (const path of USER_ROUTES) {
    const source = readCode(path);
    assert.ok(!/auth\.admin\.(deleteUser|updateUserById|generateLink)/.test(source), `${path} mutates Supabase Auth`);
    assert.ok(!/unlink/i.test(source), `${path} appears to unlink an identity`);
    assert.ok(!/from\("identities"\)|auth\.identities/.test(source), `${path} reads auth.identities directly`);
  }
});

test("the workspace presents sign-in methods as read-only and says so", () => {
  // The panel moved from the page file into the Access tab; the promise did not.
  const accessTab = readCode("src/components/staff/UserAccessTab.tsx").replace(/\s+/g, " ");
  assert.match(accessTab, /Sign-in methods/);
  assert.match(accessTab, /Read-only\./);
  assert.match(
    accessTab,
    /Passwords, tokens and multi-factor settings are never shown here/,
    "the page states the boundary rather than leaving it implied"
  );
  assert.match(accessTab, /an identity cannot be unlinked from here/);
});

// ---------------------------------------------------------------------------
// The directory row projection
// ---------------------------------------------------------------------------

test("the directory sends what the list renders, and withholds the rest", () => {
  const route = readCode("src/app/api/staff/users/route.ts");
  const selected = route.match(/const SELECT_COLUMNS =\s*([\s\S]*?);/);
  assert.ok(selected, "the route must name its columns");
  const columns = selected[1];

  for (const needed of [
    "role_key",
    "role_name",
    "is_staff",
    "account_status",
    "is_verified",
    "order_count",
    "open_order_count",
    "net_spend_cents",
    "providers",
    "last_seen_at",
    "created_at",
    "email",
  ]) {
    assert.ok(columns.includes(needed), `the directory cannot show ${needed} — it is not selected`);
  }

  assert.ok(!columns.includes("*"), "a directory listing must not select every column");
  for (const withheld of ["karma", "is_op", "auth_deleted", "auth_banned"]) {
    assert.ok(!columns.includes(withheld), `${withheld} is used for filtering and need not reach the browser`);
  }
});

test("the directory page shows role, staff standing and status on every row", () => {
  const page = readCode("src/app/staff/users/page.tsx");
  assert.match(page, /user\.roleName/, "the role is shown");
  assert.match(page, /tone=\{user\.isStaff \? "accent" : "neutral"\}/, "staff are marked as staff");
  assert.match(page, /ACCOUNT_STATUS_LABELS\[user\.accountStatus\]/, "a limited account says so on the row");
  assert.match(page, /formatCents\(user\.netSpendCents\)/, "spend is rendered from cents");
  assert.match(page, /user\.orderCount/, "the order count is on the row");
  assert.match(page, /formatRelative\(user\.lastSeenAt\)/, "last activity is on the row");
});

test("a refused directory query is an error, never an empty list", () => {
  const page = readCode("src/app/staff/users/page.tsx");
  assert.match(page, /kind: "error"/, "the page has a distinct error state");
  assert.match(
    page,
    /res\.status === 403[\s\S]{0,120}permission/,
    "a 403 says so rather than rendering as nobody matched"
  );
  // The empty state must only be reachable from a successful response.
  const emptyBranch = page.slice(page.indexOf('state.kind === "ready"'));
  assert.match(emptyBranch, /Nobody matches these filters|No people yet/);
});

test("each tab panel treats a refusal as an error too", () => {
  assert.match(TABS, /res\.status === 403 \? forbiddenMessage : "Could not load this\."/);
  for (const message of [
    "You do not have permission to view orders.",
    "You do not have permission to view the audit log.",
    "You do not have permission to read staff notes.",
    "You do not have permission to view email history.",
  ]) {
    assert.ok(TABS.includes(message), `no distinct refusal message for: ${message}`);
  }
});
