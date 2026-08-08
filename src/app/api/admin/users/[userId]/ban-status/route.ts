import { NextRequest, NextResponse } from "next/server";

import { getActorAccessFromRequest, getUserFromRequest, routeServiceClient } from "@/lib/api/routeAuth";

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v.trim()
  );
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ userId: string }> }) {
  const user = await getUserFromRequest(req);
  if (!user) return jsonError(401, "Unauthorized");

  const { userId: rawUserId } = await ctx.params;
  const targetUserId = (rawUserId ?? "").trim();
  if (!targetUserId || !isUuid(targetUserId)) return jsonError(400, "Invalid user id");

  const actor = await getActorAccessFromRequest(req);
  if (!actor) return jsonError(401, "Unauthorized");
  const canView = actor.permissions.has("moderation.ban") || actor.permissions.has("moderation.ban.request");
  if (!canView) return jsonError(403, "Forbidden");

  const { data: banRow, error: banErr } = await routeServiceClient
    .from("user_bans")
    // `user_bans` records the ban time as `created_at`; `banned_at` does not
    // exist, so this read failed and every account reported as not banned.
    .select("user_id, reason, active, created_at")
    .eq("user_id", targetUserId)
    .eq("active", true)
    .maybeSingle<{ user_id: string; reason: string | null; active: boolean; created_at: string | null }>();

  if (banErr) {
    console.error("ban-status error", banErr);
    return jsonError(500, "Failed to load ban status");
  }

  return NextResponse.json({
    ok: true,
    banned: !!banRow?.active,
    reason: banRow?.reason ?? null,
    // The response key stays `banned_at` — that is what callers read, and it is
    // the better name for what it means. Only the column it comes from changes.
    banned_at: banRow?.created_at ?? null,
  });
}
