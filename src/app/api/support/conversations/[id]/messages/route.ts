import { NextRequest, NextResponse } from "next/server";

import { getActorAccessFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { consumeRateLimit, RATE_LIMITS, rateLimitMessage } from "@/lib/commerce/rateLimit";
import {
  checkMessage,
  MAX_SUPPORT_NAME_LENGTH,
  MIN_SUPPORT_REPLY_LENGTH,
  normalizeSingleLine,
  ownsConversation,
} from "@/lib/support/domain";
import {
  alertStaffOfCustomerReply,
  appendSupportMessage,
  isConversationId,
  loadConversation,
  logSupportFailure,
  recordConversationActivity,
} from "@/lib/support/server";
import { recordAuditEvent } from "@/lib/audit/events";

/**
 * A customer replying to their own conversation.
 *
 * ## What this route cannot do, structurally
 *
 * It has no path to `visibility: "internal"`. The value is a literal in the call
 * below, not something read from the body — so there is no request that can make
 * a customer's message a staff-only note, and no validation to get wrong. The
 * database refuses the pair as well (`support_messages_customer_never_internal`),
 * which is the second lock behind the first.
 *
 * It also cannot change status, priority or assignment. Those are not fields it
 * reads. The status *does* move — from `waiting_on_customer` to
 * `waiting_on_staff`, or from `resolved` back to `waiting_on_staff` — but that
 * transition is computed by the state machine from the fact that a customer
 * wrote, not taken from what they sent.
 */

export const runtime = "nodejs";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await getActorAccessFromRequest(req);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  if (!isConversationId(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const conversation = await loadConversation(id);
  // Not-found and not-yours answer identically, so this cannot be used to
  // discover which conversation ids exist.
  if (!conversation || !ownsConversation(conversation, actor.userId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (conversation.status === "closed") {
    return NextResponse.json(
      { error: "This conversation is closed. Start a new request and we will pick it up." },
      { status: 409 }
    );
  }

  const limit = await consumeRateLimit(RATE_LIMITS.supportReply, `user:${actor.userId}`);
  if (!limit.allowed) return NextResponse.json({ error: rateLimitMessage(limit) }, { status: 429 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const message = checkMessage(body?.body, MIN_SUPPORT_REPLY_LENGTH);
  if (!message.ok) return NextResponse.json({ error: message.error }, { status: 400 });

  const { data: account } = await routeServiceClient.auth.admin.getUserById(actor.userId);
  const authorLabel =
    normalizeSingleLine(account.user?.user_metadata?.display_name, MAX_SUPPORT_NAME_LENGTH) ||
    conversation.requester_label;

  const appended = await appendSupportMessage({
    conversationId: id,
    authorType: "customer",
    authorUserId: actor.userId,
    authorLabel,
    // A literal, never a request value. See the header.
    visibility: "customer",
    body: message.value,
    clientToken: body?.clientToken,
  });

  if (!appended.ok) return NextResponse.json({ error: appended.error }, { status: 500 });

  // A repeated submission is answered with the message it already created. The
  // conversation is not moved a second time and staff are not rung twice.
  if (appended.duplicate) {
    return NextResponse.json({ ok: true, duplicate: true, id: appended.message?.id ?? null });
  }

  const activity = await recordConversationActivity({
    conversation,
    authorType: "customer",
    visibility: "customer",
  });

  /*
   * A customer's own reply is audited as a *reopen* only when it actually
   * reopened something.
   *
   * Writing `support.reopened` for every reply would bury the handful of real
   * reopenings in a stream of ordinary messages — and the message itself is
   * already the authoritative record that they wrote. So the audit event exists
   * for the state change, and the state change alone.
   */
  if (activity.changed && (conversation.status === "resolved" || conversation.status === "waiting_on_customer")) {
    if (conversation.status === "resolved") {
      await recordAuditEvent({
        action: "support.reopened",
        actor: { kind: "customer", userId: actor.userId, label: authorLabel },
        entity: { type: "support_conversation", id: conversation.id, label: conversation.reference },
        related: { orderId: conversation.related_order_id },
        changes: { status: { before: conversation.status, after: activity.status } },
        summary: `${conversation.reference} reopened by the customer`,
        source: "api",
      });
    }
  }

  await alertStaffOfCustomerReply({ conversation, messageId: appended.message.id }).catch((error: unknown) =>
    logSupportFailure("reply.alert", error)
  );

  return NextResponse.json({ ok: true, id: appended.message.id, status: activity.status });
}
