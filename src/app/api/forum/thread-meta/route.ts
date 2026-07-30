import { NextRequest, NextResponse } from "next/server";

import { getActorAccessFromRequest, getUserFromRequest } from "@/lib/api/routeAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { readJson } from "@/lib/json";
import { isRecord, isString } from "@/lib/typeGuards";

type ForumCategoryRow = {
  id: number;
  slug: string;
  name: string;
  description: string | null;
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
  accepted_post_id: number | null;
  locked_by: string | null;
  locked_at: string | null;
  locked_reason: string | null;
  tags: string[] | null;
};

type MiniProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  karma: number;
  is_verified: boolean;
  donation_rank: string | null;
  bio: string | null;
  last_seen_at: string | null;
};

type RoleRow = {
  user_id: string;
  role: string;
};

/**
 * Builds a consistent error response.
 */
function jsonError(status: number, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error: message, ...(extra ?? {}) }, { status });
}

/**
 * Returns true when there is a block relationship between the two user IDs.
 */
async function hasAnyBlockBetween(a: string, b: string): Promise<boolean> {
  if (!a || !b || a === b) return false;
  const { data } = await supabaseAdmin
    .from("user_blocks")
    .select("id")
    .or(
      `and(blocker_user_id.eq.${a},blocked_user_id.eq.${b}),and(blocker_user_id.eq.${b},blocked_user_id.eq.${a})`
    )
    .limit(1);
  return Array.isArray(data) && data.length > 0;
}

/**
 * Parses the thread meta request body.
 */
function parseBody(payload: unknown): { categorySlug: string; threadSlug: string } | null {
  if (!isRecord(payload)) return null;
  const categorySlug = isString(payload.categorySlug) ? payload.categorySlug.trim() : "";
  const threadSlug = isString(payload.threadSlug) ? payload.threadSlug.trim() : "";
  if (!categorySlug || !threadSlug) return null;
  return { categorySlug, threadSlug };
}

export async function POST(req: NextRequest) {
  const viewer = await getUserFromRequest(req);
  if (!viewer) return jsonError(401, "Unauthorized");

  const body = parseBody(await readJson(req));
  if (!body) return jsonError(400, "Missing categorySlug or threadSlug");

  const { data: category, error: catErr } = await supabaseAdmin
    .from("forum_categories")
    .select("id, slug, name, description, is_archived, created_at, parent_id")
    .eq("slug", body.categorySlug)
    .maybeSingle<ForumCategoryRow>();

  if (catErr) {
    console.error("thread-meta: failed to load category", catErr);
    return jsonError(500, "Failed to load category");
  }
  if (!category?.id) return jsonError(404, "Category not found");

  const { data: thread, error: threadErr } = await supabaseAdmin
    .from("forum_threads")
    .select(
      "id, category_id, title, slug, created_at, updated_at, created_by, last_post_at, last_post_by, reply_count, view_count, is_locked, is_pinned, is_deleted, accepted_post_id, locked_by, locked_at, locked_reason, tags"
    )
    .eq("category_id", category.id)
    .eq("slug", body.threadSlug)
    .maybeSingle<ForumThreadRow>();

  if (threadErr) {
    console.error("thread-meta: failed to load thread", threadErr);
    return jsonError(500, "Failed to load thread");
  }
  if (!thread || thread.is_deleted) return jsonError(404, "Thread not found");

  const actor = await getActorAccessFromRequest(req);
  const viewerIsStaff = actor?.permissions.has("community.blocks.bypass") ?? false;

  if (!viewerIsStaff) {
    const blocked = await hasAnyBlockBetween(viewer.id, thread.created_by);
    if (blocked) return jsonError(403, "Blocked", { blocked: true });
  }

  const ids = Array.from(
    new Set([thread.created_by, thread.last_post_by].filter((x): x is string => typeof x === "string" && x.length > 0))
  );

  const profilesResult = ids.length
    ? await supabaseAdmin
        .from("profiles")
        .select("id, username, display_name, avatar_url, karma, is_verified, donation_rank, bio, last_seen_at")
        .in("id", ids)
    : { data: [] as MiniProfileRow[] };

  const rolesResult = ids.length
    ? await supabaseAdmin.from("user_roles").select("user_id, role").in("user_id", ids)
    : { data: [] as RoleRow[] };

  const profiles = (profilesResult.data ?? []) as MiniProfileRow[];
  const roles = (rolesResult.data ?? []) as RoleRow[];

  return NextResponse.json({ ok: true, category, thread, profiles, roles });
}
