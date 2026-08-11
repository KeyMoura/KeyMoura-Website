import { NextRequest, NextResponse } from "next/server";

import { getActorAccessFromRequest, getUserFromRequest } from "@/lib/api/routeAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

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
  avatar_url: string | null;
  karma: number | null;
  is_verified: boolean | null;
  donation_rank: string | null;
};

function jsonError(status: number, message: string) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

async function viewerCanBypassBlocks(req: NextRequest): Promise<boolean> {
  const actor = await getActorAccessFromRequest(req);
  if (!actor) return false;
  // Permission-based bypass (no role checks).
  return actor.permissions.has("community.blocks.bypass");
}

async function getBlockedAuthorIds(args: { viewerId: string; authorIds: string[] }) {
  const { viewerId, authorIds } = args;
  if (!viewerId || authorIds.length === 0) return new Set<string>();

  const { data: b1 } = await supabaseAdmin
    .from("user_blocks")
    .select("blocked_user_id")
    .eq("blocker_user_id", viewerId)
    .in("blocked_user_id", authorIds);

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
  const rawSlug =
    body && typeof body === "object" && "categorySlug" in body
      ? (body as { categorySlug?: unknown }).categorySlug
      : null;
  const categorySlug = typeof rawSlug === "string" ? rawSlug.trim() : "";
  if (!categorySlug) return jsonError(400, "Missing categorySlug");

  const { data: categoryRow, error: catErr } = await supabaseAdmin
    .from("forum_categories")
    .select("id, slug, name, description, is_archived, created_at, parent_id")
    .eq("slug", categorySlug)
    .maybeSingle<{ id: number }>();

  if (catErr) {
    console.error("category-threads: failed to load category", catErr);
    return jsonError(500, "Failed to load category");
  }
  if (!categoryRow?.id) return jsonError(404, "Category not found");

  const parentCategoryId =
    categoryRow && "parent_id" in categoryRow ? (categoryRow as { parent_id?: number | null }).parent_id ?? null : null;
  const { data: parentCategory } = parentCategoryId
    ? await supabaseAdmin
        .from("forum_categories")
        .select("id, slug, name, description, is_archived, created_at, parent_id")
        .eq("id", parentCategoryId)
        .maybeSingle()
    : { data: null as null };

  const { data: childCategories } = await supabaseAdmin
    .from("forum_categories")
    .select("id, slug, name, description, is_archived, created_at, parent_id")
    .eq("parent_id", categoryRow.id)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  const { data: threads, error: thErr } = await supabaseAdmin
    .from("forum_threads")
    .select(
      "id, category_id, title, slug, created_at, updated_at, created_by, last_post_at, last_post_by, reply_count, view_count, is_locked, is_pinned, is_deleted, tags"
    )
    .eq("category_id", categoryRow.id)
    .eq("is_deleted", false)
    .order("is_pinned", { ascending: false })
    .order("last_post_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(300);

  if (thErr) {
    console.error("category-threads: failed to load threads", thErr);
    return jsonError(500, "Failed to load threads");
  }

  let rows = (threads ?? []) as ForumThreadRow[];

  const viewerIsStaff = await viewerCanBypassBlocks(req);

  if (!viewerIsStaff) {
    const authorIds = Array.from(new Set(rows.map((t) => String(t.created_by ?? "")).filter((x) => x.length)));
    const blockedAuthors = await getBlockedAuthorIds({ viewerId: viewer.id, authorIds });
    rows = rows.filter((t) => {
      const author = String(t.created_by ?? "");
      if (!author) return true;
      if (author === viewer.id) return true;
      return !blockedAuthors.has(author);
    });
  }

  // Provide profiles + roles to avoid any RLS weirdness on the client.
  const ids = Array.from(
    new Set(
      rows
        .flatMap((t) => [t.created_by, t.last_post_by])
        .filter((x): x is string => typeof x === "string" && x.length > 0)
    )
  );

  const { data: profiles } = ids.length
    ? await supabaseAdmin
        .from("public_profiles")
        .select("id, username, display_name, avatar_url, karma, is_verified, donation_rank")
        .in("id", ids)
    : { data: [] as ProfileRow[] };

  const { data: roles } = ids.length
    ? await supabaseAdmin.from("user_roles").select("user_id, role").in("user_id", ids)
    : { data: [] as Array<{ user_id: string; role: string }> };

  return NextResponse.json({
    ok: true,
    category: categoryRow,
    parent: parentCategory ?? null,
    children: childCategories ?? [],
    threads: rows,
    profiles: profiles ?? [],
    roles: roles ?? [],
  });
}
