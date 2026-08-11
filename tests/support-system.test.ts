import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CUSTOMER_MAY_SET_PRIORITY,
  MAX_SUPPORT_MESSAGE_LENGTH,
  MAX_SUPPORT_SUBJECT_LENGTH,
  MIN_SUPPORT_MESSAGE_LENGTH,
  MIN_SUPPORT_REPLY_LENGTH,
  SUPPORT_CATEGORIES,
  SUPPORT_CATEGORY_HELP,
  SUPPORT_CATEGORY_LABELS,
  SUPPORT_CATEGORY_SHORT,
  SUPPORT_PRIORITIES,
  SUPPORT_PRIORITY_LABELS,
  SUPPORT_PRIORITY_RANK,
  SUPPORT_STATUSES,
  SUPPORT_STATUS_CUSTOMER_LABELS,
  SUPPORT_STATUS_LABELS,
  SUPPORT_STATUS_MEANING,
  SUPPORT_STATUS_RANK,
  canChangeStatus,
  checkEmail,
  checkMessage,
  checkSubject,
  customerSupportPath,
  formatSupportAge,
  isAllowedMessageShape,
  isSupportCategory,
  isSupportPriority,
  isSupportStatus,
  isUnresolvedStatus,
  looksLikeSupportReference,
  messageExcerpt,
  needsStaffAttention,
  normalizeBody,
  normalizeSingleLine,
  normalizeSupportReference,
  ownsConversation,
  staffSupportPath,
  statusAfterCustomerMessage,
  statusAfterInternalNote,
  statusAfterStaffReply,
  statusTimestamps,
  type SupportStatus,
} from "../src/lib/support/domain.ts";
import {
  ASSIGNED_TO_ME,
  SUPPORT_SORTS,
  SUPPORT_SORT_COLUMNS,
  SUPPORT_SORT_LABELS,
  SUPPORT_VIEWS,
  SUPPORT_VIEW_LABELS,
  UNASSIGNED,
  classifySupportSearch,
  constraintForView,
  emptySupportFilters,
  hasActiveSupportFilters,
  normalizeOrderNumber,
  parseSupportFilters,
  supportFiltersToQuery,
} from "../src/lib/support/filters.ts";
import { AUDIT_ACTIONS, AUDIT_AREAS, describeAction } from "../src/lib/audit/actions.ts";
import { auditLinks } from "../src/lib/audit/links.ts";
import { isRetainedAuditEvent } from "../src/lib/audit/retention.ts";
import { EMAIL_EVENTS, EMAIL_TEMPLATE_KEYS } from "../src/lib/comms/emailEvents.ts";
import { NOTIFICATION_ALERTS_BY_KIND, alertHref } from "../src/lib/comms/notificationEvents.ts";
import { PERMISSIONS, PERMISSION_META, ROLE_PERMISSIONS } from "../src/lib/permissions.ts";
import { STAFF_NAV_ITEMS, visibleStaffHrefs } from "../src/lib/staffNavigation.ts";

/**
 * The support system: the rules, the query model, and the boundaries.
 *
 * The security assertions are the point of this file. "An internal note never
 * reaches a customer" and "a customer cannot read another customer's
 * conversation" are properties that cannot be checked by looking at a screen,
 * and the two ways this codebase has historically shipped them broken — a
 * missing grant, and a guard that lives only in the UI — are both invisible to
 * TypeScript.
 */

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

/** Source with comments stripped — the comments quote the very things asserted. */
const readCode = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** Executable SQL only, for the same reason. */
const sqlOf = (source: string) => source.replace(/--[^\n]*/g, "");

const MIGRATION = read("supabase/migrations/20260810100000_support_conversations.sql");
const MIGRATION_SQL = sqlOf(MIGRATION);
const ROLLBACK = read("supabase/rollback/20260810100000_support_conversations.rollback.sql");
const TRUNCATE_LOCKDOWN = sqlOf(read("supabase/migrations/20260810110000_support_truncate_lockdown.sql"));
/** Executable statements only — the comments name the very statements asserted. */
const ROLLBACK_SQL = sqlOf(ROLLBACK);

// ---------------------------------------------------------------------------
// The vocabularies are complete
// ---------------------------------------------------------------------------

test("every category, status and priority has a label a person can read", () => {
  for (const category of SUPPORT_CATEGORIES) {
    assert.ok(SUPPORT_CATEGORY_LABELS[category], `${category} has no label`);
    assert.ok(SUPPORT_CATEGORY_SHORT[category], `${category} has no short label`);
    assert.ok(SUPPORT_CATEGORY_HELP[category].length > 15, `${category} has no useful help text`);
  }
  for (const status of SUPPORT_STATUSES) {
    assert.ok(SUPPORT_STATUS_LABELS[status], `${status} has no label`);
    assert.ok(SUPPORT_STATUS_CUSTOMER_LABELS[status], `${status} has no customer label`);
    assert.ok(SUPPORT_STATUS_MEANING[status].length > 15, `${status} does not say what it means`);
  }
  for (const priority of SUPPORT_PRIORITIES) {
    assert.ok(SUPPORT_PRIORITY_LABELS[priority], `${priority} has no label`);
  }
});

test("the customer wording is not the internal wording", () => {
  // The point of a separate table: a customer reading "Waiting on staff" about
  // their own refund learns nothing they can act on.
  assert.notEqual(SUPPORT_STATUS_CUSTOMER_LABELS.waiting_on_staff, SUPPORT_STATUS_LABELS.waiting_on_staff);
  assert.notEqual(SUPPORT_STATUS_CUSTOMER_LABELS.open, SUPPORT_STATUS_LABELS.open);
});

test("the type guards refuse anything not in the vocabulary", () => {
  assert.equal(isSupportCategory("order"), true);
  assert.equal(isSupportCategory("orders"), false);
  assert.equal(isSupportCategory(null), false);
  assert.equal(isSupportStatus("waiting_on_staff"), true);
  assert.equal(isSupportStatus("waiting"), false);
  assert.equal(isSupportPriority("urgent"), true);
  assert.equal(isSupportPriority("critical"), false);
});

test("the TypeScript sort ranks agree with the ones the view computes", () => {
  /*
   * The ordering a staff member sees is decided in Postgres. A second opinion in
   * TypeScript that disagreed would be a list that reorders itself when you page
   * — so the two are asserted against each other rather than trusted to match.
   */
  const view = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf("create or replace view public.staff_support_queue"));

  const statusCase = view.slice(view.indexOf("case c.status"), view.indexOf("end as status_rank"));
  for (const status of SUPPORT_STATUSES) {
    if (status === "closed") continue; // the `else` arm
    assert.match(
      statusCase,
      new RegExp(`when '${status}' then ${SUPPORT_STATUS_RANK[status]}`),
      `status_rank in SQL disagrees with SUPPORT_STATUS_RANK for ${status}`
    );
  }
  assert.equal(SUPPORT_STATUS_RANK.closed, 4, "closed is the else arm and must be the last rank");

  const priorityCase = view.slice(view.indexOf("case c.priority"), view.indexOf("end as priority_rank"));
  for (const priority of SUPPORT_PRIORITIES) {
    if (priority === "low") continue; // the `else` arm
    assert.match(
      priorityCase,
      new RegExp(`when '${priority}' then ${SUPPORT_PRIORITY_RANK[priority]}`),
      `priority_rank in SQL disagrees for ${priority}`
    );
  }
  assert.equal(SUPPORT_PRIORITY_RANK.low, 3);
});

