import { NextRequest, NextResponse } from "next/server";

import { getUserFromRequest } from "@/lib/api/routeAuth";
import { createNotification } from "@/lib/notifications";
import { logAuditEvent } from "@/lib/audit";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type BulkUpdatePayload = {
  report_ids: string[];
  status?: string;
  assigned_to?: string | null;
  /** Optional internal-only note applied to every selected report. */
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

export async function POST(req: NextRequest) {
  const viewer = await getUserFromRequest(req);
  if (!viewer) return jsonError(401, "Unauthorized");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const r = asRecord(body);

  const idsRaw = r.report_ids;
  const reportIds = Array.isArray(idsRaw)
    ? idsRaw
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .filter((v) => !!v)
    : [];

  if (reportIds.length === 0) return jsonError(400, "report_ids is required");
  if (reportIds.some((id) => !isUuidLike(id))) return jsonError(400, "Invalid report id in report_ids");

  const payload: BulkUpdatePayload = {
    report_ids: reportIds,
    status: typeof r.status === "string" ? (r.status as string) : undefined,
    assigned_to:
      r.assigned_to === null
        ? null
        : typeof r.assigned_to === "string"
          ? (r.assigned_to as string)
          : undefined,
    internal_note: typeof r.internal_note === "string" ? (r.internal_note as string) : undefined,
  };

  const admin = supabaseAdmin;

  const { data: roleRow } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", viewer.id)
    .maybeSingle<{ role: string }>();

  const viewerRole = roleRow?.role ?? "member";
  const isStaff = ["admin", "support", "moderator"].includes(viewerRole);
  if (!isStaff) return jsonError(403, "Forbidden");

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

  if (Object.keys(update).length === 0 && !cleanString(payload.internal_note)) {
    return jsonError(400, "No changes provided");
  }

  // Fetch the reports so we can notify reporters.
  const { data: reports, error: repErr } = await admin
    .from("reports")
    .select("id, reporter_user_id")
    .in("id", reportIds);

  if (repErr) {
    console.error("Failed to fetch reports for bulk update", repErr);
    return jsonError(500, "Failed to update reports");
  }

  if (Object.keys(update).length > 0) {
    const { error: upErr } = await admin.from("reports").update(update).in("id", reportIds);
    if (upErr) {
      console.error("Bulk update failed", upErr);
      return jsonError(500, "Failed to update reports");
    }
  }

  const internalNote = cleanString(payload.internal_note);
  if (internalNote) {
    if (internalNote.length > 4000) return jsonError(400, "Internal note is too long");

    const rows = reportIds.map((rid) => ({
      report_id: rid,
      author_user_id: viewer.id,
      message: internalNote,
      kind: "staff_note",
    }));

    const { error: noteErr } = await admin.from("report_messages").insert(rows);
    if (noteErr) {
      console.error("Bulk note insert failed", noteErr);
      return jsonError(500, "Failed to add internal notes");
    }
  }

  // Notify reporters about bulk status/assignment updates (NOT internal notes).
  if (Object.keys(update).length > 0) {
    const reporterIds = (reports ?? [])
      .map((x) => (x as { reporter_user_id?: unknown } | null)?.reporter_user_id)
      .filter((v): v is string => typeof v === "string" && !!v);

    // Avoid spamming: only notify once per reporter per request.
    const uniqueReporterIds = Array.from(new Set(reporterIds)).filter((id) => id !== viewer.id);

    const title = "Report Update";
    const messageParts: string[] = [];
    if (typeof update.status === "string") messageParts.push(`Status: ${String(update.status)}`);
    if (Object.prototype.hasOwnProperty.call(update, "assigned_to")) {
      messageParts.push("Assignment updated");
    }
    const msg = messageParts.join(" • ") || "Report updated.";

    for (const rid of uniqueReporterIds) {
      await createNotification({
        recipientUserId: rid,
        actorUserId: viewer.id,
        type: "report_update",
        bypassBlock: true,
        threadId: null,
        postId: null,
        payload: {
          title,
          message: msg,
          href: "/reports",
          bulk: true,
        },
      });
    }
  }

  // Audit trail (best-effort)
  await logAuditEvent({
    actorUserId: viewer.id,
    actorRole: viewerRole,
    eventType: "moderation.report.bulk_update",
    targetTable: "reports",
    targetId: null,
    metadata: {
      report_ids: reportIds,
      status: typeof update.status === "string" ? update.status : null,
      assigned_to: Object.prototype.hasOwnProperty.call(update, "assigned_to")
        ? (update.assigned_to as string | null)
        : undefined,
      wrote_internal_note: !!internalNote,
    },
  });

  return NextResponse.json({ ok: true });
}
