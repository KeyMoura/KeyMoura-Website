import { NextRequest, NextResponse } from "next/server";

import { requirePermission } from "@/lib/api/routeAuth";
import { checkMessage, MIN_SUPPORT_REPLY_LENGTH } from "@/lib/support/domain";
import {
  appendSupportMessage,
  isConversationId,
  loadConversation,
  recordConversationActivity,
  recordSupportAudit,
  STAFF_REPLY_LABEL,
} from "@/lib/support/server";
import { resolveActorLabel } from "@/lib/audit/events";

/**
 * An internal note on a support conversation.
 *
 * ## Read the imports
 *
 * There is no `sendCommerceEmail`, no `notifyCustomerOfReply`, and nothing that
 * transitively reaches the mailer. That is the safety property, and it is
 * structural rather than conditional: a note cannot reach a customer by a flag
 * being wrong, because there is no flag and no send. `tests/support-system.test.ts`
 * asserts this file's source contains no send call, so the property survives
 * somebody adding one by habit.
 *
 * ## What a note is
 *
 * Conversation-scoped, and deliberately **not** the same thing as a
 * `user_staff_notes` row. Those are about a person and outlive every
 * conversation; these are about this thread. Reusing that table would have meant
 * a note about "the customer disputes the quote on SUP-0007" living in a list
 * that is read from a completely different page under a different permission.
 *
 * ## The status does not move
 *
 * Writing a note to yourself is not an answer to the customer. A note that put
 * the thread into "waiting on customer" would park it there while the customer
 * is still waiting on us — which is how a support queue quietly loses somebody.
 */

export const runtime = "nodejs";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  // Writing a note takes the same permission as replying: both put a permanent,
  // uneditable claim on the record. Reading them takes only `support.view`.
  const actor = await requirePermission(req, "support.reply");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await context.params;
  if (!isConversationId(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const conversation = await loadConversation(id);
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const note = checkMessage(body?.body, MIN_SUPPORT_REPLY_LENGTH);
  if (!note.ok) return NextResponse.json({ error: note.error }, { status: 400 });

  const appended = await appendSupportMessage({
    conversationId: id,
    authorType: "staff",
    authorUserId: actor.userId,
    authorLabel: (await resolveActorLabel(actor.userId)) ?? STAFF_REPLY_LABEL,
    // A literal. This route has no path to `customer`.
    visibility: "internal",
    body: note.value,
    clientToken: body?.clientToken,
  });

  if (!appended.ok) return NextResponse.json({ error: appended.error }, { status: 500 });
  if (appended.duplicate) {
    return NextResponse.json({ ok: true, duplicate: true, id: appended.message?.id ?? null });
  }

  // The inbox's "last activity" moves — a colleague adding context is a reason
  // to look — but the state machine does not. See the header.
  await recordConversationActivity({ conversation, authorType: "staff", visibility: "internal" });

  const audited = await recordSupportAudit({
    action: "support.internal_note_added",
    actorUserId: actor.userId,
    actorRole: actor.role,
    conversation,
    summary: `Added an internal note on ${conversation.reference}`,
    // The note's id and length. Never its body: the note *is* the record, and
    // copying a customer's circumstances into `audit_logs` would double the
    // places they have to be protected and redacted for no gain.
    metadata: { note_id: appended.message.id, note_length: note.value.length },
  });

  return NextResponse.json({ ok: true, id: appended.message.id, auditFailed: !audited });
}