test("unresolved means unresolved in both the module and the view", () => {
  const unresolved = SUPPORT_STATUSES.filter(isUnresolvedStatus);
  assert.deepEqual(unresolved, ["open", "waiting_on_staff", "waiting_on_customer"]);
  for (const status of unresolved) {
    assert.match(MIGRATION_SQL, new RegExp(`is_unresolved[\\s\\S]{0,200}`), "the view must expose is_unresolved");
    assert.ok(MIGRATION_SQL.includes(`'${status}'`), `${status} is not named in the migration`);
  }
  assert.deepEqual(SUPPORT_STATUSES.filter(needsStaffAttention), ["open", "waiting_on_staff"]);
});

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

test("a customer message moves the ball to us, except on a closed conversation", () => {
  assert.equal(statusAfterCustomerMessage("open"), "open");
  assert.equal(statusAfterCustomerMessage("waiting_on_customer"), "waiting_on_staff");
  assert.equal(statusAfterCustomerMessage("waiting_on_staff"), "waiting_on_staff");
  // The whole difference between resolved and closed.
  assert.equal(statusAfterCustomerMessage("resolved"), "waiting_on_staff");
  assert.equal(statusAfterCustomerMessage("closed"), "closed");
});

test("a staff reply moves the ball to them, except on a closed conversation", () => {
  for (const status of ["open", "waiting_on_staff", "waiting_on_customer", "resolved"] as SupportStatus[]) {
    assert.equal(statusAfterStaffReply(status), "waiting_on_customer", `staff reply from ${status}`);
  }
  assert.equal(statusAfterStaffReply("closed"), "closed");
});

test("an internal note moves nothing", () => {
  /*
   * Writing a note to yourself is not an answer. A note that put the thread into
   * "waiting on customer" would park it there while the customer is still
   * waiting on us, which is how a support queue quietly loses somebody.
   */
  for (const status of SUPPORT_STATUSES) {
    assert.equal(statusAfterInternalNote(status), status, `an internal note changed ${status}`);
  }
});

test("a no-op status change is refused rather than silently accepted", () => {
  // A "change" that changes nothing would write an audit event saying
  // `open → open` and a notification about it.
  for (const status of SUPPORT_STATUSES) {
    const decision = canChangeStatus(status, status);
    assert.equal(decision.allowed, false, `${status} → ${status} was allowed`);
  }
  assert.equal(canChangeStatus("open", "resolved").allowed, true);
  assert.equal(canChangeStatus("closed", "open").allowed, true, "reopening a closed conversation must be possible");
});

test("the status timestamps and the CHECK constraints cannot disagree", () => {
  const now = "2026-08-10T12:00:00.000Z";
  assert.deepEqual(statusTimestamps("resolved", now), { resolved_at: now, closed_at: null });
  assert.deepEqual(statusTimestamps("closed", now), { resolved_at: null, closed_at: now });
  for (const status of ["open", "waiting_on_staff", "waiting_on_customer"] as SupportStatus[]) {
    assert.deepEqual(statusTimestamps(status, now), { resolved_at: null, closed_at: null });
  }
  // And the database refuses the combinations this function cannot produce.
  assert.match(MIGRATION_SQL, /\(status = 'resolved'\) = \(resolved_at is not null\)/);
  assert.match(MIGRATION_SQL, /\(status = 'closed'\) = \(closed_at is not null\)/);
});

// ---------------------------------------------------------------------------
// Messages: customer-visible versus internal
// ---------------------------------------------------------------------------

test("a customer can never author an internal note", () => {
  assert.equal(isAllowedMessageShape("customer", "customer"), true);
  assert.equal(isAllowedMessageShape("customer", "internal"), false);
  assert.equal(isAllowedMessageShape("staff", "internal"), true);
  assert.equal(isAllowedMessageShape("staff", "customer"), true);
  assert.equal(isAllowedMessageShape("system", "customer"), true);
});

test("the database refuses the same pair, so the rule survives a route being rewritten", () => {
  assert.match(
    MIGRATION_SQL,
    /support_messages_customer_never_internal check \(\s*author_type <> 'customer' or visibility = 'customer'\s*\)/,
    "the CHECK constraint that stops a customer message being filed as a staff note is missing"
  );
});

test("the customer read path filters visibility in the query, not after it", () => {
  /*
   * The difference matters. A row filtered in the query is never loaded; a row
   * filtered afterwards is one refactor away from being rendered.
   */
  for (const path of [
    "src/app/api/support/conversations/[id]/route.ts",
    "src/lib/commerce/guestOrderAccess.ts",
  ]) {
    const source = readCode(path);
    assert.match(
      source,
      /\.eq\("visibility", "customer"\)|\.eq\("is_internal", false\)/,
      `${path} does not filter staff-only messages in the query`
    );
  }
});

test("the customer conversation API never selects a message's visibility or author id", () => {
  const source = readCode("src/app/api/support/conversations/[id]/route.ts");
  const select = source.match(/\.select\("([^"]+)"\)[\s\S]{0,120}support_messages|from\("support_messages"\)[\s\S]{0,200}\.select\("([^"]+)"\)/);
  assert.ok(select, "could not find the message select");
  const columns = `${select[1] ?? ""}${select[2] ?? ""}`;
  assert.ok(!columns.includes("author_user_id"), "a customer is sent the staff member's user id");
});

test("a customer is never told which staff member replied", () => {
  // The shop speaks with one voice. Putting a named person on a refund refusal
  // invites the customer to direct their next message at them personally.
  const source = readCode("src/app/api/support/conversations/[id]/route.ts");
  assert.match(source, /authorLabel:\s*row\.author_type === "customer" \? row\.author_label : "KeyMoura"/);
});

// ---------------------------------------------------------------------------
// Internal notes never become email
// ---------------------------------------------------------------------------

test("the internal-note route contains no send call of any kind", () => {
  /*
   * The load-bearing assertion of this file.
   *
   * A reply and a note are separate endpoints rather than one endpoint with a
   * boolean, precisely so this can be checked structurally. The boolean version
   * has a single branch deciding whether to email a customer, which is exactly
   * the line that gets inverted during a refactor — and the failure mode is a
   * staff note about a customer arriving in that customer's inbox.
   */
  const source = readCode("src/app/api/staff/support/[id]/notes/route.ts");
  for (const forbidden of [
    "sendCommerceEmail",
    "notifyCustomerOfReply",
    "notifyCustomerOfResolution",
    "notifyNewConversation",
    "Resend",
  ]) {
    assert.ok(!source.includes(forbidden), `the internal-note route references ${forbidden}`);
  }
});

