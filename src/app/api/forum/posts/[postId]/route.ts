import { NextRequest, NextResponse } from "next/server";
import { hardBlockIfProfane } from "@/lib/profanity";
import { getActorAccessFromRequest, getUserFromRequest, routeServiceClient } from "@/lib/api/routeAuth";

type PatchBody = {
  bodyMarkdown: string;
  editReason?: string | null;
};

export async function PATCH(req: NextRequest) {
  try {
    // --- 0) Extract postId from URL path instead of params ---
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean);
    // Expected: ["api", "forum", "posts", ":postId"]
    const idSegment = segments[segments.length - 1];
    const postIdNum = Number.parseInt(idSegment, 10);

    if (!Number.isFinite(postIdNum) || postIdNum <= 0) {
      return NextResponse.json(
        { error: `Invalid postId in path: "${idSegment}"` },
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
    let body: PatchBody;
    try {
      body = (await req.json()) as PatchBody;
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400 }
      );
    }

    const trimmedBody = (body.bodyMarkdown ?? "").trim();
    const editReason =
      body.editReason && body.editReason.trim().length > 0
        ? body.editReason.trim()
        : null;

    if (!trimmedBody) {
      return NextResponse.json(
        { error: "Post body is required." },
        { status: 400 }
      );
    }

    const prof = await hardBlockIfProfane(trimmedBody);
    if ("error" in prof) {
      return NextResponse.json({ error: prof.error }, { status: 400 });
    }

    // 3) Load post + thread
    const {
      data: postRow,
      error: postErr,
    } = await routeServiceClient
      .from("forum_posts")
      .select("id, thread_id, created_by, is_deleted")
      .eq("id", postIdNum)
      .maybeSingle<{
        id: number;
        thread_id: number;
        created_by: string;
        is_deleted: boolean;
      }>();

    if (postErr) {
      console.error("Error loading post for edit", postErr);
      return NextResponse.json(
        { error: "Failed to load post." },
        { status: 500 }
      );
    }

    if (!postRow || postRow.is_deleted) {
      return NextResponse.json(
        { error: "Post not found." },
        { status: 404 }
      );
    }

    const isOwner = postRow.created_by === actorUserId;
    const canEditAny = actor.permissions.has("community.post.edit");
    const canEditOwn = actor.permissions.has("community.post.edit.own");

    if (!(canEditAny || (isOwner && canEditOwn))) {
      return NextResponse.json(
        { error: "You cannot edit this post." },
        { status: 403 }
      );
    }

    // Ensure thread not locked if non-admin
    const {
      data: threadRow,
      error: threadErr,
    } = await routeServiceClient
      .from("forum_threads")
      .select("id, is_locked")
      .eq("id", postRow.thread_id)
      .maybeSingle<{ id: number; is_locked: boolean }>();

    if (threadErr) {
      console.error("Error loading thread for edit", threadErr);
      return NextResponse.json(
        { error: "Failed to load thread." },
        { status: 500 }
      );
    }

    if (!threadRow) {
      return NextResponse.json(
        { error: "Thread not found." },
        { status: 404 }
      );
    }

    if (threadRow.is_locked && !canEditAny) {
      return NextResponse.json(
        { error: "Thread is locked; you cannot edit this post." },
        { status: 403 }
      );
    }

    const now = new Date().toISOString();

    // 4) Update
    const {
      data: updated,
      error: updateErr,
    } = await routeServiceClient
      .from("forum_posts")
      .update({
        body_markdown: trimmedBody,
        updated_at: now,
        edit_reason: editReason,
      })
      .eq("id", postRow.id)
      .select(
        "id, thread_id, parent_post_id, created_at, updated_at, created_by, body_markdown, is_deleted, edit_reason"
      )
      .maybeSingle<{
        id: number;
        thread_id: number;
        parent_post_id: number | null;
        created_at: string;
        updated_at: string | null;
        created_by: string;
        body_markdown: string;
        is_deleted: boolean;
        edit_reason: string | null;
      }>();

    if (updateErr || !updated) {
      console.error("Error updating post", updateErr);
      return NextResponse.json(
        { error: "Failed to update post." },
        { status: 500 }
      );
    }

    // 5) Audit
return NextResponse.json(
      {
        ok: true,
        post: updated,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Unexpected error in post edit route", err);
    return NextResponse.json(
      { error: "Unexpected error editing post." },
      { status: 500 }
    );
  }
}
