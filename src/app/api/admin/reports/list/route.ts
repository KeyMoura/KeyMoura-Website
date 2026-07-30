import { NextRequest, NextResponse } from "next/server";

import { getActorAccessFromRequest } from "@/lib/api/routeAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type ReporterProfile = {
  id: string;
  username: string | null;
  display_name: string | null;
};

type ReportListRow = {
  id: string;
  created_at: string;
  status: string;
  category: string | null;
  reason: string;
  target_type: string;
  target_id: string;
  reporter_user_id: string;
  assigned_to: string | null;
  escalated_at: string | null;
  escalated_by: string | null;
};

export async function GET(req: NextRequest) {
  const actor = await getActorAccessFromRequest(req);
  if (!actor) return jsonError(401, "Unauthorized");
  if (!actor.permissions.has("moderation.reports.view")) return jsonError(403, "Forbidden");

  const admin = supabaseAdmin;

  // Permission-gated; no hardcoded role checks.

  const url = new URL(req.url);
  const status = (url.searchParams.get("status") ?? "open").trim();

  let q = admin
    .from("reports")
    .select(
      "id, created_at, status, category, reason, target_type, target_id, reporter_user_id, assigned_to, escalated_at, escalated_by"
    )
    .order("created_at", { ascending: false })
    .limit(200);

  if (status && status !== "all") {
    q = q.eq("status", status);
  }

  const { data, error } = await q;
  if (error) {
    console.error("Failed to list reports", error);
    return jsonError(500, "Failed to load reports");
  }

  const reports = (data ?? []) as ReportListRow[];
  const reporterIds = Array.from(new Set(reports.map((r) => r.reporter_user_id)));

  const { data: reporters } = reporterIds.length
    ? await admin.from("profiles").select("id, username, display_name").in("id", reporterIds)
    : { data: [] as ReporterProfile[] };

  return NextResponse.json({ ok: true, reports, reporters: reporters ?? [] });
}
