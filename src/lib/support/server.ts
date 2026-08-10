import "server-only";

import { routeServiceClient } from "@/lib/api/routeAuth";
import { sendCommerceEmail, getCommerceEmailConfig } from "@/lib/commerceEmail";
import { raiseOperationalAlert } from "@/lib/comms/operationalAlerts";
import { createNotification } from "@/lib/notifications";
import { recordAuditEvent, resolveActorLabel } from "@/lib/audit/events";
import type { ChangeSet } from "@/lib/audit/diff";
import {
  customerSupportPath,
  messageExcerpt,
  staffSupportPath,
  statusAfterCustomerMessage,
  statusAfterStaffReply,
  statusTimestamps,
  type SupportAuthorType,
  type SupportCategory,
  type SupportPriority,
  type SupportStatus,
  type SupportVisibility,
} from "./domain";

/**
 * The server side of support: one place that writes a message, one place that
 * moves a conversation, and one place that decides who is told.
 *
 * ## The rule this module exists to hold
 *
 * **An internal note never causes an email.** That is not enforced by passing a
 * flag carefully — it is enforced structurally: {@link appendSupportMessage}
 * sends nothing at all, and the only call to `sendCommerceEmail` for a reply
 * lives in {@link notifyCustomerOfReply}, which the internal-note route does not
 * call. There is no `if (!internal) send(...)` to get wrong, because there is no
 * shared branch.
 *
 * ## Transactional integrity, stated plainly
 *
 * The same shape pass 20 established. The Supabase REST client has no
 * cross-statement transaction, so: the message row is written first, the
 * conversation is moved only after that insert is confirmed, and the audit event
 * is written only after the mutation reports an affected row. A failed audit
 * write is surfaced to the caller rather than swallowed. The residual gap —
 * mutation committed, process dies before the audit insert — is the same one
 * recorded in the ledger and is not papered over here.
 */

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/**
 * Named columns, never `*`.
 *
 * `select("*")` here would ship the next column somebody adds to whichever
 * surface happened to be reading — which is how `guest_token_hash` would have
 * reached a browser on the order pages if that file had not made the same rule.
 */
export const CONVERSATION_COLUMNS =
  "id,reference,subject,category,status,priority,customer_id,guest_email,guest_name," +
  "requester_label,requester_email,related_order_id,assigned_to,assigned_to_label,assigned_at," +
  "created_at,updated_at,last_message_at,last_customer_message_at,last_staff_message_at," +
  "resolved_at,closed_at,source";

export const MESSAGE_COLUMNS =
  "id,conversation_id,author_type,author_user_id,author_label,visibility,body,created_at";

export type ConversationRow = {
  id: string;
  reference: string;
  subject: string;
  category: SupportCategory;
  status: SupportStatus;
  priority: SupportPriority;
  customer_id: string | null;
  guest_email: string | null;
  guest_name: string | null;
  requester_label: string;
  requester_email: string | null;
  related_order_id: string | null;
  assigned_to: string | null;
  assigned_to_label: string | null;
  assigned_at: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  last_customer_message_at: string | null;
  last_staff_message_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  source: string;
};

