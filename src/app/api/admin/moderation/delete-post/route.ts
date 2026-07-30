import { NextRequest, NextResponse } from "next/server";

import { getActorAccessFromRequest } from "@/lib/api/routeAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { logAuditEvent } from "@/lib/audit";
import { tryBackupToRecycleBin } from "@/lib/recycleBin";

type DeletePostBody = {
  postId: number;
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
    if (!actor.permissions.has("community.delete_post")) return jsonError(403, "Forbidden");

    const body = (await req.json().catch(() => null)) as unknown as DeletePostBody | null;
    const postId = readNumber((body as unknown as { postId?: unknown })?.postId);
    const reason = readString((body as unknown as { reason?: unknown })?.reason);

    if (postId == null || postId <= 0) return jsonError(400, "postId is required");

    const admin = supabaseAdmin;

    const { data: post, error: pErr } = await admin
      .from("forum_posts")
      .select("*")
      .eq("id", postId)
      .maybeSingle<Record<string, unknown> & { id: number; is_deleted: boolean; thread_id: number }>();

    if (pErr || !post) return jsonError(404, "Post not found");
    if (post.is_deleted) return NextResponse.json({ ok: true, already_deleted: true });

    // Best-effort recycle-bin backup (non-fatal if table not deployed)
    void tryBackupToRecycleBin({
      itemType: "post",
      originalTable: "forum_posts",
      originalId: String(postId),
      payload: post,
      deletedBy: actor.userId,
    });

    const { error: upErr } = await admin
      .from("forum_posts")
      .update({
        is_deleted: true,
        updated_at: new Date().toISOString(),
        edit_reason: "Deleted by staff",
      })
      .eq("id", postId);

    if (upErr) {
      console.error("delete-post update failed", upErr);
      return jsonError(500, "Failed to delete post");
    }

    await logAuditEvent({
      actorUserId: actor.userId,
      actorRole: actor.role,
      eventType: "forum.post_delete",
      targetTable: "forum_posts",
      targetId: String(postId),
      metadata: { threadId: String(post.thread_id), reason: reason ?? null },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("delete-post route error", err);
    return jsonError(500, "Unexpected error.");
  }
}
