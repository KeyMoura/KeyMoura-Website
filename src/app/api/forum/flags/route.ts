import { NextRequest, NextResponse } from "next/server";

import { getActorAccessFromRequest, getUserFromRequest } from "@/lib/api/routeAuth";
import { getMaxNumericPermission } from "@/lib/security/permissionManager";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type FlagPayload = {
  targetType: "thread" | "post";
  targetId: string;
  reason?: string;
};

function jsonError(status: number, message: string) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return jsonError(401, "Unauthorized");

  const actor = await getActorAccessFromRequest(req);
  if (!actor) return jsonError(401, "Unauthorized");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const payload = body as Partial<FlagPayload>;
  const targetType = payload.targetType;
  const targetId = (payload.targetId ?? "").trim();
  const reason = (payload.reason ?? "").trim().slice(0, 500) || null;

  if (targetType !== "thread" && targetType !== "post") {
    return jsonError(400, "Invalid targetType");
  }
  if (!targetId) return jsonError(400, "Missing targetId");

  const maxFlagsPerThread = getMaxNumericPermission(actor.permissions, "community.flags.set.");
  if (maxFlagsPerThread <= 0) {
    return jsonError(403, "You do not have permission to flag content.");
  }

  // Insert with a unique (created_by, target_type, target_id) constraint.
  // If it already exists, treat it as success.
  const admin = supabaseAdmin;

  const { data: existingFlag } = await admin
    .from("forum_flags")
    .select("id")
    .eq("created_by", user.id)
    .eq("target_type", targetType)
    .eq("target_id", targetId)
    .maybeSingle();

  if (existingFlag) {
    return NextResponse.json({ ok: true, already: true });
  }

  const threadId = await resolveThreadId(admin, targetType, targetId);
  if (!threadId) return jsonError(404, "Target not found.");

  const currentCount = await countFlagsForThread(admin, user.id, threadId);
  if (currentCount >= maxFlagsPerThread) {
    return jsonError(403, "Flag limit reached for this thread.");
  }

  const { error } = await admin.from("forum_flags").insert({
    created_by: user.id,
    target_type: targetType,
    target_id: targetId,
    reason,
    status: "open",
  });

  if (error) {
    // Unique violation => already flagged
    const code = typeof error.code === "string" ? error.code : "";
    if (code === "23505") {
      return NextResponse.json({ ok: true, already: true });
    }
    console.error("forum flag insert failed", error);
    return jsonError(500, "Failed to flag content");
  }

  return NextResponse.json({ ok: true });
}

async function resolveThreadId(
  admin: typeof supabaseAdmin,
  targetType: FlagPayload["targetType"],
  targetId: string
): Promise<number | null> {
  if (targetType === "thread") {
    const threadId = Number.parseInt(targetId, 10);
    if (!Number.isFinite(threadId)) return null;
    const { data } = await admin
      .from("forum_threads")
      .select("id")
      .eq("id", threadId)
      .maybeSingle<{ id: number }>();
    return data?.id ?? null;
  }

  const postId = Number.parseInt(targetId, 10);
  if (!Number.isFinite(postId)) return null;
  const { data } = await admin
    .from("forum_posts")
    .select("thread_id")
    .eq("id", postId)
    .maybeSingle<{ thread_id: number }>();
  return data?.thread_id ?? null;
}

async function countFlagsForThread(
  admin: typeof supabaseAdmin,
  userId: string,
  threadId: number
): Promise<number> {
  const { data: flagRows } = await admin
    .from("forum_flags")
    .select("target_type, target_id")
    .eq("created_by", userId);

  if (!flagRows || flagRows.length === 0) return 0;

  let count = 0;
  const postIds: number[] = [];

  for (const row of flagRows as Array<{ target_type: string; target_id: string }>) {
    if (row.target_type === "thread") {
      if (String(row.target_id) === String(threadId)) count += 1;
    } else if (row.target_type === "post") {
      const postId = Number.parseInt(String(row.target_id), 10);
      if (Number.isFinite(postId)) postIds.push(postId);
    }
  }

  if (!postIds.length) return count;

  const { data: postRows } = await admin
    .from("forum_posts")
    .select("id, thread_id")
    .in("id", postIds);

  for (const post of (postRows ?? []) as Array<{ id: number; thread_id: number }>) {
    if (post.thread_id === threadId) count += 1;
  }

  return count;
}
