/**
 * The support conversation model — one definition, read by everything.
 *
 * Pure and dependency-free (no React, no `next/*`, no Supabase), so the customer
 * page, the staff workspace, four API routes and the tests all read the **same**
 * rules rather than four readings of a paragraph. This mirrors `orderLifecycle`,
 * `userAccess` and `audit/actions`, and for the same reason: a status that means
 * one thing in a route and another in a dropdown is how a state machine rots.
 *
 * ## Why a new model rather than a wider `order_messages`
 *
 * KeyMoura already has a conversation: `order_messages` carries `is_internal`, a
 * client-token dedup and an email fan-out. It is also **order-scoped** — its
 * `order_id` is `NOT NULL` and every RLS policy and route keys off the order. It
 * cannot express a question that is not about an order, and it has no place to
 * put a subject, a category, a status, an owner or a priority. Widening it would
 * have meant inventing a conversation entity anyway *and* rewriting the policies
 * of a live table with rows in it.
 *
 * So the order thread stays exactly what it is — the back-and-forth on one
 * order — and a support conversation *links* to an order rather than replacing
 * that thread. The two are related, never merged.
 *
 * ## The one rule that is not negotiable
 *
 * A message is either customer-visible or staff-only, decided by one column, and
 * every read path that a customer can reach filters on it **in the query** — not
 * after it, and not in a component. A note that is loaded and then hidden is one
 * refactor away from being a note that is loaded and then shown.
 */

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * What the conversation is about, chosen by the customer at submission.
 *
 * Deliberately eight broad buckets rather than a taxonomy. A customer picking a
 * category is doing routing, not filing: the value of the field is that a staff
 * member can filter the inbox down to "returns" on a busy morning, and that
 * stops being true the moment the list is long enough to need scrolling.
 */
export const SUPPORT_CATEGORIES = [
  "general",
  "order",
  "custom_project",
  "production",
  "shipping",
  "return",
  "account",
  "other",
] as const;

export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const SUPPORT_CATEGORY_LABELS: Readonly<Record<SupportCategory, string>> = {
  general: "General question",
  order: "An order",
  custom_project: "A custom project",
  production: "Something being made",
  shipping: "Shipping or pickup",
  return: "Return or refund",
  account: "My account",
  other: "Something else",
};

/** The one-liner under each option on `/support`. Written for a customer, not staff. */
export const SUPPORT_CATEGORY_HELP: Readonly<Record<SupportCategory, string>> = {
  general: "Anything before you order — materials, sizes, what is possible.",
  order: "An order you have placed: changes, timing, or a question about it.",
  custom_project: "A one-off piece, a quote, or a design you want made.",
  production: "Something already in the workshop.",
  shipping: "Delivery, collection, tracking, or an address change.",
  return: "Sending something back, or money you are owed.",
  account: "Signing in, your details, or your order history.",
  other: "If none of the above fits.",
};

/** Short label for a staff list, where the column is narrow and the row is scanned. */
export const SUPPORT_CATEGORY_SHORT: Readonly<Record<SupportCategory, string>> = {
  general: "General",
  order: "Order",
  custom_project: "Custom",
  production: "Production",
  shipping: "Shipping",
  return: "Return",
  account: "Account",
  other: "Other",
};