test("the note route can only write visibility: internal, and the reply route only customer", () => {
  const notes = readCode("src/app/api/staff/support/[id]/notes/route.ts");
  assert.match(notes, /visibility:\s*"internal"/);
  assert.ok(!/visibility:\s*"customer"/.test(notes), "the note route has a path to a customer-visible message");

  const reply = readCode("src/app/api/staff/support/[id]/reply/route.ts");
  assert.match(reply, /visibility:\s*"customer"/);
  assert.ok(!/visibility:\s*"internal"/.test(reply), "the reply route has a path to an internal note");
});

test("no support route reads visibility from the request body", () => {
  // A literal in the call, not a value from the wire. There is no request that
  // can make a customer's message a staff-only note.
  for (const path of [
    "src/app/api/support/route.ts",
    "src/app/api/support/conversations/[id]/messages/route.ts",
    "src/app/api/staff/support/[id]/reply/route.ts",
    "src/app/api/staff/support/[id]/notes/route.ts",
  ]) {
    const source = readCode(path);
    assert.ok(
      !/visibility:\s*(body|input|req)/.test(source),
      `${path} takes the message visibility from the request`
    );
  }
});

test("the message-append helper sends nothing and notifies nobody", () => {
  const source = read("src/lib/support/server.ts");
  const fn = source.slice(
    source.indexOf("export async function appendSupportMessage"),
    source.indexOf("export async function recordConversationActivity")
  );
  assert.ok(fn.length > 200, "could not isolate appendSupportMessage");
  for (const forbidden of ["sendCommerceEmail", "raiseOperationalAlert", "createNotification"]) {
    assert.ok(!fn.includes(forbidden), `appendSupportMessage ${forbidden}s; notification is the caller's decision`);
  }
});

// ---------------------------------------------------------------------------
// Ownership — a customer sees only their own
// ---------------------------------------------------------------------------

test("ownership is customer_id equality and nothing else", () => {
  assert.equal(ownsConversation({ customer_id: "u1" }, "u1"), true);
  assert.equal(ownsConversation({ customer_id: "u1" }, "u2"), false);
  assert.equal(ownsConversation({ customer_id: null }, "u1"), false);
  // A signed-out viewer owns nothing, including a guest conversation.
  assert.equal(ownsConversation({ customer_id: null }, null), false);
  assert.equal(ownsConversation({ customer_id: "u1" }, null), false);
});

test("the customer list filters on the session's own id, in the query", () => {
  const source = readCode("src/app/api/support/conversations/route.ts");
  assert.match(source, /\.eq\("customer_id", actor\.userId\)/);
  // And there is no way to ask for somebody else's.
  assert.ok(
    !/searchParams\.get\("(userId|customer|customerId)"\)/.test(source),
    "the customer list accepts a user id from the request"
  );
});

