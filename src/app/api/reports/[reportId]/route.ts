import { NextRequest, NextResponse } from "next/server";

import { getUserFromRequest } from "@/lib/api/routeAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ reportId: string }> }) {
  const user = await getUserFromRequest(req);
  if (!user) return jsonError(401, "Unauthorized");

  const { reportId: rawReportId } = await ctx.params;
  const reportId = (rawReportId ?? "").trim();
  if (!reportId) return jsonError(400, "Missing report id");

  const admin = supabaseAdmin;

  const { data: roleRow } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle<{ role: string }>();
  const viewerRole = roleRow?.role ?? "member";
  const isStaff = ["admin", "support", "moderator"].includes(viewerRole);

  const { data: report, error: reportErr } = await admin
    .from("reports")
    .select(
      "id, created_at, status, category, reason, target_type, target_id, reporter_user_id, assigned_to, escalated_at, escalated_by"
    )
    .eq("id", reportId)
    .maybeSingle<{
      id: string;
      created_at: string;
      status: string;
      category: string | null;
      reason: string;
      target_type: string;
      target_id: string;
      reporter_user_id: string;
      assigned_to: string | null;
      escalated_at?: string | null;
      escalated_by?: string | null;
    }>();

  if (reportErr || !report) {
    return jsonError(404, "Report not found");
  }

  if (!isStaff && report.reporter_user_id !== user.id) {
    return jsonError(403, "Forbidden");
  }

  const { data: messages, error: msgErr } = await admin
    .from("report_messages")
    .select("id, report_id, created_at, author_user_id, message, kind")
    .eq("report_id", reportId)
    .order("created_at", { ascending: true });

  if (msgErr) {
    console.error("Failed to load report messages", msgErr);
    return jsonError(500, "Failed to load report messages");
  }

  const authorIds = Array.from(
    new Set(
      (messages ?? [])
        .filter((m) => isStaff || m.kind !== "staff_note")
        .map((m) => m.author_user_id)
        .filter((v): v is string => !!v)
    )
  );

  const { data: authors } = authorIds.length
    ? await admin
        .from("profiles")
        .select("id, username, display_name, avatar_url")
        .in("id", authorIds)
    : { data: [] as Array<{ id: string; username: string | null; display_name: string | null; avatar_url: string | null }> };

  // If this report targets a DM thread, staff may not be able to open the thread.
  // Provide a read-only message log for staff in the report view.
  let dmThread: { thread_id: string; messages: unknown[]; senders: unknown[]; members: unknown[] } | null = null;
  if (isStaff && report.target_type === "dm_thread") {
    const threadId = (report.target_id ?? "").trim();
    if (threadId) {
      const { data: dmMessages, error: dmErr } = await admin
        .from("dm_messages")
        .select("id, thread_id, created_by, body, created_at, is_deleted")
        .eq("thread_id", threadId)
        .order("created_at", { ascending: true })
        .limit(200);

      if (dmErr) {
        console.error("Failed to load dm_messages for report", dmErr);
      } else {
        const senderIds = Array.from(
          new Set(
            (dmMessages ?? [])
              .map((m) => (m as { created_by?: unknown } | null)?.created_by)
              .filter((v): v is string => typeof v === "string" && !!v)
          )
        );

        const { data: senders } = senderIds.length
          ? await admin
              .from("profiles")
              .select("id, username, display_name, avatar_url")
              .in("id", senderIds)
          : { data: [] as Array<{ id: string; username: string | null; display_name: string | null; avatar_url: string | null }> };

        
        // Determine members from messages (service role). Some deployments do not expose a dm_thread_members table.
        // This is best-effort: we infer participants from the senders in the message log.
        const memberIds = Array.from(
          new Set([
            ...senderIds,
            ...(report.reporter_user_id ? [report.reporter_user_id] : []),
          ].filter((v) => typeof v === "string" && !!v))
        );

        const { data: memberProfiles } = memberIds.length
          ? await admin.from("profiles").select("id, username, display_name, avatar_url").in("id", memberIds)
          : { data: [] as Array<{ id: string; username: string | null; display_name: string | null; avatar_url: string | null }> };

dmThread = {
          thread_id: threadId,
          messages: dmMessages ?? [],
          senders: senders ?? [],
          members: memberProfiles ?? [],
        };
      }
    }
  }

  return NextResponse.json({
    ok: true,
    report,
    messages: (messages ?? []).filter((m) => isStaff || m.kind !== "staff_note"),
    authors: authors ?? [],
    dm_thread: dmThread,
    viewer: { id: user.id, is_staff: isStaff, role: viewerRole },
  });
}
