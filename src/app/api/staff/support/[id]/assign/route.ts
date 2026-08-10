import { NextRequest, NextResponse } from "next/server";

import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { resolveStaffRecipients } from "@/lib/orderNotifications";
import {
  isConversationId,
  isUuid,
  loadConversation,
  logSupportFailure,
  notifyAssignee,
  recordSupportAudit,
} from "@/lib/support/server";
import { resolveActorLabel } from "@/lib/audit/events";

/**
 * Assigning a support conversation, or letting it go.
 *
 * ## Who may be assigned
 *
 * Only somebody who already holds `support.view`, resolved through the same
 * `resolveStaffRecipients` the notification fan-out uses — so "who can be
 * assigned" and "who is told about support" are the same list by construction
 * rather than by two definitions that agree today.
 *
 * That check is the substance of this route. Without it the assignee field is a
 * uuid column and a customer's id is a valid uuid: a conversation could be
 * assigned to the customer who opened it, which would put their name in the
 * staff inbox's "owner" column and send them a staff notification about their own
 * complaint.
 *
 * ## Stale-state protection
 *
 * `expectedAssignee` is required and the update is guarded on it. Two staff
 * members taking the same conversation at the same moment produce one owner and
 * one 409 — rather than the second silently becoming the owner while the first
 * is told they succeeded and starts working it.
 */

export const runtime = "nodejs";

const conflict = () =>
  NextResponse.json(
    { error: "Somebody else changed the assignment while you were looking at it. Reload and try again.", stale: true },
    { status: 409 }
  );

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "support.assign");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await context.params;
  if (!isConversationId(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const conversation = await loadConversation(id);
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const raw = body.assigneeId;
  const next = typeof raw === "string" && raw.trim() ? raw.trim() : null;

  if (next !== null && !isUuid(next)) {
    return NextResponse.json({ error: "That is not a staff member." }, { status: 400 });
  }
  if (next === conversation.assigned_to) {
    return NextResponse.json(
      { error: next ? "That person already owns this conversation." : "This conversation is already unassigned." },
      { status: 400 }
    );
  }

  // The guard is on the *expected* value, which the client sends back. Comparing
  // `undefined` to `null` would let a client omitting the field bypass it, so an
  // absent field is normalised to `null` only when the caller explicitly sent
  // null — anything else is a mismatch and 409s.
  const expected = body.expectedAssigneeId === undefined ? undefined : (body.expectedAssigneeId as string | null);
  if (expected !== conversation.assigned_to) return conflict();

  let assigneeLabel: string | null = null;

  if (next) {
    const eligible = await resolveStaffRecipients("support.view", null);
    if (!eligible.includes(next)) {
      return NextResponse.json(
        { error: "That person cannot be assigned support conversations." },
        { status: 400 }
      );
    }
    assigneeLabel = await resolveActorLabel(next);
  }

  const now = new Date().toISOString();
  const patch = next
    ? { assigned_to: next, assigned_to_label: assigneeLabel, assigned_at: now }
    : // Cleared as a pair, because `support_conversations_assignment_complete`
      // refuses "assigned, we do not know when" and its mirror.
      { assigned_to: null, assigned_to_label: null, assigned_at: null };

  const guard = routeServiceClient.from("support_conversations").update(patch).eq("id", conversation.id);

  const { data, error } = await (conversation.assigned_to
    ? guard.eq("assigned_to", conversation.assigned_to)
    : guard.is("assigned_to", null)
  )
    .select("id")
    .maybeSingle();

  if (error) {
    logSupportFailure("assign", error);
    return NextResponse.json({ error: "Could not change the assignment." }, { status: 500 });
  }
  if (!data) return conflict();

  const audited = await recordSupportAudit({
    action: next ? "support.assigned" : "support.unassigned",
    actorUserId: actor.userId,
    actorRole: actor.role,
    conversation,
    changes: { assigned_to: { before: conversation.assigned_to_label, after: assigneeLabel } },
    summary: next
      ? `${conversation.reference} assigned to ${assigneeLabel ?? "a staff member"}`
      : `${conversation.reference} unassigned`,
    metadata: { assignee_id: next },
  });

  if (next) {
    await notifyAssignee({ conversation, assigneeUserId: next, actorUserId: actor.userId }).catch((error: unknown) =>
      logSupportFailure("assign.notify", error)
    );
  }

  return NextResponse.json({
    ok: true,
    assignedTo: next,
    assignedToLabel: assigneeLabel,
    auditFailed: !audited,
  });
}
