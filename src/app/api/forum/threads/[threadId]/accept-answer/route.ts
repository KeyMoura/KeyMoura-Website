// app/api/forum/threads/[threadId]/accept-answer/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createNotification } from "@/lib/notifications";
import { getActorAccessFromRequest, getUserFromRequest, routeServiceClient } from "@/lib/api/routeAuth";

type AcceptBody = {
  postId: number | null;
};

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ threadId: string }> }
) {
  try {
    // ✅ Next 16 dynamic route params are a Promise
    const { threadId } = await context.params;

    const threadIdNum = Number(threadId);
    if (!threadIdNum || Number.isNaN(threadIdNum)) {
      return NextResponse.json(
        { error: "Invalid threadId." },
        { status: 400 }
      );
    }

    // 1) Auth
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
    let body: AcceptBody;
    try {
      const raw = (await req.json()) as {
        postId?: number | null;
      };
      body = {
        postId:
          typeof raw.postId === "number" || raw.postId === null
            ? raw.postId
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
      console.error("Error loading thread for accept-answer", threadErr);
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
      .select("id")
      .eq("user_id", actorUserId)
      .eq("category_id", threadRow.category_id)
      .maybeSingle<{ id: number }>();

    const isCategoryModerator = !!modRow;
    const isOwner = threadRow.created_by === actorUserId;
    const canMarkAny = actor.permissions.has("community.mark_answer");
    const canMarkOwn = actor.permissions.has("community.thread.mark_answer.own");
    const canMarkStaff = canMarkAny || isCategoryModerator;

    if (!(canMarkStaff || (isOwner && canMarkOwn))) {
      return NextResponse.json(
        { error: "You are not allowed to mark an answer for this thread." },
        { status: 403 }
      );
    }

    const now = new Date().toISOString();
    let newAcceptedPostId: number | null = null;
    let acceptedPostAuthorUserId: string | null = null;

    if (body.postId != null) {
      // 5) Validate that the post exists in the thread and is not deleted
      const {
        data: postRow,
        error: postErr,
      } = await routeServiceClient
        .from("forum_posts")
        .select("id, thread_id, created_by, is_deleted")
        .eq("id", body.postId)
        .eq("thread_id", threadRow.id)
        .maybeSingle<{
          id: number;
          thread_id: number;
          created_by: string;
          is_deleted: boolean;
        }>();

      if (postErr) {
        console.error("Error loading post for accept-answer", postErr);
        return NextResponse.json(
          { error: "Failed to load post." },
          { status: 500 }
        );
      }

      if (!postRow || postRow.is_deleted) {
        return NextResponse.json(
          { error: "Post not found in this thread." },
          { status: 404 }
        );
      }

      newAcceptedPostId = postRow.id;
      acceptedPostAuthorUserId = postRow.created_by;
    } else {
      // Unmark answer
      newAcceptedPostId = null;
      acceptedPostAuthorUserId = null;
    }

    // 6) Build update patch
    const updatePatch: Record<string, unknown> = {
      accepted_post_id: newAcceptedPostId,
    };

    if (newAcceptedPostId !== null) {
      // ✅ Marked as answered → lock the thread
      updatePatch.is_locked = true;
      updatePatch.locked_by = actorUserId;
      updatePatch.locked_at = now;
      if (!threadRow.locked_reason) {
        updatePatch.locked_reason = "Marked as answered.";
      }
    } else {
      // ✅ Unmarked answer → unlock the thread
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
      console.error("Error updating accepted_post_id", updateErr);
      return NextResponse.json(
        { error: "Failed to update accepted answer." },
        { status: 500 }
      );
    }

    // 6.5) Handle accepted-answer karma (award / revoke / switch)
    try {
      const prevAccepted = threadRow.accepted_post_id;

      // Unmark OR switch → revoke old award
      if (
        prevAccepted !== null &&
        (newAcceptedPostId === null || newAcceptedPostId !== prevAccepted)
      ) {
        await routeServiceClient.rpc("revoke_accepted_answer_karma", {
          p_thread_id: threadRow.id,
        });
      }

      // Mark OR switch → award new
      if (newAcceptedPostId !== null && newAcceptedPostId !== prevAccepted) {
        await routeServiceClient.rpc("award_accepted_answer_karma", {
          p_thread_id: threadRow.id,
          p_post_id: newAcceptedPostId,
          p_actor_user_id: actorUserId,
        });

        // Notify the accepted answer author
        if (acceptedPostAuthorUserId) {
          void createNotification({
            recipientUserId: acceptedPostAuthorUserId,
            actorUserId,
            type: "accepted_answer",
            threadId: threadRow.id,
            postId: newAcceptedPostId,
            payload: null,
          });
        }
      }
    } catch (e) {
      console.error("Accepted-answer karma update failed", e);
    }

    // 7) Audit
return NextResponse.json(
      {
        ok: true,
        thread: updated,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Unexpected error in accept-answer route", err);
    return NextResponse.json(
      { error: "Unexpected error updating accepted answer." },
      { status: 500 }
    );
  }
}
