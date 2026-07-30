import { NextRequest, NextResponse } from "next/server";

import { getUserFromRequest } from "@/lib/api/routeAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type ThreadPostRow = {
  id: number;
  thread_id: number;
  parent_post_id: number | null;
  created_at: string;
  updated_at: string | null;
  created_by: string;
  body_markdown: string;
  is_deleted: boolean;
  edit_reason: string | null;
  vote_score?: number | null;
  upvote_count?: number | null;
  downvote_count?: number | null;
};

function jsonError(status: number, message: string) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

function isStaffRole(role: string | null | undefined): boolean {
  const r = String(role ?? "member").toLowerCase();
  return r === "admin" || r === "moderator" || r === "mod" || r === "support";
}

async function getViewerRoleLower(viewerId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", viewerId)
    .maybeSingle<{ role: string }>();
  return String(data?.role ?? "member").toLowerCase();
}

async function getBlockedAuthorIds(args: { viewerId: string; authorIds: string[] }) {
  const { viewerId, authorIds } = args;
  if (!viewerId || authorIds.length === 0) return new Set<string>();

  // Anyone I blocked
  const { data: b1 } = await supabaseAdmin
    .from("user_blocks")
    .select("blocked_user_id")
    .eq("blocker_user_id", viewerId)
    .in("blocked_user_id", authorIds);

  // Anyone who blocked me
  const { data: b2 } = await supabaseAdmin
    .from("user_blocks")
    .select("blocker_user_id")
    .eq("blocked_user_id", viewerId)
    .in("blocker_user_id", authorIds);

  const out = new Set<string>();
  for (const row of (b1 ?? []) as { blocked_user_id: string | null }[]) {
    if (row?.blocked_user_id) out.add(String(row.blocked_user_id));
  }
  for (const row of (b2 ?? []) as { blocker_user_id: string | null }[]) {
    if (row?.blocker_user_id) out.add(String(row.blocker_user_id));
  }
  return out;
}

export async function POST(req: NextRequest) {
  const viewer = await getUserFromRequest(req);
  if (!viewer) return jsonError(401, "Unauthorized");

  const body = (await req.json().catch(() => null)) as unknown;
  const rawThreadId =
    body && typeof body === "object" && "threadId" in body
      ? (body as { threadId?: unknown }).threadId
      : null;
  const threadId = typeof rawThreadId === "number" ? rawThreadId : Number(rawThreadId);
  if (!Number.isFinite(threadId) || threadId <= 0) return jsonError(400, "Missing threadId");

  // Always fetch with service role so staff cannot be hidden by member blocks.
  const { data: posts, error: postsErr } = await supabaseAdmin
    .from("forum_posts")
    .select(
      "id, thread_id, parent_post_id, created_at, updated_at, created_by, body_markdown, is_deleted, edit_reason, vote_score, upvote_count, downvote_count"
    )
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });

  if (postsErr) {
    console.error("thread-posts: failed to load posts", postsErr);
    return jsonError(500, "Failed to load posts");
  }

  const rows = (posts ?? []) as ThreadPostRow[];

  // Staff bypass: staff can always see everything (even if blocked).
  const viewerRole = await getViewerRoleLower(viewer.id);
  const viewerIsStaff = isStaffRole(viewerRole);
  if (viewerIsStaff) {
    return NextResponse.json({ ok: true, posts: rows });
  }

  // Non-staff: apply symmetric block filtering.
  const authorIds = Array.from(
    new Set(rows.map((r) => String(r.created_by ?? "")).filter((id) => id.length > 0))
  );
  const blockedAuthors = await getBlockedAuthorIds({ viewerId: viewer.id, authorIds });

  const filtered = rows.filter((r) => {
    const author = String(r.created_by ?? "");
    if (!author) return true;
    if (author === viewer.id) return true;
    return !blockedAuthors.has(author);
  });

  return NextResponse.json({ ok: true, posts: filtered });
}
