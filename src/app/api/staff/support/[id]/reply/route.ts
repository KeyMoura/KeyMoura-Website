import { NextRequest, NextResponse } from "next/server";

import { requirePermission } from "@/lib/api/routeAuth";
import { checkMessage, MIN_SUPPORT_REPLY_LENGTH } from "@/lib/support/domain";
import {
  appendSupportMessage,
  isConversationId,
  loadConversation,
  logSupportFailure,
  notifyCustomerOfReply,
  recordConversationActivity,
  recordSupportAudit,
  STAFF_REPLY_LABEL,
} from "@/lib/support/server";
import { resolveActorLabel } from "@/lib/audit/events";

/**
 * A staff reply — the one thing on this feature that reaches a customer.
 *
 * ## Why this is its own file
 *
 * A reply and an internal note are two endpoints, not one endpoint with a
 * boolean. The boolean version has a single branch deciding whether to email a
 * customer, which is exactly the line that gets inverted, negated or moved
 * during a refactor — and the failure mode is a staff-only note about a customer
 * arriving in that customer's inbox. Here there is no branch: this file always
 * sends, `notes/route.ts` never does, and neither contains the other's code.
 *
 * ## What is recorded
 *
 * `support.staff_replied`, carrying the message id and its length. Not its body:
 * `support_messages` is append-only and is the authoritative history, and
 * copying a reply into `audit_logs` would double the places it has to be
 * protected while making the audit log the largest table in the database.
 */

export const runtime = "nodejs";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "support.reply");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await context.params;
  if (!isConversationId(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const conversation = await loadConversation(id);
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const message = checkMessage(body?.body, MIN_SUPPORT_REPLY_LENGTH);
  if (!message.ok) return NextResponse.json({ error: message.error }, { status: 400 });

  const staffLabel = (await resolveActorLabel(actor.userId)) ?? STAFF_REPLY_LABEL;

  const appended = await appendSupportMessage({
    conversationId: id,
    authorType: "staff",
    authorUserId: actor.userId,
    // The staff member's real name is stored — this is the internal record of
    // who wrote it, and "who said that to the customer" is a question the shop
    // must be able to answer. The *customer* API replaces it with "KeyMoura"
    // when it serializes the thread.
    authorLabel: staffLabel,
    // A literal. There is no request field that can make this internal.
    visibility: "customer",
    body: message.value,
    clientToken: body?.clientToken,
  });

  if (!appended.ok) return NextResponse.json({ error: appended.error }, { status: 500 });

  /*
   * One send, one message, however many times the request arrives.
   *
   * The email is keyed on the message id. A double click carrying the same
   * client token collapses to one row, so it collapses to one key, so it
   * collapses to one email — the mechanism `order_messages` already uses, for
   * the reason recorded in pass 11: the delivery used to be keyed on a fresh id
   * per click and therefore was a fresh key per click.
   */
  if (appended.duplicate) {
    return NextResponse.json({ ok: true, duplicate: true, id: appended.message?.id ?? null });
  }

  const activity = await recordConversationActivity({
    conversation,
    authorType: "staff",
    visibility: "customer",
  });

  const audited = await recordSupportAudit({
    action: "support.staff_replied",
    actorUserId: actor.userId,
    actorRole: actor.role,
    conversation,
    summary: `Replied on ${conversation.reference}`,
    metadata: { message_id: appended.message.id, message_length: message.value.length },
    changes:
      activity.changed && activity.status !== conversation.status
        ? { status: { before: conversation.status, after: activity.status } }
        : undefined,
  });

  // The email is sent after the message is durably stored and after the audit
  // event, so a customer is never told something the shop has no record of.
  await notifyCustomerOfReply({
    conversation,
    messageId: appended.message.id,
    body: message.value,
  }).catch((error: unknown) => logSupportFailure("reply.email", error));

  return NextResponse.json({
    ok: true,
    id: appended.message.id,
    status: activity.status,
    // Surfaced rather than swallowed: an unlogged change must not be reported as
    // a clean success. Same contract the order route uses.
    auditFailed: !audited,
  });
}
