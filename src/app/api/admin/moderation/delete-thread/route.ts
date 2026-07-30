import { NextRequest, NextResponse } from "next/server";

import { getActorAccessFromRequest } from "@/lib/api/routeAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { logAuditEvent } from "@/lib/audit";
import { tryBackupToRecycleBin } from "@/lib/recycleBin";

type DeleteThreadBody = {
  threadId: number;
  reason?: string | null;
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
    const actor = await getActorAccessFromRequest(req);
    if (!actor) return jsonError(401, "Unauthorized");
    if (!actor.permissions.has("community.delete_thread")) return jsonError(403, "Forbidden");

    const body = (await req.json().catch(() => null)) as unknown as DeleteThreadBody | null;
    const threadId = readNumber((body as unknown as { threadId?: unknown })?.threadId);
    const reason = readString((body as unknown as { reason?: unknown })?.reason);

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

    // Capture the first post body so the recycle bin can show a faithful preview.
    const { data: firstPost } = await admin
      .from("forum_posts")
      .select("id, created_by, created_at, body_markdown")
      .eq("thread_id", threadId)
      .is("parent_post_id", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    // Best-effort recycle-bin backup (non-fatal if table not deployed)
    // Include the delete reason + timestamp so staff can understand what happened.
    void tryBackupToRecycleBin({
      itemType: "thread",
      originalTable: "forum_threads",
      originalId: String(threadId),
      payload: {
        ...(thread as Record<string, unknown>),
        first_post_body_markdown: (firstPost as any)?.body_markdown ?? null,
        first_post_created_by: (firstPost as any)?.created_by ?? null,
        first_post_created_at: (firstPost as any)?.created_at ?? null,
        delete_reason: reason ?? null,
        deleted_at: nowIso,
      },
      deletedBy: actor.userId,
      deletedAt: nowIso,
    });

    const { error: upErr } = await admin
      .from("forum_threads")
      .update({ is_deleted: true, updated_at: nowIso })
      .eq("id", threadId);

    if (upErr) {
      console.error("delete-thread update failed", upErr);
      return jsonError(500, "Failed to delete thread");
    }

    await logAuditEvent({
      actorUserId: actor.userId,
      actorRole: actor.role,
      eventType: "forum.thread_delete",
      targetTable: "forum_threads",
      targetId: String(threadId),
      metadata: { reason: reason ?? null },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("delete-thread route error", err);
    return jsonError(500, "Unexpected error.");
  }
}