export function isSupportCategory(value: unknown): value is SupportCategory {
  return typeof value === "string" && (SUPPORT_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Categories that imply an order, used only to *suggest* attaching one.
 *
 * It is a prompt, never a requirement: a customer asking about a return they
 * have not been able to find is exactly the person who cannot select the order.
 */
export const ORDER_LEANING_CATEGORIES: readonly SupportCategory[] = [
  "order",
  "production",
  "shipping",
  "return",
];

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Five states, and the distinction between the first two is real.
 *
 * - `open` — nobody at KeyMoura has replied yet. First response outstanding.
 * - `waiting_on_staff` — we replied, the customer came back. Follow-up outstanding.
 * - `waiting_on_customer` — the ball is with them; we asked something.
 * - `resolved` — answered. A customer reply reopens it.
 * - `closed` — done, and a customer reply does not reopen it.
 *
 * `open` and `waiting_on_staff` are both "ours to answer", which is why
 * {@link isUnresolvedStatus} exists and why the inbox chips group them. They are
 * kept apart because "nobody has ever answered this person" and "this is the
 * fourth round of a conversation" are different failures and want different
 * urgency. Any state the machine cannot produce is not offered by the UI.
 */
export const SUPPORT_STATUSES = [
  "open",
  "waiting_on_staff",
  "waiting_on_customer",
  "resolved",
  "closed",
] as const;

export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export const SUPPORT_STATUS_LABELS: Readonly<Record<SupportStatus, string>> = {
  open: "Open",
  waiting_on_staff: "Waiting on staff",
  waiting_on_customer: "Waiting on customer",
  resolved: "Resolved",
  closed: "Closed",
};

/** What each state actually means, so a chip cannot invent its own wording. */
export const SUPPORT_STATUS_MEANING: Readonly<Record<SupportStatus, string>> = {
  open: "Nobody has replied yet.",
  waiting_on_staff: "The customer has replied and is waiting on us.",
  waiting_on_customer: "We have replied and are waiting on them.",
  resolved: "Answered. A new customer message reopens it.",
  closed: "Finished. A new customer message does not reopen it.",
};

/** What the *customer* is told, which is not the same sentence. */
export const SUPPORT_STATUS_CUSTOMER_LABELS: Readonly<Record<SupportStatus, string>> = {
  open: "Received",
  waiting_on_staff: "With our team",
  waiting_on_customer: "Waiting for you",
  resolved: "Resolved",
  closed: "Closed",
};

export function isSupportStatus(value: unknown): value is SupportStatus {
  return typeof value === "string" && (SUPPORT_STATUSES as readonly string[]).includes(value);
}

/** True when this conversation is still somebody's job. */
export function isUnresolvedStatus(status: SupportStatus): boolean {
  return status === "open" || status === "waiting_on_staff" || status === "waiting_on_customer";
}

/** True when it is specifically *our* job right now. */
export function needsStaffAttention(status: SupportStatus): boolean {
  return status === "open" || status === "waiting_on_staff";
}

/**
 * Sort weight for the inbox. Lower is more urgent.
 *
 * Mirrored by `status_rank` in `staff_support_queue`, and
 * `tests/support-system.test.ts` asserts the two agree — the ordering a staff
 * member sees is decided in Postgres, and a second opinion in TypeScript that
 * disagreed would be a list that reorders itself when you page.
 */
export const SUPPORT_STATUS_RANK: Readonly<Record<SupportStatus, number>> = {
  open: 0,
  waiting_on_staff: 1,
  waiting_on_customer: 2,
  resolved: 3,
  closed: 4,
};

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

export const SUPPORT_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

export const SUPPORT_PRIORITY_LABELS: Readonly<Record<SupportPriority, string>> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export function isSupportPriority(value: unknown): value is SupportPriority {
  return typeof value === "string" && (SUPPORT_PRIORITIES as readonly string[]).includes(value);
}

/** Lower is more urgent. Matches `priority_rank` in the queue view. */
export const SUPPORT_PRIORITY_RANK: Readonly<Record<SupportPriority, number>> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/**
 * Priority is set by staff and **never** by the customer.
 *
 * A form field that lets the sender mark their own message Urgent trains every
 * sender to mark it Urgent, and the field stops carrying information on the day
 * it would first have been useful. Exported as a named constant so the intent is
 * greppable and so the test asserting it has something to point at.
 */
export const CUSTOMER_MAY_SET_PRIORITY = false;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Who wrote it. `system` is this application recording a fact, never a person. */
export const SUPPORT_AUTHOR_TYPES = ["customer", "staff", "system"] as const;
export type SupportAuthorType = (typeof SUPPORT_AUTHOR_TYPES)[number];

/**
 * Who may read it. Two values, because there is no third audience and a third
 * value would be an invitation to invent one.
 */
export const SUPPORT_VISIBILITIES = ["customer", "internal"] as const;
export type SupportVisibility = (typeof SUPPORT_VISIBILITIES)[number];

export function isSupportVisibility(value: unknown): value is SupportVisibility {
  return typeof value === "string" && (SUPPORT_VISIBILITIES as readonly string[]).includes(value);
}

export function isSupportAuthorType(value: unknown): value is SupportAuthorType {
  return typeof value === "string" && (SUPPORT_AUTHOR_TYPES as readonly string[]).includes(value);
}

/**
 * The combinations that are allowed to exist.
 *
 * A customer cannot write a staff-only note — not because the UI does not offer
 * it, but because the pair is refused here, refused by the route, and refused by
 * a `CHECK` constraint in the database. The interesting direction is the one
 * that is *permitted*: staff may write a customer-visible reply, and that is the
 * whole point of the feature, so the check is about the customer's side.
 */
export function isAllowedMessageShape(
  authorType: SupportAuthorType,
  visibility: SupportVisibility
): boolean {
  if (authorType === "customer") return visibility === "customer";
  return true;
}

export const MAX_SUPPORT_SUBJECT_LENGTH = 140;
export const MIN_SUPPORT_SUBJECT_LENGTH = 3;
export const MAX_SUPPORT_MESSAGE_LENGTH = 5000;
export const MIN_SUPPORT_MESSAGE_LENGTH = 10;
/** A reply to an existing thread may be shorter than an opening message. "Yes, thanks" is a complete reply. */
export const MIN_SUPPORT_REPLY_LENGTH = 1;
export const MAX_SUPPORT_NAME_LENGTH = 100;
export const MAX_SUPPORT_EMAIL_LENGTH = 254;

export type FieldCheck = { ok: true; value: string } | { ok: false; error: string };

/** Collapses runs of whitespace and trims. Never strips characters — that is the renderer's job. */
export function normalizeSingleLine(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** Trims, caps, and normalizes line endings. The body keeps its paragraphs. */
export function normalizeBody(value: unknown, max = MAX_SUPPORT_MESSAGE_LENGTH): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim().slice(0, max);
}

export function checkSubject(value: unknown): FieldCheck {
  const subject = normalizeSingleLine(value, MAX_SUPPORT_SUBJECT_LENGTH);
  if (subject.length < MIN_SUPPORT_SUBJECT_LENGTH) {
    return { ok: false, error: "Give your message a subject." };
  }
  return { ok: true, value: subject };
}

export function checkMessage(value: unknown, min = MIN_SUPPORT_MESSAGE_LENGTH): FieldCheck {
  const body = normalizeBody(value);
  if (body.length < min) {
    return {
      ok: false,
      error:
        min > 1
          ? `Tell us a little more — at least ${min} characters.`
          : "Write a message first.",
    };
  }
  return { ok: true, value: body };
}

/**
 * Deliberately loose. This decides "is this shaped like an address we can reply
 * to", not "does this mailbox exist" — the second question is answered by the
 * email either arriving or bouncing, and a stricter pattern here only ever
 * refuses real addresses.
 */
const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function checkEmail(value: unknown): FieldCheck {
  const email = normalizeSingleLine(value, MAX_SUPPORT_EMAIL_LENGTH).toLowerCase();
  if (!EMAILISH.test(email)) return { ok: false, error: "Enter an email address we can reply to." };
  return { ok: true, value: email };
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

/**
 * Where a conversation lands when the customer writes.
 *
 * `closed` is the one state a customer message does not move, and that is the
 * entire difference between it and `resolved`. Without a state that stays put
 * there is no way to end a thread that somebody keeps replying to, and "closed"
 * would be a label that lasts until the next message.
 */
export function statusAfterCustomerMessage(current: SupportStatus): SupportStatus {
  if (current === "closed") return "closed";
  if (current === "open") return "open";
  return "waiting_on_staff";
}

/**
 * Where it lands when staff post a **customer-visible** reply.
 *
 * An internal note moves nothing — see {@link statusAfterInternalNote}. Writing
 * a note to yourself is not an answer to the customer, and a status that said
 * otherwise would put a thread in "waiting on customer" while the customer is
 * still waiting on us.
 */
export function statusAfterStaffReply(current: SupportStatus): SupportStatus {
  if (current === "closed") return "closed";
  return "waiting_on_customer";
}

/** Internal notes never change the status. Stated as a function so a test can hold it. */
export function statusAfterInternalNote(current: SupportStatus): SupportStatus {
  return current;
}

/**
 * Whether a staff member may move a conversation from one status to another.
 *
 * Every transition between the five states is permitted **except** a no-op,
 * which is refused rather than silently accepted: a "change" that changes
 * nothing would write an audit event saying `open → open` and a notification
 * about it. This is a deliberate design: there is no partial order to enforce
 * here, because "reopen a closed conversation" and "close an open one" are both
 * legitimate and a staff member is the right person to decide.
 */
export function canChangeStatus(
  current: SupportStatus,
  next: SupportStatus
): { allowed: true } | { allowed: false; error: string } {
  if (current === next) {
    return { allowed: false, error: `This conversation is already ${SUPPORT_STATUS_LABELS[next].toLowerCase()}.` };
  }
  return { allowed: true };
}

/** The timestamps a status implies, so the route and the CHECK constraint agree. */
export function statusTimestamps(next: SupportStatus, now: string): {
  resolved_at: string | null;
  closed_at: string | null;
} {
  return {
    resolved_at: next === "resolved" ? now : null,
    closed_at: next === "closed" ? now : null,
  };
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/**
 * `SUP-0001`.
 *
 * Generated by a Postgres sequence and a `BEFORE INSERT` trigger, exactly like
 * `KM-0004` — which is what makes it concurrency-safe. Two simultaneous
 * submissions take two `nextval`s; nothing reads a maximum and adds one.
 *
 * The uuid stays the real identifier and is what URLs carry. The reference is
 * for a person to read out loud on a phone, and the two never compete: a route
 * takes the id, the screen shows the reference.
 */
export const SUPPORT_REFERENCE_PREFIX = "SUP-";

const REFERENCE_PATTERN = /^sup-?\d{1,10}$/i;

export function looksLikeSupportReference(value: string): boolean {
  return REFERENCE_PATTERN.test(String(value ?? "").trim());
}

/**
 * `sup12`, `SUP-12` and `sup-0012` all normalize to the stored `SUP-0012`.
 *
 * Staff type references from memory and from a printed email, and the two do not
 * agree about the dash or the leading zeros. `null` for anything that is not a
 * reference keeps the caller's branch honest — the same contract
 * `normalizeOrderNumber` has.
 */
export function normalizeSupportReference(value: string): string | null {
  const raw = String(value ?? "").trim();
  if (!REFERENCE_PATTERN.test(raw)) return null;
  return `${SUPPORT_REFERENCE_PREFIX}${raw.replace(/^sup-?/i, "").padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Where a customer reads their own conversation. */
export function customerSupportPath(conversationId: string): string {
  return `/account/support/${conversationId}`;
}

/** Where staff work it. */
export function staffSupportPath(conversationId: string): string {
  return `/staff/support/${conversationId}`;
}

// ---------------------------------------------------------------------------
// Requester identity
// ---------------------------------------------------------------------------

/**
 * Who a conversation belongs to.
 *
 * Ownership is `customer_id` equality and nothing else — the rule pass 21
 * established for the user workspace, restated here because this is the second
 * place it could quietly be broken. A guest conversation whose `guest_email`
 * happens to match an account is **not** that account's conversation: email
 * equality is a claim anybody who can type can make, and honouring it would let
 * a stranger read a customer's support history by signing up with their address.
 */
export function ownsConversation(
  conversation: { customer_id: string | null },
  viewerUserId: string | null
): boolean {
  return Boolean(viewerUserId) && conversation.customer_id === viewerUserId;
}

/**
 * A short, safe summary of a message for an email preview.
 *
 * Single line, capped, ellipsised. Never used for an internal note: the
 * customer-facing email builder takes only customer-visible messages, and
 * `tests/support-system.test.ts` asserts the internal path has no email call at
 * all rather than trusting this function to be given the right input.
 */
export function messageExcerpt(body: string, max = 220): string {
  const value = String(body ?? "").replace(/\s+/g, " ").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * "2 hours ago". Absolute below a minute, and never "1 months ago" — the
 * singular/plural bug the pass-21 walkthrough found in the equivalent helper.
 */
export function formatSupportAge(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) return "just now";
  const units: readonly [number, string][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
    [604800, "week"],
    [2592000, "month"],
    [31536000, "year"],
  ];
  let chosen = units[0];
  for (const unit of units) if (seconds >= unit[0]) chosen = unit;
  const count = Math.floor(seconds / chosen[0]);
  return `${count} ${chosen[1]}${count === 1 ? "" : "s"} ago`;
}