export type MessageRow = {
  id: string;
  conversation_id: string;
  author_type: SupportAuthorType;
  author_user_id: string | null;
  author_label: string;
  visibility: SupportVisibility;
  body: string;
  created_at: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A uuid, whatever it identifies. Route params arrive as strings and are never trusted to be ids. */
export function isUuid(value: unknown): boolean {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isConversationId(value: unknown): boolean {
  return isUuid(value);
}

/** Log shape borrowed from the production and audit modules: SQLSTATE and message, never `details`. */
export function logSupportFailure(operation: string, error: unknown): void {
  console.error(`[support] ${operation} failed`, {
    code: (error as { code?: string })?.code ?? null,
    message: (error as { message?: string })?.message?.slice(0, 300) ?? null,
  });
}

export async function loadConversation(id: string): Promise<ConversationRow | null> {
  if (!isConversationId(id)) return null;
  const { data, error } = await routeServiceClient
    .from("support_conversations")
    .select(CONVERSATION_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    logSupportFailure("conversation.load", error);
    return null;
  }
  return (data as unknown as ConversationRow | null) ?? null;
}

// ---------------------------------------------------------------------------
// Writing a message
// ---------------------------------------------------------------------------

export type AppendMessageInput = {
  conversationId: string;
  authorType: SupportAuthorType;
  authorUserId: string | null;
  authorLabel: string;
  visibility: SupportVisibility;
  body: string;
  /**
   * Collapses a double-submitted form into one row.
   *
   * Typed `unknown` rather than `string | null` on purpose: it comes straight
   * off a request body, and a signature promising it is already a string is a
   * promise the type system cannot keep. {@link sanitizeToken} is where it
   * becomes one.
   */
  clientToken?: unknown;
};

export type AppendMessageResult =
  | { ok: true; message: MessageRow; duplicate: false }
  | { ok: true; message: MessageRow | null; duplicate: true }
  | { ok: false; error: string };

/** Anything outside this alphabet has no business being an identifier that reaches a unique index. */
function sanitizeToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return clean || null;
}

/**
 * Appends one message. **Sends nothing and tells nobody** — deliberately.
 *
 * Notification is the caller's decision because the two callers make opposite
 * ones, and a shared "should I email?" branch inside here is precisely the line
 * that eventually gets inverted. See the module header.
 */
export async function appendSupportMessage(input: AppendMessageInput): Promise<AppendMessageResult> {
  const token = sanitizeToken(input.clientToken);

  const { data, error } = await routeServiceClient
    .from("support_messages")
    .insert({
      conversation_id: input.conversationId,
      author_type: input.authorType,
      author_user_id: input.authorUserId,
      author_label: input.authorLabel.slice(0, 120),
      visibility: input.visibility,
      body: input.body,
      client_token: token,
    })
    .select(MESSAGE_COLUMNS)
    .single();

  if (error) {
    // 23505 is the unique violation on `(conversation_id, client_token)`: this
    // exact send already landed. Answering ok is correct — the caller asked for
    // the message to exist, and it does.
    if (token && (error as { code?: string }).code === "23505") {
      const { data: original } = await routeServiceClient
        .from("support_messages")
        .select(MESSAGE_COLUMNS)
        .eq("conversation_id", input.conversationId)
        .eq("client_token", token)
        .maybeSingle();
      return { ok: true, duplicate: true, message: (original as unknown as MessageRow | null) ?? null };
    }
    logSupportFailure("message.insert", error);
    return { ok: false, error: "Could not save that message." };
  }

  return { ok: true, duplicate: false, message: data as unknown as MessageRow };
}

/**
 * Moves the conversation's activity clocks and, where the state machine says so,
 * its status.
 *
 * Written as one guarded update rather than a read-then-write: the `.eq("status",
 * expected)` form is what makes two staff members replying at the same moment
 * produce one transition and one refusal instead of two silent overwrites — the
 * stale-state pattern the order workspace already uses.
 */
export async function recordConversationActivity(input: {
  conversation: ConversationRow;
  authorType: SupportAuthorType;
  visibility: SupportVisibility;
  at?: string;
}): Promise<{ status: SupportStatus; changed: boolean }> {
  const now = input.at ?? new Date().toISOString();
  const current = input.conversation.status;

  // An internal note is activity for the *inbox* but not for the state machine:
  // a note to yourself is not an answer to the customer, and a status saying
  // otherwise would park a thread in "waiting on customer" while the customer is
  // still waiting on us.
  const nextStatus =
    input.visibility === "internal"
      ? current
      : input.authorType === "customer"
        ? statusAfterCustomerMessage(current)
        : input.authorType === "staff"
          ? statusAfterStaffReply(current)
          : current;

  const patch: Record<string, unknown> = { last_message_at: now };
  if (input.authorType === "customer") patch.last_customer_message_at = now;
  if (input.authorType === "staff" && input.visibility === "customer") patch.last_staff_message_at = now;

  if (nextStatus !== current) {
    patch.status = nextStatus;
    Object.assign(patch, statusTimestamps(nextStatus, now));
  }

  const { error } = await routeServiceClient
    .from("support_conversations")
    .update(patch)
    .eq("id", input.conversation.id);

  if (error) {
    logSupportFailure("conversation.activity", error);
    return { status: current, changed: false };
  }
  return { status: nextStatus, changed: nextStatus !== current };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * One audit event about one conversation.
 *
 * The entity label is the **reference**, not the uuid, so the audit log reads
 * `Replied to a customer · SUP-0007` rather than a hex string. `related_order_id`
 * is populated when the conversation is linked, which is what makes a support
 * event show up beside the order's own history.
 *
 * Bodies are never passed in. What is recorded about a message is its id and its
 * length; `support_messages` is append-only and is the authoritative history,
 * and copying a customer's words into `audit_logs` would double the number of
 * places they have to be protected — and would put an internal note into a table
 * read under a different permission.
 */
export async function recordSupportAudit(input: {
  action: string;
  actorUserId: string;
  actorRole?: string | null;
  conversation: Pick<ConversationRow, "id" | "reference" | "related_order_id">;
  changes?: ChangeSet;
  summary?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  const label = await resolveActorLabel(input.actorUserId);
  const result = await recordAuditEvent({
    action: input.action,
    actor: { kind: "staff", userId: input.actorUserId, role: input.actorRole ?? null, label },
    entity: { type: "support_conversation", id: input.conversation.id, label: input.conversation.reference },
    related: { orderId: input.conversation.related_order_id },
    changes: input.changes ?? {},
    summary: input.summary ?? null,
    metadata: input.metadata ?? {},
    source: "api",
  });
  return result.ok;
}

// ---------------------------------------------------------------------------
// Telling people
// ---------------------------------------------------------------------------

/** The label used for a staff member in a customer-visible message. */
export const STAFF_REPLY_LABEL = "KeyMoura";

/**
 * The customer-facing email for a staff reply. **The only send on this path.**
 *
 * No `orderId` is passed even when the conversation is linked to one: the sender
 * rewrites the button to the order page whenever it sees an order id and a
 * customer audience, and the customer's destination here is their support
 * conversation.
 *
 * A guest has no page to be sent to, so the body carries the reply itself and
 * the button falls back to `/support`. That is the honest consequence of a guest
 * having no durable credential for a conversation, and is recorded as a gap
 * rather than solved with an emailed link that would be one.
 */
export async function notifyCustomerOfReply(input: {
  conversation: ConversationRow;
  messageId: string;
  body: string;
}): Promise<void> {
  const to = input.conversation.requester_email;
  if (!to) return;

  await sendCommerceEmail({
    to,
    templateKey: "support_staff_reply",
    eventKey: `support-reply-${input.messageId}`,
    variables: {
      customer_name: input.conversation.requester_label,
      support_reference: input.conversation.reference,
      support_subject: input.conversation.subject,
      order_label: input.conversation.reference,
      // Generous rather than a teaser: for a guest this email *is* the channel,
      // and for an account holder it is their own conversation being sent back
      // to them. A five-word excerpt would make both worse.
      detail: messageExcerpt(input.body, 1500),
      status: "",
      price: "",
    },
    href: input.conversation.customer_id ? customerSupportPath(input.conversation.id) : "/support",
  });
}

/** The customer-facing email when a conversation is resolved. */
export async function notifyCustomerOfResolution(input: {
  conversation: ConversationRow;
  resolvedAt: string;
}): Promise<void> {
  const to = input.conversation.requester_email;
  if (!to) return;

  await sendCommerceEmail({
    to,
    templateKey: "support_resolved",
    // Keyed on the transition. A conversation resolved, reopened and resolved
    // again has genuinely been resolved twice and the customer should hear about
    // each — a key of just the conversation id would silently drop the second.
    eventKey: `support-resolved-${input.conversation.id}-${input.resolvedAt}`,
    variables: {
      customer_name: input.conversation.requester_label,
      support_reference: input.conversation.reference,
      support_subject: input.conversation.subject,
      order_label: input.conversation.reference,
      status: "",
      price: "",
    },
    href: input.conversation.customer_id ? customerSupportPath(input.conversation.id) : "/support",
  });
}

/** The acknowledgement, plus the staff alert address. Both keyed on the conversation, so a retried submit sends neither twice. */
export async function notifyNewConversation(conversation: ConversationRow): Promise<void> {
  const config = await getCommerceEmailConfig();

  await Promise.all([
    conversation.requester_email
      ? sendCommerceEmail({
          to: conversation.requester_email,
          templateKey: "support_received",
          eventKey: `support-received-${conversation.id}`,
          variables: {
            customer_name: conversation.requester_label,
            support_reference: conversation.reference,
            support_subject: conversation.subject,
            order_label: conversation.reference,
            status: "",
            price: "",
          },
          href: conversation.customer_id ? customerSupportPath(conversation.id) : "/support",
        })
      : Promise.resolve(),
    config.staffNotificationEmail
      ? sendCommerceEmail({
          to: config.staffNotificationEmail,
          templateKey: "support_staff_new",
          eventKey: `support-received-staff-${conversation.id}`,
          variables: {
            customer_name: conversation.requester_label,
            support_reference: conversation.reference,
            support_subject: conversation.subject,
            order_label: conversation.reference,
            status: "",
            price: "",
          },
          href: staffSupportPath(conversation.id),
        })
      : Promise.resolve(),
  ]);
}

/**
 * The in-app alert for staff.
 *
 * Fanned out by `support.view` through the existing deduplicating alert system —
 * there is deliberately no second notification path. The message is written for
 * staff and **never carries the customer's words**: a body in a preview line
 * appears in a bell, in a badge, and potentially in a push, which is three more
 * places a customer's message about a refund has to be protected.
 */
export async function alertStaffOfNewConversation(conversation: ConversationRow): Promise<void> {
  await raiseOperationalAlert({
    kind: "support.new_conversation",
    subjectId: conversation.id,
    message: `${conversation.reference} — a new support request about ${conversation.category.replaceAll("_", " ")}.`,
    actorUserId: conversation.customer_id,
  });
}

/** The same, for a reply on an existing conversation. Keyed on the message, so a retried send does not ring twice. */
export async function alertStaffOfCustomerReply(input: {
  conversation: ConversationRow;
  messageId: string;
}): Promise<void> {
  await raiseOperationalAlert({
    kind: "support.customer_replied",
    subjectId: input.conversation.id,
    discriminator: input.messageId,
    message: `${input.conversation.reference} — the customer replied.`,
    actorUserId: input.conversation.customer_id,
  });
}

/**
 * Assignment goes to one person, so it is not a permission fan-out.
 *
 * `raiseOperationalAlert` resolves recipients from a permission and excludes the
 * actor, which is exactly wrong here: the point is to tell one named person, and
 * that person may well be the actor taking the conversation themselves — in
 * which case they are told nothing, which is correct and is why the actor is
 * compared explicitly rather than left to the fan-out to drop.
 */
export async function notifyAssignee(input: {
  conversation: ConversationRow;
  assigneeUserId: string;
  actorUserId: string;
}): Promise<void> {
  if (input.assigneeUserId === input.actorUserId) return;
  await createNotification({
    recipientUserId: input.assigneeUserId,
    actorUserId: input.actorUserId,
    type: "order",
    bypassBlock: true,
    eventKey: `support.assigned:${input.conversation.id}:${input.assigneeUserId}`,
    payload: {
      // The reference and nothing else. The subject is the customer's own
      // wording, and a notification preview travels to a bell, a badge and
      // potentially a push — the conversation page is where their words are
      // read. Same rule `raiseOperationalAlert` holds for every other alert.
      title: "Support conversation assigned to you",
      message: `${input.conversation.reference} is now yours.`,
      href: staffSupportPath(input.conversation.id),
      alert_kind: "support.assigned",
      priority: "high",
    },
  });
}
