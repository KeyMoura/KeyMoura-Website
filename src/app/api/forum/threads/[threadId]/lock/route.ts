// app/api/forum/threads/[threadId]/lock/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getActorAccessFromRequest, getUserFromRequest, routeServiceClient } from "@/lib/api/routeAuth";

type LockBody = {
  lock: boolean;
  reason?: string | null;
};

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ threadId: string }> }
) {
  try {
    const { threadId } = await context.params;

    const threadIdNum = Number(threadId);
    if (!threadIdNum || Number.isNaN(threadIdNum)) {
      return NextResponse.json(
        { error: "Invalid threadId." },
        { status: 400 }
      );
    }

    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const actorUserId = user.id;
    const actor = await getActorAccessFromRequest(req);
    if (!actor) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 2) Body
    let body: LockBody;
    try {
      const raw = (await req.json()) as {
        lock?: boolean;
        reason?: string | null;
      };
      body = {
        lock: !!raw.lock,
        reason:
          raw.reason && raw.reason.trim().length > 0
            ? raw.reason.trim()
            : null,
      };
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400 }
      );
    }

    // 3) Load thread
    const {
      data: threadRow,
      error: threadErr,
    } = await routeServiceClient
      .from("forum_threads")
      .select(
        "id, category_id, title, slug, created_at, updated_at, created_by, last_post_at, last_post_by, reply_count, view_count, is_locked, is_pinned, is_deleted, accepted_post_id, locked_by, locked_at, locked_reason"
      )
      .eq("id", threadIdNum)
      .maybeSingle();

    if (threadErr) {
      console.error("Error loading thread for lock", threadErr);
      return NextResponse.json(
        { error: "Failed to load thread." },
        { status: 500 }
      );
    }

    if (!threadRow || threadRow.is_deleted) {
      return NextResponse.json(
        { error: "Thread not found." },
        { status: 404 }
      );
    }

    // 4) Permission: staff permission, category moderator, or thread owner
    const { data: modRow } = await routeServiceClient
      .from("forum_moderators")
      // The table is keyed on (category_id, user_id) and has no `id` column, so
      // this read failed and `isCategoryModerator` was false for everyone —
      // category moderators could never lock a thread.
      .select("user_id")
      .eq("user_id", actorUserId)
      .eq("category_id", threadRow.category_id)
      .maybeSingle<{ user_id: string }>();

    const isCategoryModerator = !!modRow;
    const isOwner = threadRow.created_by === actorUserId;
    const canLockAny = actor.permissions.has("community.lock_thread");
    const canLockOwn = actor.permissions.has("community.thread.lock.own");
    const canLockStaff = canLockAny || isCategoryModerator;

    if (!(canLockStaff || (isOwner && canLockOwn))) {
      return NextResponse.json(
        { error: "You are not allowed to lock/unlock this thread." },
        { status: 403 }
      );
    }

    const now = new Date().toISOString();

    const updatePatch: Record<string, unknown> = {};
    if (body.lock) {
      updatePatch.is_locked = true;
      updatePatch.locked_by = actorUserId;
      updatePatch.locked_at = now;
      updatePatch.locked_reason =
        body.reason ||
        threadRow.locked_reason ||
        "Locked by thread owner/moderator.";
    } else {
      updatePatch.is_locked = false;
      updatePatch.locked_by = null;
      updatePatch.locked_at = null;
      updatePatch.locked_reason = null;
    }

    const {
      data: updated,
      error: updateErr,
    } = await routeServiceClient
      .from("forum_threads")
      .update(updatePatch)
      .eq("id", threadRow.id)
      .select(
        "id, category_id, title, slug, created_at, updated_at, created_by, last_post_at, last_post_by, reply_count, view_count, is_locked, is_pinned, is_deleted, accepted_post_id, locked_by, locked_at, locked_reason"
      )
      .maybeSingle();

    if (updateErr || !updated) {
      console.error("Error updating lock state", updateErr);
      return NextResponse.json(
        { error: "Failed to update lock state." },
        { status: 500 }
      );
    }

    // 5) Audit
return NextResponse.json(
      {
        ok: true,
        thread: updated,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Unexpected error in lock route", err);
    return NextResponse.json(
      { error: "Unexpected error updating lock state." },
      { status: 500 }
    );
  }
}
