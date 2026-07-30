import { NextRequest, NextResponse } from "next/server";

import { getUserFromRequest } from "@/lib/api/routeAuth";
import { createNotification } from "@/lib/notifications";
import { logAuditEvent } from "@/lib/audit";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type UpdateReportPayload = {
  /** Escalate this report to admins (pings all admins). */
  escalate?: boolean;
  status?: string;
  assigned_to?: string | null;
  /** Optional message to send to the reporter (stored as a staff message). */
  message?: string;
  /** Optional internal-only note (stored as staff_note). */
  internal_note?: string;
};

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

function cleanString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function isUuidLike(id: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    id
  );
}

const ALLOWED_STATUSES = new Set<string>(["open", "awaiting_reporter", "resolved", "dismissed"]);

export async function POST(req: NextRequest, ctx: { params: Promise<{ reportId: string }> }) {
  const viewer = await getUserFromRequest(req);
  if (!viewer) return jsonError(401, "Unauthorized");

  const { reportId: rawReportId } = await ctx.params;
  const reportId = cleanString(rawReportId);
  if (!reportId) return jsonError(400, "Missing report id");
  if (!isUuidLike(reportId)) return jsonError(400, "Invalid report id");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const r = asRecord(body);
  const payload: UpdateReportPayload = {
    status: typeof r.status === "string" ? (r.status as string) : undefined,
    assigned_to:
      r.assigned_to === null
        ? null
        : typeof r.assigned_to === "string"
          ? (r.assigned_to as string)
          : undefined,
    message: typeof r.message === "string" ? (r.message as string) : undefined,
    internal_note: typeof r.internal_note === "string" ? (r.internal_note as string) : undefined,
    escalate: typeof r.escalate === "boolean" ? r.escalate : false,
  };

  const admin = supabaseAdmin;

  const { data: roleRow } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", viewer.id)
    .maybeSingle<{ role: string }>();

  const isStaff = roleRow ? ["admin", "support", "moderator"].includes(roleRow.role) : false;
  const viewerRole = roleRow?.role ?? "member";
  if (!isStaff) return jsonError(403, "Forbidden");

  const { data: report, error: repErr } = await admin
    .from("reports")
    .select("id, reporter_user_id, status, assigned_to, reason")
    .eq("id", reportId)
    .maybeSingle<{
      id: string;
      reporter_user_id: string;
      status: string;
      assigned_to: string | null;
      reason: string;
    }>();

  if (repErr || !report) return jsonError(404, "Report not found");

  const update: Record<string, unknown> = {};

  const nextStatus = cleanString(payload.status);
  if (nextStatus) {
    if (!ALLOWED_STATUSES.has(nextStatus)) return jsonError(400, "Invalid status");
    update.status = nextStatus;
  }

  if (payload.assigned_to === null) {
    update.assigned_to = null;
  } else if (typeof payload.assigned_to === "string") {
    const id = cleanString(payload.assigned_to);
    if (id && !isUuidLike(id)) return jsonError(400, "Invalid assigned_to");
    update.assigned_to = id || null;
  }

  if (Object.keys(update).length > 0) {
    const { error: upErr } = await admin.from("reports").update(update).eq("id", reportId);
    if (upErr) {
      console.error("Failed to update report", upErr);
      return jsonError(500, "Failed to update report");
    }
  }

  const staffMessage = cleanString(payload.message);
  if (staffMessage) {
    if (staffMessage.length > 4000) return jsonError(400, "Message is too long");
    const { error: msgErr } = await admin.from("report_messages").insert({
      report_id: reportId,
      author_user_id: viewer.id,
      message: staffMessage,
      kind: "staff",
    });
    if (msgErr) {
      console.error("Failed to append staff report message", msgErr);
      return jsonError(500, "Failed to add message");
    }
  }

  const internalNote = cleanString(payload.internal_note);
  if (internalNote) {
    if (internalNote.length > 4000) return jsonError(400, "Internal note is too long");
    const { error: noteErr } = await admin.from("report_messages").insert({
      report_id: reportId,
      author_user_id: viewer.id,
      message: internalNote,
      kind: "staff_note",
    });
    if (noteErr) {
      console.error("Failed to append staff note", noteErr);
      return jsonError(500, "Failed to add internal note");
    }
  }

  // Notify reporter when staff changes status/assignment or sends a staff message.
  const shouldNotifyReporter = Object.keys(update).length > 0 || !!staffMessage;
  if (shouldNotifyReporter && report.reporter_user_id && report.reporter_user_id !== viewer.id) {
    const statusForPayload =
      typeof update.status === "string" ? (update.status as string) : (report.status as string);

    const statusLine = typeof update.status === "string" ? `Status: ${statusForPayload}` : "";
    const assignmentLine =
      Object.prototype.hasOwnProperty.call(update, "assigned_to")
        ? `Assigned: ${(update.assigned_to as string | null) ?? "Unassigned"}`
        : "";
    const combinedLine = [statusLine, assignmentLine].filter(Boolean).join(" • ");

    await createNotification({
      recipientUserId: report.reporter_user_id,
      actorUserId: viewer.id,
      type: "report_update",
      bypassBlock: true,
      threadId: null,
      postId: null,
      payload: {
        title: staffMessage ? "Staff replied to your report" : "Report Update",
        message: staffMessage || combinedLine || "Report updated.",
        href: `/reports/${reportId}`,
        report_id: reportId,
        status: statusForPayload,
      },
    });
  }

  // Notify newly-assigned staff member (best effort). This keeps assignments visible without polling.
  if (
    typeof update.assigned_to === "string" &&
    update.assigned_to &&
    update.assigned_to !== report.assigned_to &&
    update.assigned_to !== viewer.id
  ) {
    await createNotification({
      recipientUserId: update.assigned_to,
      actorUserId: viewer.id,
      type: "report_update",
      payload: {
        title: "Report assigned to you",
        message: report.reason,
        href: `/reports/${reportId}`,
        report_id: reportId,
        status: typeof update.status === "string" ? update.status : report.status,
      },
    });
  }

  // Audit trail (best-effort)
  await logAuditEvent({
    actorUserId: viewer.id,
    actorRole: viewerRole,
    eventType: "moderation.report.update",
    targetTable: "reports",
    targetId: reportId,
    metadata: {
      prev_status: report.status,
      next_status: typeof update.status === "string" ? update.status : report.status,
      prev_assigned_to: report.assigned_to,
      next_assigned_to:
        Object.prototype.hasOwnProperty.call(update, "assigned_to")
          ? (update.assigned_to as string | null)
          : report.assigned_to,
      wrote_message: !!staffMessage,
      wrote_internal_note: !!internalNote,
    },
  });

  
  // Escalation: ping all admins (no approval required)
  if (payload.escalate) {
    // Mark the report as escalated for queue filtering (best-effort; column may not exist yet).
    const { error: escMarkErr } = await admin
      .from("reports")
      .update({ escalated_at: new Date().toISOString(), escalated_by: viewer.id })
      .eq("id", reportId);
    if (escMarkErr) {
      // best-effort; keep escalation functional even if the column isn't present yet
      console.warn("Failed to mark report escalated", escMarkErr);
    }

    const { data: adminRows } = await admin
      .from("user_roles")
      .select("user_id")
      .eq("role", "admin");

    const adminIds = (adminRows ?? [])
      .map((r) => (typeof (r as { user_id?: unknown }).user_id === "string" ? (r as { user_id: string }).user_id : null))
      .filter((v): v is string => !!v);

    // Notify *all* admins.
    // NOTE: createNotification intentionally skips self-notifs, so we insert directly for the actor.
    for (const adminId of adminIds) {
      if (adminId === viewer.id) {
        const { error: selfNotifErr } = await admin.from("notifications").insert({
          user_id: adminId,
          actor_user_id: viewer.id,
          type: "report_update",
          thread_id: null,
          post_id: null,
          payload: {
            title: "Report Escalation",
            message: report.reason,
            href: `/reports/${reportId}`,
            report_id: reportId,
            status: typeof update.status === "string" ? update.status : report.status,
          },
          is_read: false,
        });
        if (selfNotifErr) console.error("escalation self notification error", selfNotifErr);
        continue;
      }

      await createNotification({
        recipientUserId: adminId,
        actorUserId: viewer.id,
        type: "report_update",
        payload: {
          title: "Report Escalation",
          message: report.reason,
          href: `/reports/${reportId}`,
          report_id: reportId,
          status: typeof update.status === "string" ? update.status : report.status,
        },
        // Escalations are staff-critical; do not allow user blocks to suppress them.
        bypassBlock: true,
      });
    }

    await logAuditEvent({
      actorUserId: viewer.id,
      actorRole: viewerRole,
      eventType: "moderation.report.escalate",
      targetTable: "reports",
      targetId: reportId,
      metadata: { report_id: reportId },
    });

    // also store a private staff note line for timeline clarity
    await admin.from("report_messages").insert({
      report_id: reportId,
      author_user_id: viewer.id,
      message: "Escalated to admins.",
      kind: "staff_note",
    });
  }

  return NextResponse.json({ ok: true });
}
