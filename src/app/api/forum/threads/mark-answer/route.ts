import { NextRequest, NextResponse } from "next/server";
import { getActorAccessFromRequest, getUserFromRequest, routeServiceClient } from "@/lib/api/routeAuth";

type Body = {
  threadId: number;
  postId: number | null; // null = clear accepted answer
  lockThread?: boolean; // optional: also lock when marking
  lockReason?: string | null;
};

export async function POST(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const actorUserId = user.id;
    const actor = await getActorAccessFromRequest(req);
    if (!actor) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 2) Parse body
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400 }
      );
    }

    const { threadId, postId, lockThread, lockReason } = body;

    if (!threadId || typeof threadId !== "number") {
      return NextResponse.json(
        { error: "threadId (number) is required." },
        { status: 400 }
      );
    }

    // 3) Load thread
    const {
      data: thread,
      error: threadErr,
    } = await routeServiceClient
      .from("forum_threads")
      .select(
        "id, category_id, created_by, is_locked, accepted_post_id"
      )
      .eq("id", threadId)
      .maybeSingle<{
        id: number;
        category_id: number;
        created_by: string;
        is_locked: boolean;
        accepted_post_id: number | null;
      }>();

    if (threadErr) {
      console.error("Error loading thread in mark-answer", threadErr);
      return NextResponse.json(
        { error: "Failed to load thread." },
        { status: 500 }
      );
    }

    if (!thread) {
      return NextResponse.json({ error: "Thread not found." }, { status: 404 });
    }

    // 4) Check permissions: thread owner, category moderator, or staff permission
    const { data: modRow } = await routeServiceClient
      .from("forum_moderators")
      .select("category_id")
      .eq("category_id", thread.category_id)
      .eq("user_id", actorUserId)
      .maybeSingle<{ category_id: number }>();

    const isCategoryMod = !!modRow;
    const isThreadOwner = thread.created_by === actorUserId;
    const canMarkAny = actor.permissions.has("community.mark_answer");
    const canMarkOwn = actor.permissions.has("community.thread.mark_answer.own");
    const canMarkStaff = canMarkAny || isCategoryMod;

    if (!(canMarkStaff || (isThreadOwner && canMarkOwn))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // 5) If postId is provided (non-null), ensure the post exists in this thread
    if (postId !== null) {
      const { data: post, error: postErr } = await routeServiceClient
        .from("forum_posts")
        .select("id, thread_id, is_deleted")
        .eq("id", postId)
        .maybeSingle<{ id: number; thread_id: number; is_deleted: boolean }>();

      if (postErr) {
        console.error("Error loading post in mark-answer", postErr);
        return NextResponse.json(
          { error: "Failed to load post." },
          { status: 500 }
        );
      }

      if (!post || post.thread_id !== thread.id || post.is_deleted) {
        return NextResponse.json(
          { error: "Post not found in this thread." },
          { status: 400 }
        );
      }
    }

    // 6) Build update payload
    const now = new Date().toISOString();

    const update: Record<string, unknown> = {
      accepted_post_id: postId,
    };

    // Optional: lock at the same time
    if (lockThread) {
      update.is_locked = true;
      update.locked_by = actorUserId;
      update.locked_at = now;
      update.locked_reason =
        lockReason ??
        (postId
          ? "Marked as answered and locked."
          : "Thread locked by owner/mod.");
    }

    const { error: updateErr } = await routeServiceClient
      .from("forum_threads")
      .update(update)
      .eq("id", thread.id);

    if (updateErr) {
      console.error("Error updating thread in mark-answer", updateErr);
      return NextResponse.json(
        { error: "Failed to update thread." },
        { status: 500 }
      );
    }

    // 7) Audit log
return NextResponse.json(
      {
        ok: true,
        threadId: thread.id,
        accepted_post_id: postId,
        is_locked: lockThread ? true : thread.is_locked,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Unexpected error in mark-answer route", err);
    return NextResponse.json(
      { error: "Unexpected error in mark-answer." },
      { status: 500 }
    );
  }
}
