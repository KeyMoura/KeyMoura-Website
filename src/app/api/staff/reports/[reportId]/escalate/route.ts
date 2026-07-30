import { NextRequest, NextResponse } from "next/server";

import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { logAuditEvent } from "@/lib/audit";

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

function cleanString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function isUuidLike(id: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ reportId: string }> }) {
  const actor = await requirePermission(req, "moderation.reports.moderate");
  if (!actor) return jsonError(403, "Forbidden");

  const { reportId: rawReportId } = await ctx.params;
  const reportId = cleanString(rawReportId);
  if (!reportId) return jsonError(400, "Missing report id");
  if (!isUuidLike(reportId)) return jsonError(400, "Invalid report id");

  const admin = routeServiceClient;

  const { data: report, error: repErr } = await admin
    .from("reports")
    .select("id, reason")
    .eq("id", reportId)
    .maybeSingle<{ id: string; reason: string }>();

  if (repErr || !report) return jsonError(404, "Report not found");

  const { error: escErr } = await admin
    .from("reports")
    .update({ escalated_at: new Date().toISOString(), escalated_by: actor.userId })
    .eq("id", reportId);

  if (escErr) {
    console.error("Failed to mark report escalated", escErr);
    return jsonError(500, "Failed to escalate report");
  }

  const { data: adminRows } = await admin.from("user_roles").select("user_id").eq("role", "admin");

  const adminIds = (adminRows ?? [])
    .map((r) => (typeof (r as { user_id?: unknown }).user_id === "string" ? (r as { user_id: string }).user_id : null))
    .filter((v): v is string => !!v);

  const notifPayload = {
    title: "Report Escalation",
    message: report.reason,
    href: `/reports/${reportId}`,
    report_id: reportId,
  };

  for (const adminId of adminIds) {
    const { error } = await admin.from("notifications").insert({
      user_id: adminId,
      actor_user_id: actor.userId,
      type: "report_update",
      thread_id: null,
      post_id: null,
      payload: notifPayload,
      is_read: false,
    });
    if (error) console.warn("Failed to notify admin", { adminId, error });
  }

  await logAuditEvent({
    actorUserId: actor.userId,
    actorRole: actor.role,
    eventType: "moderation.report.escalate",
    targetTable: "reports",
    targetId: reportId,
    metadata: { notified_admins: adminIds.length },
  });

  return NextResponse.json({ ok: true });
}
