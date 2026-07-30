import { NextRequest, NextResponse } from "next/server";

import { getUserFromRequest } from "@/lib/api/routeAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type ReportTargetType = "user" | "forum_post" | "forum_thread" | "dm_thread";

type CreateReportPayload = {
  target_type: ReportTargetType;
  target_id: string;
  category?: string;
  reason: string;
  message: string;
};

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return jsonError(401, "Unauthorized");

  const admin = supabaseAdmin;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const payload = body as Partial<CreateReportPayload>;
  const targetType = payload.target_type;
  const targetId = (payload.target_id ?? "").trim();
  const categoryRaw = (payload.category ?? "other").trim();
  const reason = (payload.reason ?? "").trim();
  const message = (payload.message ?? "").trim();

  // Basic server-side rate limit (prevents report spam)
  // Reporter: max 5 new reports per 10 minutes
  const tenMinAgoIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count: recentReportCount, error: recentCountErr } = await admin
    .from("reports")
    .select("id", { count: "exact", head: true })
    .eq("reporter_user_id", user.id)
    .gte("created_at", tenMinAgoIso);

  if (recentCountErr) {
    console.error("Failed to check report rate limit", recentCountErr);
  } else if ((recentReportCount ?? 0) >= 5) {
    return jsonError(429, "Too many reports. Please try again in a few minutes.");
  }

  const allowedCategories = new Set([
    "spam",
    "harassment",
    "hate",
    "nudity",
    "violence",
    "copyright",
    "impersonation",
    "privacy",
    "other",
  ]);
  const category = allowedCategories.has(categoryRaw) ? categoryRaw : "other";

  if (
    targetType !== "user" &&
    targetType !== "forum_post" &&
    targetType !== "forum_thread" &&
    targetType !== "dm_thread"
  ) {
    return jsonError(400, "Invalid target_type");
  }

  if (!targetId) return jsonError(400, "target_id is required");
  if (!reason) return jsonError(400, "reason is required");
  if (reason.length > 120) return jsonError(400, "Reason is too long");
  if (!message) return jsonError(400, "Message is required");
  if (message.length > 4000) return jsonError(400, "Message is too long");

  const { data: reportRow, error: reportErr } = await admin
    .from("reports")
    .insert({
      target_type: targetType,
      target_id: targetId,
      reporter_user_id: user.id,
      status: "open",
      category,
      reason,
    })
    .select("id")
    .single<{ id: string }>();

  if (reportErr || !reportRow) {
    console.error("Failed to create report", reportErr);
    return jsonError(500, "Failed to create report");
  }

  const { error: msgErr } = await admin.from("report_messages").insert({
    report_id: reportRow.id,
    author_user_id: user.id,
    message,
    kind: "reporter",
  });

  if (msgErr) {
    console.error("Failed to create report message", msgErr);
    return jsonError(500, "Failed to create report message");
  }

  return NextResponse.json({ ok: true, report_id: reportRow.id });
}
