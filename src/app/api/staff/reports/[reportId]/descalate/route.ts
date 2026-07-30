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
  const actor = await requirePermission(req, "moderation.reports.override");
  if (!actor) return jsonError(403, "Forbidden");

  const { reportId: rawReportId } = await ctx.params;
  const reportId = cleanString(rawReportId);
  if (!reportId) return jsonError(400, "Missing report id");
  if (!isUuidLike(reportId)) return jsonError(400, "Invalid report id");

  const admin = routeServiceClient;

  const { data: report, error: repErr } = await admin
    .from("reports")
    .select("id")
    .eq("id", reportId)
    .maybeSingle<{ id: string }>();

  if (repErr || !report) return jsonError(404, "Report not found");

  const { error: escErr } = await admin
    .from("reports")
    .update({ escalated_at: null, escalated_by: null })
    .eq("id", reportId);

  if (escErr) {
    console.error("Failed to de-escalate report", escErr);
    return jsonError(500, "Failed to de-escalate report");
  }

  await logAuditEvent({
    actorUserId: actor.userId,
    actorRole: actor.role,
    eventType: "moderation.report.descalate",
    targetTable: "reports",
    targetId: reportId,
  });

  return NextResponse.json({ ok: true });
}
