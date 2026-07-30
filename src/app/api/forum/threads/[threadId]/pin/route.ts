// app/api/forum/threads/[threadId]/pin/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getActorAccessFromRequest, getUserFromRequest, routeServiceClient } from "@/lib/api/routeAuth";

type PinBody = {
  pinned: boolean;
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

    const actor = await getActorAccessFromRequest(req);
    if (!actor) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 2) Body
    let body: PinBody;
    try {
      const raw = (await req.json()) as { pinned?: boolean; pin?: boolean };
      const nextPinned = raw.pinned ?? raw.pin;
      body = { pinned: !!nextPinned };
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
      console.error("Error loading thread for pin", threadErr);
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

    // 4) Permission: staff permission (pin)
    const canPin = actor.permissions.has("community.pin_thread");
    if (!canPin) {
      return NextResponse.json(
        { error: "You are not allowed to pin/unpin this thread." },
        { status: 403 }
      );
    }

    const {
      data: updated,
      error: updateErr,
    } = await routeServiceClient
      .from("forum_threads")
      .update({
        is_pinned: body.pinned,
      })
      .eq("id", threadRow.id)
      .select(
        "id, category_id, title, slug, created_at, updated_at, created_by, last_post_at, last_post_by, reply_count, view_count, is_locked, is_pinned, is_deleted, accepted_post_id, locked_by, locked_at, locked_reason"
      )
      .maybeSingle();

    if (updateErr || !updated) {
      console.error("Error updating pin state", updateErr);
      return NextResponse.json(
        { error: "Failed to update pin state." },
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
    console.error("Unexpected error in pin route", err);
    return NextResponse.json(
      { error: "Unexpected error updating pin state." },
      { status: 500 }
    );
  }
}
