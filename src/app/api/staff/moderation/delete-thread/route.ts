import { NextRequest, NextResponse } from "next/server";

import { getUserFromRequest } from "@/lib/api/routeAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { logAuditEvent } from "@/lib/audit";
import { checkStaffRateLimit } from "@/lib/staffRateLimit";
import { tryBackupToRecycleBin } from "@/lib/recycleBin";
import { canStaffModerate, getActorRole } from "../_shared";

type DeleteThreadBody = {
  threadId: number;
  reason?: string | null;
  lockThread?: boolean;
};

function readNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function readString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return jsonError(401, "Unauthorized");

    const actorRole = await getActorRole(user.id);
    if (!canStaffModerate(actorRole)) return jsonError(403, "Forbidden");

    const rate = await checkStaffRateLimit({
      actorUserId: user.id,
      actorRole,
      overrideLimit: actorRole === "support" ? 5 : undefined,
      overrideWindowMinutes: actorRole === "support" ? 60 : undefined,
      eventTypes: ["forum.thread_delete"],
    });
    if (!rate.ok) return NextResponse.json({ error: "Rate limit reached", rate_limit: rate }, { status: 429 });

    const bodyUnknown = (await req.json().catch(() => null)) as unknown;
    const body = (bodyUnknown ?? {}) as Record<string, unknown>;

    const threadId = readNumber(body.threadId);
    const reason = readString(body.reason);
    const lockThread = body.lockThread === true;

    if (threadId == null || threadId <= 0) return jsonError(400, "threadId is required");

    const admin = supabaseAdmin;

    const { data: thread, error: thErr } = await admin
      .from("forum_threads")
      .select("*")
      .eq("id", threadId)
      .maybeSingle<Record<string, unknown> & { id: number; is_deleted: boolean }>();

    if (thErr || !thread) return jsonError(404, "Thread not found");
    if (thread.is_deleted) return NextResponse.json({ ok: true, already_deleted: true });

    const nowIso = new Date().toISOString();

    // Best-effort recycle-bin backup (non-fatal if table not deployed)
    // Include the delete reason + timestamp so staff can understand what happened.
    void tryBackupToRecycleBin({
      itemType: "thread",
      originalTable: "forum_threads",
      originalId: String(threadId),
      payload: {
        ...(thread as Record<string, unknown>),
        delete_reason: reason ?? null,
        deleted_at: nowIso,
      },
      deletedBy: user.id,
      deletedAt: nowIso,
    });

    const { error: upErr } = await admin
      .from("forum_threads")
      .update({ is_deleted: true, is_locked: lockThread ? true : undefined, updated_at: nowIso })
      .eq("id", threadId);

    if (upErr) {
      console.error("staff delete-thread update failed", upErr);
      return jsonError(500, "Failed to delete thread");
    }

    await logAuditEvent({
      actorUserId: user.id,
      actorRole,
      eventType: "forum.thread_delete",
      targetTable: "forum_threads",
      targetId: String(threadId),
      metadata: { reason: reason ?? null, lockThread },
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error("staff delete-thread route error", err);
    return jsonError(500, "Unexpected error.");
  }
}