test("a conversation that is not yours is answered 404, not 403", () => {
  /*
   * A 403 confirms the conversation exists, which turns the endpoint into a way
   * to enumerate conversations by trying ids.
   */
  for (const path of [
    "src/app/api/support/conversations/[id]/route.ts",
    "src/app/api/support/conversations/[id]/messages/route.ts",
  ]) {
    const source = readCode(path);
    assert.match(
      source,
      /if \(!conversation \|\| !ownsConversation\(conversation, actor\.userId\)\) \{\s*return NextResponse\.json\(\{ error: "Not found" \}, \{ status: 404 \}\);/,
      `${path} distinguishes "not yours" from "does not exist"`
    );
  }
});

test("a guest order can only be attached with the guest session cookie", () => {
  /*
   * Email equality is a claim anybody who can type can make. Honouring it would
   * turn the support form into a way to bind yourself to a stranger's order.
   */
  const source = readCode("src/app/api/support/route.ts");
  assert.match(source, /authorizeGuestOrderWrite\(guestToken, requestedOrderId\)/);
  assert.match(source, /order\.customer_id !== actor\.userId/);
  assert.ok(
    !/guest_email.*===.*email|eq\("guest_email"/.test(source),
    "the create route matches an order on email somewhere"
  );
});

test("a customer's request body cannot set priority, status, assignment or the reference", () => {
  const source = readCode("src/app/api/support/route.ts");
  for (const field of ["priority", "status", "assigned_to", "assigneeId", "reference"]) {
    assert.ok(
      !new RegExp(`body\\.${field}\\b`).test(source),
      `the create route reads ${field} from the request body`
    );
  }
  // Stated as a constant so the intent is greppable.
  assert.equal(CUSTOMER_MAY_SET_PRIORITY, false);
});

test("a customer's own identity comes from the session, never from the body", () => {
  const source = readCode("src/app/api/support/route.ts");
  assert.match(source, /customerId = actor\.userId/);
  assert.ok(!/body\.customerId|body\.userId/.test(source), "the create route reads a customer id from the body");
});

// ---------------------------------------------------------------------------
// Staff routes are permission-gated
// ---------------------------------------------------------------------------

const STAFF_ROUTES: readonly { path: string; permission: string }[] = [
  { path: "src/app/api/staff/support/route.ts", permission: "support.view" },
  { path: "src/app/api/staff/support/assignees/route.ts", permission: "support.view" },
  { path: "src/app/api/staff/support/[id]/route.ts", permission: "support.view" },
  { path: "src/app/api/staff/support/[id]/reply/route.ts", permission: "support.reply" },
  { path: "src/app/api/staff/support/[id]/notes/route.ts", permission: "support.reply" },
  { path: "src/app/api/staff/support/[id]/assign/route.ts", permission: "support.assign" },
];

test("every staff support route checks a permission before it reads anything", () => {
  for (const { path, permission } of STAFF_ROUTES) {
    const source = readCode(path);
    assert.match(source, /require(Permission|AnyPermission)\(/, `${path} does not authorize its caller`);
    assert.ok(source.includes(`"${permission}"`), `${path} does not name ${permission}`);
    assert.match(source, /403/, `${path} never refuses`);
  }
});

test("changing a conversation's state needs support.manage, not support.view", () => {
  const source = readCode("src/app/api/staff/support/[id]/route.ts");
  const patch = source.slice(source.indexOf("export async function PATCH"));
  assert.match(patch, /requireAnyPermission\(req, \["support\.manage"\]\)/);
});

test("no staff support route uses a browser client or names the anon key", () => {
  for (const { path } of STAFF_ROUTES) {
    const source = readCode(path);
    assert.ok(!source.includes("supabaseBrowser"), `${path} uses a browser client`);
    assert.ok(!source.includes("NEXT_PUBLIC_SUPABASE_ANON_KEY"), `${path} names the anon key`);
  }
});

test("the service role key never reaches a support page component", () => {
  for (const path of [
    "src/app/support/page.tsx",
    "src/app/support/SupportRequestForm.tsx",
    "src/app/account/support/page.tsx",
    "src/app/account/support/[id]/page.tsx",
    "src/app/staff/support/page.tsx",
    "src/app/staff/support/[id]/page.tsx",
    "src/components/staff/OrderSupportConversations.tsx",
  ]) {
    const source = read(path);
    assert.ok(!source.includes("SERVICE_ROLE"), `${path} references the service role key`);
    assert.ok(
      !source.includes("staff_support_queue"),
      `${path} queries the queue view directly instead of going through the API`
    );
    assert.ok(
      !/from\("support_(conversations|messages)"\)/.test(source),
      `${path} reads a support table from the browser`
    );
  }
});

// ---------------------------------------------------------------------------
// Stale-state protection
// ---------------------------------------------------------------------------

test("status, priority, order link and assignment are all guarded against a stale client", () => {
  /*
   * Two staff members deciding at once must produce one change and one honest
   * 409, not a silent overwrite that neither of them knows about.
   */
  const patch = readCode("src/app/api/staff/support/[id]/route.ts");
  assert.match(patch, /body\.expectedStatus !== conversation\.status/);
  assert.match(patch, /body\.expectedPriority !== conversation\.priority/);
  assert.match(patch, /\.eq\("status", conversation\.status\)/);
  assert.match(patch, /\.eq\("priority", conversation\.priority\)/);
  assert.match(patch, /\.is\("related_order_id", null\)/);
  assert.match(patch, /status: 409/);

  const assign = readCode("src/app/api/staff/support/[id]/assign/route.ts");
  assert.match(assign, /expected !== conversation\.assigned_to/);
  assert.match(assign, /\.eq\("assigned_to", conversation\.assigned_to\)|\.is\("assigned_to", null\)/);
  assert.match(assign, /status: 409/);
});

test("only somebody who can see support may be assigned a conversation", () => {
  /*
   * Without this the assignee field is a uuid column, and a customer's id is a
   * valid uuid: a conversation could be assigned to the customer who opened it.
   */
  const source = readCode("src/app/api/staff/support/[id]/assign/route.ts");
  assert.match(source, /resolveStaffRecipients\("support\.view", null\)/);
  assert.match(source, /if \(!eligible\.includes\(next\)\)/);
});

test("the assignee dropdown is built from the same permission the assign route enforces", () => {
  // A dropdown that offered somebody the route would then refuse is a control
  // that lies.
  const list = readCode("src/app/api/staff/support/assignees/route.ts");
  const assign = readCode("src/app/api/staff/support/[id]/assign/route.ts");
  assert.match(list, /resolveStaffRecipients\("support\.view", null\)/);
  assert.match(assign, /resolveStaffRecipients\("support\.view", null\)/);
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

const SUPPORT_AUDIT_ACTIONS = [
  "support.created",
  "support.assigned",
  "support.unassigned",
  "support.status_changed",
  "support.priority_changed",
  "support.order_linked",
  "support.order_unlinked",
  "support.staff_replied",
  "support.internal_note_added",
  "support.resolved",
  "support.reopened",
] as const;

test("every support audit action is registered in the taxonomy", () => {
  for (const action of SUPPORT_AUDIT_ACTIONS) {
    assert.ok(action in AUDIT_ACTIONS, `${action} is not in the canonical taxonomy`);
    const definition = describeAction(action);
    assert.equal(definition.area, "support", `${action} is filed under ${definition.area}`);
    assert.equal(definition.entityType, "support_conversation");
    assert.ok(definition.label.length > 5, `${action} has no readable label`);
  }
  assert.ok((AUDIT_AREAS as readonly string[]).includes("support"));
});

test("support events are retained, and would not have been without being named", () => {
  /*
   * An event whose type matches no prefix is dropped **silently**. A correctly
   * named `support.staff_replied` from a system actor would have vanished
   * without a word — the exact failure `retention.ts` warns about.
   */
  for (const action of SUPPORT_AUDIT_ACTIONS) {
    assert.equal(isRetainedAuditEvent(action, null), true, `${action} would be silently dropped`);
  }
});

test("a support audit row links to the conversation it is about", () => {
  const links = auditLinks({ entityType: "support_conversation", entityId: "11111111-2222-3333-4444-555555555555" });
  assert.deepEqual(links, [
    { label: "Open conversation", href: "/staff/support/11111111-2222-3333-4444-555555555555" },
  ]);
});

test("no message body is ever put into an audit event", () => {
  /*
   * `support_messages` is append-only and is the authoritative history. Copying
   * a body into `audit_logs` would double the places a customer's words have to
   * be protected — and would put an internal note into a table read under a
   * different permission.
   */
  for (const path of [
    "src/app/api/staff/support/[id]/reply/route.ts",
    "src/app/api/staff/support/[id]/notes/route.ts",
    "src/app/api/support/route.ts",
    "src/lib/support/server.ts",
  ]) {
    const source = readCode(path);
    // A flat object literal — `[^{}]*` stops the match at the closing brace
    // rather than running on to the next one in the file, which would sweep in
    // whatever happened to follow.
    for (const block of source.matchAll(/metadata:\s*\{([^{}]*)\}/g)) {
      assert.ok(
        // A *length* is fine and is the point — it is the one fact about a
        // message worth recording without copying it. The body is not.
        !/\bbody\b|message\.value(?!\.length)|note\.value(?!\.length)/.test(block[1]),
        `${path} puts a message body into audit metadata: ${block[1].trim()}`
      );
    }
  }
});

test("a failed audit write is surfaced, never swallowed", () => {
  for (const path of [
    "src/app/api/staff/support/[id]/reply/route.ts",
    "src/app/api/staff/support/[id]/notes/route.ts",
    "src/app/api/staff/support/[id]/assign/route.ts",
    "src/app/api/staff/support/[id]/route.ts",
  ]) {
    assert.match(readCode(path), /auditFailed: !audited/, `${path} reports a clean success for an unlogged change`);
  }
});

test("a status change records the transition it actually made", () => {
  const source = readCode("src/app/api/staff/support/[id]/route.ts");
  assert.match(source, /changes: \{ status: \{ before: conversation\.status, after: next \} \}/);
  // Resolve and reopen get their own actions, because those are the two a person
  // looks for. Filing them all under one name would mean finding "when was this
  // resolved" by reading change sets.
  assert.match(source, /next === "resolved"\s*\?\s*"support\.resolved"/);
  assert.match(source, /"support\.reopened"/);
});

// ---------------------------------------------------------------------------
// Communications
// ---------------------------------------------------------------------------

test("the four support templates are catalogued, seeded, and each has an event", () => {
  for (const key of ["support_received", "support_staff_reply", "support_resolved", "support_staff_new"]) {
    assert.ok((EMAIL_TEMPLATE_KEYS as readonly string[]).includes(key), `${key} is not in the catalogue`);
    assert.ok(MIGRATION.includes(`'${key}'`), `${key} has no seeded row`);
    assert.ok(
      EMAIL_EVENTS.some((event) => event.templateKey === key),
      `${key} is seeded but nothing triggers it`
    );
  }
});

test("there is deliberately no email event for an internal note", () => {
  const supportEvents = EMAIL_EVENTS.filter((event) => event.related === "support");
  assert.ok(supportEvents.length >= 4);
  for (const event of supportEvents) {
    assert.ok(
      !/internal|note/i.test(event.id),
      `${event.id} looks like an internal-note email, which must not exist`
    );
  }
});

test("support email uses the one sender and never constructs its own", () => {
  const server = read("src/lib/support/server.ts");
  assert.match(server, /import \{ sendCommerceEmail/, "the support server does not import the one sender");
  for (const path of [
    "src/lib/support/server.ts",
    "src/app/api/support/route.ts",
    ...STAFF_ROUTES.map((route) => route.path),
  ]) {
    // Comments stripped: the create route's header quotes the very construction
    // it exists to have replaced.
    const source = readCode(path);
    assert.ok(!source.includes("new Resend"), `${path} builds its own mail client`);
    assert.ok(!source.includes("RESEND_API_KEY"), `${path} reaches for the provider key directly`);
  }
});

test("the staff reply email is keyed on the message, so a retried send cannot duplicate it", () => {
  const server = read("src/lib/support/server.ts");
  assert.match(server, /eventKey: `support-reply-\$\{input\.messageId\}`/);
  // And the row itself is deduplicated by the client token, so one composition
  // is one row, one key and one email.
  assert.match(MIGRATION_SQL, /support_messages_client_token_idx[\s\S]{0,200}where client_token is not null/);
});

test("no support event key is minted from a clock", () => {
  const server = read("src/lib/support/server.ts");
  for (const match of server.matchAll(/eventKey: `([^`]*)`/g)) {
    assert.ok(
      !/Date\.now\(\)|Math\.random/.test(match[1]),
      `the key \`${match[1]}\` is minted from a clock and deduplicates nothing`
    );
  }
});

test("the resolution email is keyed on the transition, not the conversation", () => {
  // A conversation resolved, reopened and resolved again has genuinely been
  // resolved twice; a key of just the id would silently drop the second.
  assert.match(
    read("src/lib/support/server.ts"),
    /eventKey: `support-resolved-\$\{input\.conversation\.id\}-\$\{input\.resolvedAt\}`/
  );
});

test("no notification preview carries the customer's words", () => {
  /*
   * A preview line appears in a bell, a badge and potentially a push. The
   * conversation page is where a customer's message is read.
   */
  const server = readCode("src/lib/support/server.ts");
  for (const call of server.matchAll(/raiseOperationalAlert\(\{([^{}]*)\}\)/g)) {
    // `conversation.subject` rather than a bare "subject": `subjectId` is the
    // alert's own field naming the record it is about, and banning the substring
    // would refuse the correct code.
    for (const banned of ["conversation.subject", ".body", "message.value", "requester_email", "guest_email"]) {
      assert.ok(!call[1].includes(banned), `an alert preview carries ${banned}`);
    }
  }
  const assignee = server.slice(server.indexOf("export async function notifyAssignee"));
  assert.ok(!assignee.includes("conversation.subject"), "the assignment notification carries the customer's subject");
});

test("the support alert kinds exist, are permission-gated on support.view, and deep-link", () => {
  for (const kind of ["support.new_conversation", "support.customer_replied", "support.assigned"] as const) {
    const spec = NOTIFICATION_ALERTS_BY_KIND[kind];
    assert.ok(spec, `${kind} is not in the notification catalogue`);
    assert.equal(spec.permissionKey, "support.view", `${kind} notifies the wrong desk`);
    assert.equal(alertHref(kind, "abc"), "/staff/support/abc");
  }
});

test("the old contact endpoint and its second mail client are gone", () => {
  /*
   * `/api/contact` constructed its own `new Resend(...)`, sent one email and
   * stored nothing — no record, no status, no owner. It was a second sender, and
   * this pass consolidates rather than adds a third.
   */
  let existed = true;
  try {
    read("src/app/api/contact/route.ts");
  } catch {
    existed = false;
  }
  assert.equal(existed, false, "the old contact route still exists alongside the support system");
  assert.match(read("src/app/contact/page.tsx"), /redirect\("\/support"\)/);
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

test("the four support permissions are declared, described, and seeded", () => {
  for (const key of ["support.view", "support.reply", "support.manage", "support.assign"]) {
    assert.ok((PERMISSIONS as readonly string[]).includes(key), `${key} is missing from PERMISSIONS`);
    const meta = (PERMISSION_META as Record<string, { label: string; description: string } | undefined>)[key];
    assert.ok(meta, `${key} has no metadata, so the permission editor would hide it`);
    assert.ok(meta.description.length > 20, `${key} needs a description a person can act on`);
    assert.ok(MIGRATION.includes(`'${key}'`), `${key} is not seeded into public.permissions`);
  }
});

test("moderator is not given support by default; the support role is", () => {
  /*
   * Moderation is about community content. A moderator reading a customer's
   * correspondence about a refund by default is a wider grant than that role was
   * created for. `support` is `is_staff`, ranked 40, and holds zero accounts, so
   * granting it defines the role rather than widening anybody's access.
   */
  for (const key of ["support.view", "support.reply", "support.manage", "support.assign"]) {
    assert.ok(
      !(ROLE_PERMISSIONS.moderator as readonly string[]).includes(key),
      `moderator is granted ${key} by default`
    );
    assert.ok(
      !(ROLE_PERMISSIONS.member as readonly string[]).includes(key),
      `member is granted ${key} by default`
    );
    assert.ok((ROLE_PERMISSIONS.support as readonly string[]).includes(key), `support is not granted ${key}`);
  }
  // The migration seeds the same pairs, and that is the real source of truth.
  assert.match(MIGRATION_SQL, /\('support','support\.view'\)/);
  assert.ok(!/\('moderator','support\./.test(MIGRATION_SQL), "the migration grants a moderator support");
});

test("the staff navigation offers support only to somebody who can open it", () => {
  const item = STAFF_NAV_ITEMS.find((candidate) => candidate.href === "/staff/support");
  assert.ok(item, "there is no navigation entry for support");
  assert.deepEqual(item.anyOf, ["support.view"]);
  // Navigation visibility is not authorization, but the menu must never offer a
  // refusal.
  assert.ok(!visibleStaffHrefs(new Set(["orders.view"])).includes("/staff/support"));
  assert.ok(visibleStaffHrefs(new Set(["support.view"])).includes("/staff/support"));
});

// ---------------------------------------------------------------------------
// Schema: grants, RLS and immutability
// ---------------------------------------------------------------------------

test("neither support table is reachable from a browser session", () => {
  /*
   * Postgres checks grants before RLS, so a missing grant is the real gate — and
   * this project has shipped the opposite mistake twice, where a correct policy
   * was never reached because the grant was absent.
   */
  for (const table of ["support_conversations", "support_messages", "staff_support_queue"]) {
    assert.match(MIGRATION_SQL, new RegExp(`revoke all on public\\.${table} from anon`), `${table} keeps its anon grant`);
    assert.match(
      MIGRATION_SQL,
      new RegExp(`revoke all on public\\.${table} from authenticated`),
      `${table} keeps its authenticated grant`
    );
  }
  assert.match(MIGRATION_SQL, /alter table public\.support_conversations enable row level security/);
  assert.match(MIGRATION_SQL, /alter table public\.support_messages enable row level security/);
});

test("nothing may delete a support message, and nothing may edit one", () => {
  assert.match(MIGRATION_SQL, /grant select, insert on public\.support_messages to service_role/);
  assert.ok(
    !/grant[^;]*update[^;]*on public\.support_messages/i.test(MIGRATION_SQL),
    "support_messages has an UPDATE grant"
  );
  assert.ok(
    !/grant[^;]*delete[^;]*on public\.support_messages/i.test(MIGRATION_SQL),
    "support_messages has a DELETE grant"
  );
  // And the trigger refuses both, so the rule survives a grant being widened.
  assert.match(MIGRATION_SQL, /before update or delete on public\.support_messages/);
  assert.match(MIGRATION_SQL, /append-only; conversation history cannot be deleted/);
});

test("nothing may TRUNCATE the append-only history either", () => {
  /*
   * The one the dry-run missed and re-reading the live grants caught.
   *
   * `support_messages_no_rewrite` is a `BEFORE DELETE ... FOR EACH ROW` trigger,
   * and **a row trigger does not fire on TRUNCATE**. Supabase's default
   * privileges hand `service_role` every privilege on a new table in `public`,
   * so revoking DELETE was not enough: the table advertised as append-only could
   * still have been emptied in one statement.
   *
   * `audit_logs` already closes this. The assertion is on the *revoke*, because
   * the grant is granted by a default nobody wrote and can therefore come back
   * the moment somebody adds a table without thinking about it.
   */
  assert.match(TRUNCATE_LOCKDOWN, /revoke truncate on public\.support_messages from service_role/);
  assert.match(TRUNCATE_LOCKDOWN, /revoke truncate on public\.support_conversations from service_role/);
  // Revoke-only: this migration must never hand anything out.
  assert.ok(!/\bgrant\b/i.test(TRUNCATE_LOCKDOWN), "the lockdown migration grants something");
  assert.ok(!/create |alter table|drop /i.test(TRUNCATE_LOCKDOWN), "the lockdown migration changes an object");
});

test("a conversation's requester and reference cannot be rewritten", () => {
  assert.match(MIGRATION_SQL, /before update on public\.support_conversations/);
  for (const column of ["reference", "customer_id", "guest_email", "created_at"]) {
    assert.match(
      MIGRATION_SQL,
      new RegExp(`new\\.${column} is distinct from old\\.${column}`),
      `${column} can be changed after the fact`
    );
  }
  assert.ok(
    !/grant[^;]*delete[^;]*on public\.support_conversations/i.test(MIGRATION_SQL),
    "support_conversations has a DELETE grant"
  );
});

test("the reference is generated by a sequence, never computed by the application", () => {
  /*
   * Two simultaneous submissions take two `nextval`s. Anything that reads a
   * maximum and adds one collides under concurrency, which is exactly when a
   * support form is busiest.
   */
  assert.match(MIGRATION_SQL, /create sequence if not exists public\.keymoura_support_number_seq/);
  assert.match(MIGRATION_SQL, /nextval\('public\.keymoura_support_number_seq'\)/);
  assert.match(MIGRATION_SQL, /before insert on public\.support_conversations/);

  for (const path of ["src/app/api/support/route.ts", "src/lib/support/server.ts"]) {
    const source = readCode(path);
    assert.ok(!/SUP-\$\{|"SUP-" \+|reference:\s*`SUP/.test(source), `${path} builds a reference itself`);
  }
});

test("a conversation has exactly one requester, and it is not both", () => {
  assert.match(
    MIGRATION_SQL,
    /support_conversations_one_requester check \(\s*\(customer_id is not null and guest_email is null\)\s*or \(customer_id is null and guest_email is not null\)\s*\)/
  );
});

test("assignment is a complete pair or nothing at all", () => {
  assert.match(MIGRATION_SQL, /support_conversations_assignment_complete/);
  assert.match(MIGRATION_SQL, /assigned_to is null and assigned_at is null/);
});

test("the queue view carries no message body", () => {
  const view = MIGRATION_SQL.slice(
    MIGRATION_SQL.indexOf("create or replace view public.staff_support_queue"),
    MIGRATION_SQL.indexOf("comment on view public.staff_support_queue")
  );
  assert.ok(view.length > 400, "could not isolate the view");
  assert.ok(!/m\.body|c\.body|\bbody\b/.test(view), "the inbox view selects a message body");
  assert.match(view, /security_invoker = true/, "the queue view must not run with definer rights");
});

test("the view is granted to service_role alone", () => {
  assert.match(MIGRATION_SQL, /grant select on public\.staff_support_queue to service_role/);
  assert.ok(
    !/grant select on public\.staff_support_queue to (anon|authenticated)/.test(MIGRATION_SQL),
    "the queue view is readable from a browser session"
  );
});

test("the rollback removes everything the migration added, in dependency order", () => {
  for (const statement of [
    "drop view if exists public.staff_support_queue",
    "drop table if exists public.support_messages",
    "drop table if exists public.support_conversations",
    "drop sequence if exists public.keymoura_support_number_seq",
    "drop function if exists public.support_messages_append_only()",
    "drop function if exists public.assign_support_reference()",
  ]) {
    assert.ok(ROLLBACK_SQL.includes(statement), `the rollback does not ${statement}`);
  }
  // The view depends on both tables and must go first.
  assert.ok(
    ROLLBACK_SQL.indexOf("drop view") < ROLLBACK_SQL.indexOf("drop table"),
    "the rollback drops the tables before the view that depends on them"
  );
  // And role grants before the permission rows they reference.
  //
  // Matched against a newline-normalised copy rather than the raw file. The
  // statement spans two lines, and this repository is checked out with CRLF on
  // Windows — so an assertion carrying a bare `\n` matched nothing, returned
  // -1, and reported the ordering as wrong on a rollback that is correctly
  // ordered. The file's line endings are not what this test is about.
  const rollbackLines = ROLLBACK_SQL.replace(/\r\n/g, "\n");
  assert.ok(
    rollbackLines.indexOf("delete from public.role_permissions") <
      rollbackLines.indexOf("delete from public.permissions\nwhere key"),
    "the rollback deletes permissions before the grants referencing them"
  );
  for (const key of ["support.view", "support.reply", "support.manage", "support.assign"]) {
    assert.ok(ROLLBACK_SQL.includes(key), `the rollback leaves ${key} behind`);
  }
});

test("the migration is additive: it alters no existing table", () => {
  const altered = [...MIGRATION_SQL.matchAll(/alter table public\.(\w+)/g)].map((match) => match[1]);
  for (const table of altered) {
    assert.ok(
      ["support_conversations", "support_messages"].includes(table),
      `the migration alters the existing table ${table}`
    );
  }
  assert.ok(!/drop table|drop column|truncate/i.test(MIGRATION_SQL), "the migration drops something");
});

// ---------------------------------------------------------------------------
// Validation and rendering safety
// ---------------------------------------------------------------------------

test("a subject and an opening message are both required, and bounded", () => {
  assert.equal(checkSubject("").ok, false);
  assert.equal(checkSubject("  ").ok, false);
  assert.equal(checkSubject("ab").ok, false);
  const long = checkSubject("x".repeat(500));
  assert.equal(long.ok, true);
  assert.equal(long.ok && long.value.length, MAX_SUPPORT_SUBJECT_LENGTH);

  assert.equal(checkMessage("too short").ok, false);
  assert.equal(checkMessage("this is long enough to be a question").ok, true);
  const longBody = checkMessage("y".repeat(MAX_SUPPORT_MESSAGE_LENGTH + 500));
  assert.equal(longBody.ok && longBody.value.length, MAX_SUPPORT_MESSAGE_LENGTH);
});

test("a reply may be shorter than an opening message", () => {
  // "Yes, thanks" is a complete reply and refusing it would be absurd.
  assert.equal(checkMessage("Yes", MIN_SUPPORT_REPLY_LENGTH).ok, true);
  assert.equal(checkMessage("Yes").ok, false);
  assert.ok(MIN_SUPPORT_REPLY_LENGTH < MIN_SUPPORT_MESSAGE_LENGTH);
});

test("an email must look repliable", () => {
  assert.equal(checkEmail("someone@example.com").ok, true);
  assert.equal(checkEmail("someone@example").ok, false);
  assert.equal(checkEmail("not an address").ok, false);
  const upper = checkEmail("  Someone@Example.COM ");
  assert.equal(upper.ok && upper.value, "someone@example.com");
});

test("a subject cannot smuggle a line break into an email header", () => {
  // `normalizeSingleLine` collapses whitespace, and the sender additionally
  // strips line breaks from anything reaching a header.
  assert.equal(normalizeSingleLine("a\r\nb", 100), "a b");
  assert.equal(normalizeSingleLine("  spaced   out  ", 100), "spaced out");
  const subject = checkSubject("Refund\nBcc: someone@evil.test");
  assert.equal(subject.ok && subject.value.includes("\n"), false);
});

test("a message body keeps its paragraphs but not an unbounded run of blank lines", () => {
  assert.equal(normalizeBody("one\n\ntwo"), "one\n\ntwo");
  assert.equal(normalizeBody("one\n\n\n\n\n\ntwo"), "one\n\n\ntwo");
  assert.equal(normalizeBody("  padded  "), "padded");
  assert.equal(normalizeBody(42), "");
});

test("every surface renders a message as text, never as markup", () => {
  /*
   * This is the one place a staff member's words and a customer's words appear
   * on the same page. Neither may introduce markup into the other's view.
   */
  for (const path of [
    "src/app/account/support/[id]/page.tsx",
    "src/app/staff/support/[id]/page.tsx",
  ]) {
    // Comments stripped: this file's own header names the API it forbids.
    const source = readCode(path);
    assert.ok(!source.includes("dangerouslySetInnerHTML"), `${path} renders a message as HTML`);
    assert.ok(!source.includes("ReactMarkdown"), `${path} runs a message through a markdown renderer`);
    assert.match(source, /whitespace-pre-wrap/, `${path} does not preserve the message's line breaks`);
  }
});

test("the internal note is visually distinct from a reply in the staff workspace", () => {
  // A note that looks like a reply is a note somebody will eventually send as
  // one.
  const source = read("src/app/staff/support/[id]/page.tsx");
  assert.match(source, /message\.visibility === "internal"/);
  assert.match(source, /the customer cannot see this/i);
  // And the two composers are separate forms posting to separate endpoints.
  assert.match(source, /\/reply`/);
  assert.match(source, /\/notes`/);
  assert.ok(
    !/checked=\{internal\}|setInternal/.test(source),
    "the workspace has a single composer with a visibility checkbox"
  );
});

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

test("a reference is normalized however it was typed", () => {
  assert.equal(normalizeSupportReference("SUP-0007"), "SUP-0007");
  assert.equal(normalizeSupportReference("sup7"), "SUP-0007");
  assert.equal(normalizeSupportReference("SUP-7"), "SUP-0007");
  assert.equal(normalizeSupportReference(" sup-0007 "), "SUP-0007");
  assert.equal(normalizeSupportReference("SUP-123456"), "SUP-123456");
  assert.equal(normalizeSupportReference("KM-0007"), null);
  assert.equal(normalizeSupportReference("nonsense"), null);
  assert.equal(looksLikeSupportReference("sup12"), true);
  assert.equal(looksLikeSupportReference("support"), false);
});

test("a raw uuid is never what a person is shown", () => {
  assert.equal(customerSupportPath("abc"), "/account/support/abc");
  assert.equal(staffSupportPath("abc"), "/staff/support/abc");
  // The list and the workspace both show the reference.
  assert.match(read("src/app/staff/support/page.tsx"), /row\.reference/);
  assert.match(read("src/app/account/support/page.tsx"), /row\.reference/);
});

// ---------------------------------------------------------------------------
// The inbox query model
// ---------------------------------------------------------------------------

test("a search string is classified by its shape, not by a mode switch", () => {
  assert.deepEqual(classifySupportSearch("SUP-0007"), { kind: "reference", reference: "SUP-0007" });
  assert.deepEqual(classifySupportSearch("km12"), { kind: "order_number", orderNumber: "KM-0012" });
  assert.deepEqual(classifySupportSearch("someone@example.com"), { kind: "email", email: "someone@example.com" });
  assert.deepEqual(classifySupportSearch("  "), { kind: "none" });
  assert.deepEqual(classifySupportSearch("broken knob"), { kind: "text", text: "broken knob" });
  assert.equal(classifySupportSearch("11111111-2222-3333-4444-555555555555").kind, "id");
  assert.equal(normalizeOrderNumber("KM-12"), "KM-0012");
});

test("an unknown filter value falls back to the default rather than reaching the query", () => {
  const params = new URLSearchParams({
    view: "not-a-view",
    status: "exploded",
    category: "nonsense",
    priority: "critical",
    sort: "sideways",
    assignee: "not-a-uuid",
    customer: "also-not",
    from: "yesterday",
    page: "-4",
    size: "9999",
  });
  const filters = parseSupportFilters(params);
  assert.equal(filters.view, "needs_attention");
  assert.equal(filters.status, null);
  assert.equal(filters.category, null);
  assert.equal(filters.priority, null);
  assert.equal(filters.sort, "attention");
  assert.equal(filters.assignee, null);
  assert.equal(filters.customerId, null);
  assert.equal(filters.createdFrom, null);
  assert.equal(filters.page, 1);
  assert.ok(filters.pageSize <= 100, "an unbounded page size is an unbounded scan");
});

test("the two special assignee values survive parsing, and a uuid does too", () => {
  const uuid = "11111111-2222-3333-4444-555555555555";
  assert.equal(parseSupportFilters(new URLSearchParams({ assignee: UNASSIGNED })).assignee, UNASSIGNED);
  assert.equal(parseSupportFilters(new URLSearchParams({ assignee: ASSIGNED_TO_ME })).assignee, ASSIGNED_TO_ME);
  assert.equal(parseSupportFilters(new URLSearchParams({ assignee: uuid })).assignee, uuid);
});

test("filters round-trip through the URL and omit their defaults", () => {
  const empty = emptySupportFilters();
  assert.equal(supportFiltersToQuery(empty), "");
  assert.equal(hasActiveSupportFilters(empty), false);

  const filters = { ...empty, status: "resolved" as const, priority: "high" as const, page: 3 };
  const round = parseSupportFilters(new URLSearchParams(supportFiltersToQuery(filters)));
  assert.equal(round.status, "resolved");
  assert.equal(round.priority, "high");
  assert.equal(round.page, 3);
  assert.equal(hasActiveSupportFilters(round), true);
});

test("every view resolves to real statuses and every sort names real columns", () => {
  const viewColumns = new Set(
    [...MIGRATION_SQL.matchAll(/(?:as|select)\s+(\w+)[,\n]/g)].map((match) => match[1])
  );
  for (const view of SUPPORT_VIEWS) {
    assert.ok(SUPPORT_VIEW_LABELS[view], `${view} has no label`);
    const constraint = constraintForView(view);
    for (const status of constraint.statuses ?? []) {
      assert.ok((SUPPORT_STATUSES as readonly string[]).includes(status), `${view} names unknown status ${status}`);
    }
  }
  for (const sort of SUPPORT_SORTS) {
    assert.ok(SUPPORT_SORT_LABELS[sort], `${sort} has no label`);
    for (const key of SUPPORT_SORT_COLUMNS[sort]) {
      assert.ok(
        viewColumns.has(key.column) || MIGRATION_SQL.includes(`${key.column},`) || MIGRATION_SQL.includes(`as ${key.column}`),
        `sort ${sort} orders by ${key.column}, which the view does not expose`
      );
    }
  }
});

test("the default view is the one that answers the page's only question", () => {
  assert.equal(emptySupportFilters().view, "needs_attention");
  assert.deepEqual(constraintForView("needs_attention").statuses, ["open", "waiting_on_staff"]);
  assert.equal(constraintForView("mine").assigned, "me");
  assert.equal(constraintForView("unassigned").assigned, "unassigned");
  assert.equal(constraintForView("all").statuses, null);
});

test("the default sort puts unresolved first, then urgency, then freshest activity", () => {
  /*
   * Sorting only by "latest message" — the obvious choice — puts a resolved
   * thread somebody thanked you on above an unanswered question from this
   * morning.
   */
  assert.deepEqual(
    SUPPORT_SORT_COLUMNS.attention.map((key) => key.column),
    ["is_unresolved", "priority_rank", "last_message_at"]
  );
});

test("every list ends on a tiebreaker, so paging cannot show a row twice", () => {
  for (const path of [
    "src/app/api/staff/support/route.ts",
    "src/app/api/support/conversations/route.ts",
    "src/app/api/support/conversations/[id]/route.ts",
  ]) {
    assert.match(readCode(path), /\.order\("id"/, `${path} pages without a tiebreaker`);
  }
});

test("the inbox filters, sorts and pages in Postgres, not in the browser", () => {
  const source = readCode("src/app/api/staff/support/route.ts");
  assert.match(source, /\.range\(offset, offset \+ filters\.pageSize - 1\)/);
  assert.match(source, /count: "exact"/);
  const page = readCode("src/app/staff/support/page.tsx");
  assert.ok(!/\.filter\(\(row\)|\.sort\(\(a, b\)/.test(page), "the inbox page filters or sorts in the browser");
});

test("a count that could not be computed is null, never zero", () => {
  // "Nothing needs attention" and "we could not find out" must not look
  // identical — this codebase has shipped that confusion on four pages already.
  const source = readCode("src/app/api/staff/support/route.ts");
  assert.match(source, /return error \? null : value \?\? 0/);
  assert.match(read("src/app/staff/support/page.tsx"), /count === null \? "—" : count/);
});

// ---------------------------------------------------------------------------
// Integration with the user and order workspaces
// ---------------------------------------------------------------------------

test("the user workspace links to the inbox rather than re-implementing it", () => {
  const source = readCode("src/components/staff/UserWorkspaceTabs.tsx");
  const panel = source.slice(source.indexOf("export function SupportPanel"));
  assert.match(panel, /\/api\/staff\/support\?customer=\$\{userId\}/, "the panel does not reuse the inbox endpoint");
  assert.ok(!panel.includes("support_messages"), "the user workspace reads the message table");
  // A list, not a second copy of the thread.
  assert.ok(!/\.body\b/.test(panel), "the user workspace renders message bodies");
  assert.match(panel, /\/staff\/support\/\$\{row\.id\}/);
});

test("the order workspace shows related conversations and links to them", () => {
  const source = readCode("src/components/staff/OrderSupportConversations.tsx");
  assert.match(source, /\/api\/staff\/support\?order=\$\{orderId\}/);
  assert.match(source, /\/staff\/support\/\$\{item\.id\}/);
  // A viewer without the permission sees nothing rather than a red box on
  // somebody else's page.
  assert.match(source, /res\.status === 403/);
  assert.match(source, /kind: "hidden"/);
  assert.ok(!/\.body\b/.test(source), "the order workspace renders message bodies");
});

test("the customer's account support pages exist and are reachable from search", () => {
  assert.ok(read("src/app/account/support/page.tsx").length > 100);
  assert.ok(read("src/app/account/support/[id]/page.tsx").length > 100);
  const search = read("src/lib/siteSearch.ts");
  assert.match(search, /href: "\/support"/);
  assert.match(search, /href: "\/account\/support"/);
  assert.ok(!/href: "\/contact"/.test(search), "site search still points at the redirect");
});

// ---------------------------------------------------------------------------
// Small things that make a page look tended
// ---------------------------------------------------------------------------

test("relative ages are pluralized, and never read \"1 months ago\"", () => {
  const now = new Date("2026-08-10T12:00:00.000Z");
  const ago = (seconds: number) => formatSupportAge(new Date(now.getTime() - seconds * 1000).toISOString(), now);
  assert.equal(ago(5), "just now");
  assert.equal(ago(60), "1 minute ago");
  assert.equal(ago(120), "2 minutes ago");
  assert.equal(ago(3600), "1 hour ago");
  assert.equal(ago(86400), "1 day ago");
  assert.equal(ago(86400 * 40), "1 month ago");
  assert.equal(ago(86400 * 70), "2 months ago");
  assert.equal(ago(86400 * 400), "1 year ago");
  assert.equal(formatSupportAge(null), "—");
  assert.equal(formatSupportAge("not a date"), "—");
});

test("an excerpt is single-line, bounded, and ellipsised", () => {
  assert.equal(messageExcerpt("one\ntwo   three"), "one two three");
  const long = messageExcerpt("z".repeat(500), 50);
  assert.equal(long.length, 50);
  assert.ok(long.endsWith("…"));
  assert.equal(messageExcerpt("short", 50), "short");
});
