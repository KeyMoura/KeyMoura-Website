import { NextRequest, NextResponse } from "next/server";

import { getActorAccessFromRequest, getUserFromRequest } from "@/lib/api/routeAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type ForumCategoryRow = {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  sort_order: number;
  is_archived: boolean;
  created_at: string;
  parent_id: number | null;
};

type ForumThreadRow = {
  id: number;
  category_id: number;
  title: string;
  slug: string;
  created_at: string;
  updated_at: string | null;
  created_by: string;
  last_post_at: string | null;
  last_post_by: string | null;
  reply_count: number;
  view_count: number;
  is_locked: boolean;
  is_pinned: boolean;
  is_deleted: boolean;
  tags: string[] | null;
};

type ProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  is_verified: boolean | null;
  donation_rank: string | null;
};

function jsonError(status: number, message: string) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

async function viewerCanBypassBlocks(req: NextRequest): Promise<boolean> {
  const actor = await getActorAccessFromRequest(req).catch(() => null);
  if (!actor) return false;
  return actor.permissions.has("community.blocks.bypass");
}

async function getBlockedAuthorIds(args: { viewerId: string; authorIds: string[] }) {
  const { viewerId, authorIds } = args;
  if (!viewerId || authorIds.length === 0) return new Set<string>();

  // Viewer blocked them
  const { data: b1 } = await supabaseAdmin
    .from("user_blocks")
    .select("blocked_user_id")
    .eq("blocker_user_id", viewerId)
    .in("blocked_user_id", authorIds);

  // They blocked viewer
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

export async function GET(req: NextRequest) {
  // This endpoint backs the public /community feed, so it must work for
  // anonymous visitors too. When not logged in, we simply skip any
  // block-based filtering (since there is no viewer to apply it to).
  const viewer = await getUserFromRequest(req).catch(() => null);
  const viewerId = viewer?.id ?? null;

  const viewerBypassesBlocks = viewerId ? await viewerCanBypassBlocks(req) : false;

  const { data: categories, error: catErr } = await supabaseAdmin
    .from("forum_categories")
    .select("id, slug, name, description, sort_order, is_archived, created_at, parent_id")
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (catErr) {
    console.error("community-feed: failed to load categories", catErr);
    return jsonError(500, "Failed to load categories");
  }

  const { data: threads, error: thErr } = await supabaseAdmin
    .from("forum_threads")
    .select(
      "id, category_id, title, slug, created_at, updated_at, created_by, last_post_at, last_post_by, reply_count, view_count, is_locked, is_pinned, is_deleted, tags"
    )
    .eq("is_deleted", false)
    .order("is_pinned", { ascending: false })
    .order("last_post_at", { ascending: false, nullsFirst: false })
    .limit(400);

  if (thErr) {
    console.error("community-feed: failed to load threads", thErr);
    return jsonError(500, "Failed to load threads");
  }

  let rows = (threads ?? []) as ForumThreadRow[];

  // Only viewers without the bypass permission get block filtering.
  if (viewerId && !viewerBypassesBlocks) {
    const authorIds = Array.from(
      new Set(rows.map((t) => String(t.created_by ?? "")).filter((x) => x.length > 0))
    );
    const blockedAuthors = await getBlockedAuthorIds({ viewerId, authorIds });
    rows = rows.filter((t) => {
      const author = String(t.created_by ?? "");
      if (!author) return true;
      if (author === viewerId) return true;
      return !blockedAuthors.has(author);
    });
  }

  const threadIds = rows.map((t) => t.id);
  const { data: leadScores } = threadIds.length
    ? await supabaseAdmin
        .from("forum_thread_lead_scores")
        .select("thread_id, lead_vote_score")
        .in("thread_id", threadIds)
    : { data: [] as Array<{ thread_id: number; lead_vote_score: number | null }> };

  const userIds = Array.from(
    new Set(
      rows
        .flatMap((t) => [t.created_by, t.last_post_by])
        .filter((x): x is string => typeof x === "string" && x.length > 0)
    )
  );

  const { data: profiles } = userIds.length
    ? await supabaseAdmin
        .from("public_profiles")
        .select("id, username, display_name, is_verified, donation_rank")
        .in("id", userIds)
    : { data: [] as ProfileRow[] };

  return NextResponse.json({
    ok: true,
    categories: (categories ?? []) as ForumCategoryRow[],
    threads: rows,
    leadScores: leadScores ?? [],
    profiles: profiles ?? [],
  });
}
