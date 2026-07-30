import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getActorAccessFromRequest, getUserFromRequest } from "@/lib/api/routeAuth";
import { isRecord, isString } from "@/lib/typeGuards";
import { tryBackupToRecycleBin } from "@/lib/recycleBin";

export async function POST(req: NextRequest, ctx: { params: Promise<{ postId: string }> }) {
  try {
    const { postId } = await ctx.params;
    if (!postId) return NextResponse.json({ error: "Missing post id" }, { status: 400 });

    const postIdNum = Number.parseInt(String(postId), 10);
    if (!Number.isFinite(postIdNum) || postIdNum <= 0) {
      return NextResponse.json({ error: "Invalid post id" }, { status: 400 });
    }

    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const actor = await getActorAccessFromRequest(req);
    const perms = actor?.permissions;
    if (!perms) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const canDeleteAny = perms.has("community.delete_post");
    const canDeleteOwn = perms.has("community.post.delete.own");

    // Use admin client for reads/writes; we enforce auth + permissions/ownership in this route.
    const supabase = supabaseAdmin;

    // Load post (+ enough fields to back up to recycle bin) and parent thread to enforce locked rules.
    const { data: postRow, error: postError } = await supabase
      .from("forum_posts")
      .select("*")
      .eq("id", postIdNum)
      .maybeSingle();

    if (postError) return NextResponse.json({ error: postError.message }, { status: 500 });
    if (!postRow) return NextResponse.json({ error: "Post not found" }, { status: 404 });

    const createdBy =
      isRecord(postRow) && isString((postRow as any).created_by) ? (postRow as any).created_by : null;

    const isOwner = createdBy === user.id;
    const canDelete = canDeleteAny || (isOwner && canDeleteOwn);

    if (!canDelete) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { data: threadRow, error: threadError } = await supabase
      .from("forum_threads")
      .select("id, is_locked")
      .eq("id", (postRow as any).thread_id)
      .maybeSingle();

    if (threadError) return NextResponse.json({ error: threadError.message }, { status: 500 });
    const isLocked = Boolean((threadRow as any)?.is_locked);

    // If locked, only moderators with delete-any can delete.
    if (isLocked && !canDeleteAny) {
      return NextResponse.json({ error: "Thread is locked" }, { status: 403 });
    }

    // Accept a reason for the delete. When deleted, the UI shows a tombstone and can
    // display the reason (e.g., "Deleted by staff").
    const body = (await req.json().catch(() => null)) as unknown;
    const reason =
      isRecord(body) && isString((body as any).reason) ? String((body as any).reason) : null;

    const now = new Date().toISOString();

    // Best-effort recycle bin backup (non-fatal if the table isn't deployed yet).
    // We store the full pre-delete post row so staff can restore later.
    // Back up when a staff member is deleting *someone else's* post, or when the
    // actor has the explicit delete-any permission.
    if (canDeleteAny || !isOwner) {
      void tryBackupToRecycleBin({
        itemType: "post",
        originalTable: "forum_posts",
        originalId: String(postIdNum),
        payload: {
          ...(postRow as any),
          delete_reason: reason,
          deleted_at: now,
        },
        deletedBy: user.id,
        deletedAt: now,
        supabase,
      });
    }

    const { error: delError } = await supabase
      .from("forum_posts")
      .update({ is_deleted: true, updated_at: now, edit_reason: reason })
      .eq("id", postIdNum);

    if (delError) return NextResponse.json({ error: delError.message }, { status: 500 });

    // Return the updated post row so the client can update state without a refetch.
    const { data: updatedPost, error: updatedError } = await supabase
      .from("forum_posts")
      .select(
        "id, thread_id, parent_post_id, created_at, updated_at, created_by, body_markdown, is_deleted, edit_reason, vote_score, upvote_count, downvote_count"
      )
      .eq("id", postIdNum)
      .maybeSingle();

    if (updatedError) return NextResponse.json({ error: updatedError.message }, { status: 500 });
    if (!updatedPost) return NextResponse.json({ error: "Post not found after delete" }, { status: 404 });

    return NextResponse.json({ ok: true, post: updatedPost });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Unknown error" }, { status: 500 });
  }
}
