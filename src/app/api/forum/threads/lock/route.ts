import { NextRequest, NextResponse } from "next/server";
import { getActorAccessFromRequest, getUserFromRequest, routeServiceClient } from "@/lib/api/routeAuth";

type Body = {
  threadId: number;
  lock: boolean; // true = lock, false = unlock
  reason?: string | null;
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

    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400 }
      );
    }

    const { threadId, lock, reason } = body;

    if (!threadId || typeof threadId !== "number") {
      return NextResponse.json(
        { error: "threadId (number) is required." },
        { status: 400 }
      );
    }

    // Load thread
    const {
      data: thread,
      error: threadErr,
    } = await routeServiceClient
      .from("forum_threads")
      .select("id, category_id, created_by, is_locked")
      .eq("id", threadId)
      .maybeSingle<{
        id: number;
        category_id: number;
        created_by: string;
        is_locked: boolean;
      }>();

    if (threadErr) {
      console.error("Error loading thread in lock route", threadErr);
      return NextResponse.json(
        { error: "Failed to load thread." },
        { status: 500 }
      );
    }

    if (!thread) {
      return NextResponse.json({ error: "Thread not found." }, { status: 404 });
    }

    // Check permissions: staff permission, category moderator, or thread owner
    const { data: modRow } = await routeServiceClient
      .from("forum_moderators")
      .select("category_id")
      .eq("category_id", thread.category_id)
      .eq("user_id", actorUserId)
      .maybeSingle<{ category_id: number }>();

    const isCategoryMod = !!modRow;
    const isThreadOwner = thread.created_by === actorUserId;
    const canLockAny = actor.permissions.has("community.lock_thread");
    const canLockOwn = actor.permissions.has("community.thread.lock.own");
    const canLockStaff = canLockAny || isCategoryMod;

    if (!(canLockStaff || (isThreadOwner && canLockOwn))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const now = new Date().toISOString();

    const update: Record<string, unknown> = {
      is_locked: lock,
    };

    if (lock) {
      update.locked_by = actorUserId;
      update.locked_at = now;
      update.locked_reason =
        reason ?? "Thread locked by owner/mod/admin.";
    } else {
      update.locked_by = null;
      update.locked_at = null;
      update.locked_reason = null;
    }

    const { error: updateErr } = await routeServiceClient
      .from("forum_threads")
      .update(update)
      .eq("id", thread.id);

    if (updateErr) {
      console.error("Error updating thread lock state", updateErr);
      return NextResponse.json(
        { error: "Failed to update thread lock state." },
        { status: 500 }
      );
    }

    // Audit log
return NextResponse.json(
      {
        ok: true,
        threadId: thread.id,
        is_locked: lock,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Unexpected error in lock thread route", err);
    return NextResponse.json(
      { error: "Unexpected error in lock thread." },
      { status: 500 }
    );
  }
}
