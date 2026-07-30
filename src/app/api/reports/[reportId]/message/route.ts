import { NextRequest, NextResponse } from "next/server";

import { getUserFromRequest } from "@/lib/api/routeAuth";
import { createNotification } from "@/lib/notifications";
import { logAuditEvent } from "@/lib/audit";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type AddMessagePayload = {
  message: string;
};

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ reportId: string }> }) {
  const user = await getUserFromRequest(req);
  if (!user) return jsonError(401, "Unauthorized");

  const { reportId: rawReportId } = await ctx.params;
  const reportId = (rawReportId ?? "").trim();
  if (!reportId) return jsonError(400, "Missing report id");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const payload = body as Partial<AddMessagePayload>;
  const message = (payload.message ?? "").trim();
  if (!message) return jsonError(400, "Message is required");
  if (message.length > 4000) return jsonError(400, "Message is too long");

  const admin = supabaseAdmin;

  // Permission model:
  // - reporter can post
  // - staff can post
  const { data: report, error: reportErr } = await admin
    .from("reports")
    .select("id, reporter_user_id, assigned_to, status")
    .eq("id", reportId)
    .maybeSingle<{ id: string; reporter_user_id: string; assigned_to: string | null; status: string }>();

  if (reportErr || !report) {
    return jsonError(404, "Report not found");
  }

  const { data: roleRow } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle<{ role: string }>();

  const viewerRole = roleRow?.role ?? "member";
  const isStaff = ["admin", "support", "moderator"].includes(viewerRole);
  const isReporter = report.reporter_user_id === user.id;

  if (!isStaff && !isReporter) {
    return jsonError(403, "Forbidden");
  }

  const kind = isStaff ? "staff" : "reporter";
  // Basic server-side rate limit (prevents message spam inside reports)
  // Reporter: 10 messages per 5 minutes; Staff: 25 messages per 5 minutes
  const fiveMinAgoIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { count: recentMsgCount, error: msgCountErr } = await admin
    .from("report_messages")
    .select("id", { count: "exact", head: true })
    .eq("author_user_id", user.id)
    .gte("created_at", fiveMinAgoIso);

  if (msgCountErr) {
    console.error("Failed to check report message rate limit", msgCountErr);
  } else {
    const limit = isStaff ? 25 : 10;
    if ((recentMsgCount ?? 0) >= limit) {
      return jsonError(429, "Too many messages. Please wait a moment and try again.");
    }
  }


  const { error: msgErr } = await admin.from("report_messages").insert({
    report_id: reportId,
    author_user_id: user.id,
    message,
    kind,
  });

  if (msgErr) {
    console.error("Failed to add report message", msgErr);
    return jsonError(500, "Failed to add message");
  }

  // Auto status transitions when someone replies:
  // - Staff message -> set awaiting_reporter (unless already resolved/dismissed)
  // - Reporter message -> set open when currently awaiting_reporter
  let nextStatus: string | null = null;
  if (isStaff) {
    if (report.status !== "resolved" && report.status !== "dismissed" && report.status !== "awaiting_reporter") {
      nextStatus = "awaiting_reporter";
    }
  } else {
    if (report.status === "awaiting_reporter") {
      nextStatus = "open";
    }
  }

  if (nextStatus) {
    const { error: stErr } = await admin.from("reports").update({ status: nextStatus }).eq("id", reportId);
    if (stErr) {
      console.error("Failed to auto-update report status", stErr);
    } else {
      // reflect the new status for notification messaging below
      report.status = nextStatus;
    }
  }

  // Notifications:
  // - Staff reply -> notify reporter
  // - Reporter reply -> notify assigned staff (if any)
  if (isStaff && report.reporter_user_id && report.reporter_user_id !== user.id) {
    await createNotification({
      recipientUserId: report.reporter_user_id,
      actorUserId: user.id,
      type: "report_update",
      bypassBlock: true,
      payload: {
        title: "Staff replied to your report",
        message,
        href: `/reports/${reportId}`,
        report_id: reportId,
        status: report.status,
      },
    });
  }

  if (!isStaff && report.assigned_to && report.assigned_to !== user.id) {
    await createNotification({
      recipientUserId: report.assigned_to,
      actorUserId: user.id,
      type: "report_update",
      payload: {
        title: "Reporter replied",
        message:
          report.status === "open"
            ? "Reporter replied (status: open)."
            : "Reporter added a message.",
        href: `/reports/${reportId}`,
        report_id: reportId,
        status: report.status,
      },
    });
  }

  // Audit trail (best-effort)
  await logAuditEvent({
    actorUserId: user.id,
    actorRole: viewerRole,
    eventType: isStaff ? "moderation.report.staff_reply" : "moderation.report.reporter_reply",
    targetTable: "reports",
    targetId: reportId,
    metadata: {
      auto_status: nextStatus,
      assigned_to: report.assigned_to,
    },
  });

  return NextResponse.json({ ok: true });
}
