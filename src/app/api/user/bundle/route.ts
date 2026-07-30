import { NextRequest, NextResponse } from "next/server";

import { getUserFromRequest } from "@/lib/api/routeAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type ProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  bio: string | null;
  location: string | null;
  avatar_url: string | null;
  karma: number | null;
  created_at: string;
  last_seen_at: string | null;
  is_verified: boolean | null;
  donation_rank: string | null;
};

type InfoPageRow = {
  id: string;
  title: string;
  slug: string;
  created_at: string;
  status: string;
  category: string | null;
  chassis: string | null;
  tags: string[] | null;
  content_markdown: string | null;
};

type ThreadRow = {
  id: number;
  category_id: number;
  title: string;
  slug: string;
  created_at: string;
  last_post_at: string | null;
  reply_count: number;
  view_count: number;
};

type ReplyRow = {
  id: number;
  thread_id: number;
  created_at: string;
  body_markdown: string;
  is_deleted: boolean;
};

type GarageCarRow = {
  id: string;
  owner_id: string;
  name: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  chassis: string | null;
  trim: string | null;
  color: string | null;
  engine: string | null;
  power_hp: number | null;
  torque_ftlb: number | null;
  weight_lb: number | null;
  use_type: string | null;
  visibility: string | null;
  is_primary: boolean | null;
  summary: string | null;
  mods: string | null;
  cover_image_url: string | null;
  created_at: string;
  updated_at: string;
};

function jsonError(status: number, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error: message, ...(extra ?? {}) }, { status });
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v.trim()
  );
}

function normalizeUserKey(raw: string): { kind: "uuid" | "username"; value: string } {
  const t = decodeURIComponent(raw).trim();
  if (isUuid(t)) return { kind: "uuid", value: t };
  const u = t.startsWith("@") ? t.slice(1) : t;
  return { kind: "username", value: u };
}

function isStaffRole(role: string | null | undefined): boolean {
  const r = String(role ?? "member").toLowerCase();
  return r === "admin" || r === "moderator" || r === "mod" || r === "support";
}

async function getRoleLower(userId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle<{ role: string }>();
  return String(data?.role ?? "member").toLowerCase();
}

async function hasAnyBlockBetween(a: string, b: string): Promise<boolean> {
  if (!a || !b || a === b) return false;
  const { data } = await supabaseAdmin
    .from("user_blocks")
    .select("id")
    .or(`and(blocker_user_id.eq.${a},blocked_user_id.eq.${b}),and(blocker_user_id.eq.${b},blocked_user_id.eq.${a})`)
    .limit(1);
  return Array.isArray(data) && data.length > 0;
}

export async function POST(req: NextRequest) {
  const viewer = await getUserFromRequest(req);
  if (!viewer) return jsonError(401, "Unauthorized");

  const body = (await req.json().catch(() => null)) as unknown;
  const rawKey =
    body && typeof body === "object" && "userKey" in body
      ? (body as { userKey?: unknown }).userKey
      : null;
  const userKey = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!userKey) return jsonError(400, "Missing userKey");

  const normalized = normalizeUserKey(userKey);

  // Resolve target user id (service-role).
  let targetProfile: ProfileRow | null = null;
  if (normalized.kind === "uuid") {
    const { data } = await supabaseAdmin
      .from("profiles")
      .select(
        "id, username, display_name, bio, location, avatar_url, karma, created_at, last_seen_at, is_verified, donation_rank"
      )
      .eq("id", normalized.value)
      .maybeSingle<ProfileRow>();
    targetProfile = (data ?? null) as ProfileRow | null;
  } else {
    const { data } = await supabaseAdmin
      .from("profiles")
      .select(
        "id, username, display_name, bio, location, avatar_url, karma, created_at, last_seen_at, is_verified, donation_rank"
      )
      .ilike("username", normalized.value)
      .maybeSingle<ProfileRow>();
    targetProfile = (data ?? null) as ProfileRow | null;
  }

  if (!targetProfile?.id) return jsonError(404, "User not found");
  const targetUserId = targetProfile.id;

  const viewerRole = await getRoleLower(viewer.id);
  const targetRole = await getRoleLower(targetUserId);
  const viewerIsStaff = isStaffRole(viewerRole);
  const targetIsStaff = isStaffRole(targetRole);
  const isSelf = viewer.id === targetUserId;

  // Visibility rules:
  // - Staff can always see everything (blocks never suppress staff visibility).
  // - Staff-to-staff blocks do nothing.
  // - Non-staff cannot view content if either side has blocked the other (unless it's self).
  if (!isSelf && !viewerIsStaff) {
    const blocked = await hasAnyBlockBetween(viewer.id, targetUserId);
    if (blocked) return jsonError(403, "Blocked", { blocked: true, targetUserId });
  }
  // If viewer is staff, ignore blocks entirely (including staff<->staff).
  // targetIsStaff is currently only used by the UI for hiding moderation actions.

  // Target role string
  const targetRoleRow = targetRole || "member";

  // Info pages created by this user
  const { data: pagesData } = await supabaseAdmin
    .from("info_pages")
    .select("id, title, slug, created_at, status, category, chassis, tags, content_markdown")
    .eq("created_by", targetUserId)
    .eq("status", "approved")
    .order("created_at", { ascending: false })
    .limit(200);

  const pages = (pagesData ?? []) as InfoPageRow[];

  // Include pages where this user is a contributor
  let contributedPages: InfoPageRow[] = [];
  try {
    const { data: contribRows } = await supabaseAdmin
      .from("info_page_contributors")
      .select("info_page_id")
      .eq("user_id", targetUserId);

    const contribIds = Array.from(
      new Set(
        (contribRows ?? [])
          .map((r) => (r as { info_page_id?: string | null }).info_page_id)
          .filter((v): v is string => typeof v === "string" && v.length > 0)
      )
    );

    if (contribIds.length > 0) {
      const { data: contribPages } = await supabaseAdmin
        .from("info_pages")
        .select("id, title, slug, created_at, status, category, chassis, tags, content_markdown")
        .in("id", contribIds)
        .eq("status", "approved")
        .order("created_at", { ascending: false })
        .limit(200);

      contributedPages = (contribPages ?? []) as InfoPageRow[];
    }
  } catch {
    // ignore
  }

  // Threads created by this user
  const { data: threadRows } = await supabaseAdmin
    .from("forum_threads")
    .select("id, category_id, title, slug, created_at, last_post_at, reply_count, view_count, is_deleted")
    .eq("created_by", targetUserId)
    .eq("is_deleted", false)
    .order("created_at", { ascending: false })
    .limit(200);

  const threads = (threadRows ?? []) as ThreadRow[];
  const catIds = Array.from(new Set(threads.map((t) => t.category_id).filter((n) => Number.isFinite(n))));
  const { data: cats } = catIds.length
    ? await supabaseAdmin.from("forum_categories").select("id, slug").in("id", catIds)
    : { data: [] as Array<{ id: number; slug: string }> };
  const catSlugById = new Map<number, string>();
  for (const c of (cats ?? []) as Array<{ id: number; slug: string }>) {
    catSlugById.set(Number(c.id), String(c.slug ?? ""));
  }

  // Recent replies (posts) created by this user
  const { data: replyRows } = await supabaseAdmin
    .from("forum_posts")
    .select("id, thread_id, created_at, body_markdown, is_deleted")
    .eq("created_by", targetUserId)
    .eq("is_deleted", false)
    .order("created_at", { ascending: false })
    .limit(80);

  const replies = (replyRows ?? []) as ReplyRow[];
  const threadIds = Array.from(new Set(replies.map((r) => r.thread_id).filter((n) => Number.isFinite(n))));
  const { data: threadsForReplies } = threadIds.length
    ? await supabaseAdmin.from("forum_threads").select("id, category_id, title, slug").in("id", threadIds)
    : { data: [] as Array<{ id: number; category_id: number; title: string; slug: string }> };

  const threadById = new Map<number, { id: number; category_id: number; title: string; slug: string }>();
  for (const t of (threadsForReplies ?? []) as Array<{ id: number; category_id: number; title: string; slug: string }>) {
    threadById.set(Number(t.id), t);
  }

  const replyCatIds = Array.from(new Set(Array.from(threadById.values()).map((t) => t.category_id)));
  const { data: cats2 } = replyCatIds.length
    ? await supabaseAdmin.from("forum_categories").select("id, slug").in("id", replyCatIds)
    : { data: [] as Array<{ id: number; slug: string }> };
  const catSlugById2 = new Map<number, string>();
  for (const c of (cats2 ?? []) as Array<{ id: number; slug: string }>) {
    catSlugById2.set(Number(c.id), String(c.slug ?? ""));
  }

  // Garage cars
  let garageCars: GarageCarRow[] = [];
  try {
    let q = supabaseAdmin
      .from("garage_cars")
      .select(
        "id, owner_id, name, make, model, year, chassis, trim, color, engine, power_hp, torque_ftlb, weight_lb, use_type, visibility, is_primary, summary, mods, cover_image_url, created_at, updated_at"
      )
      .eq("owner_id", targetUserId);

    if (!isSelf) {
      q = q.in("visibility", ["public", "unlisted"]);
    }

    const { data: garage } = await q
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: false });

    garageCars = (garage ?? []) as GarageCarRow[];
  } catch {
    // ignore
  }

  return NextResponse.json({
    ok: true,
    viewer: { id: viewer.id, role: viewerRole, is_staff: viewerIsStaff },
    target: { id: targetUserId, role: targetRoleRow, is_staff: targetIsStaff },
    profile: targetProfile,
    pages,
    contributed_pages: contributedPages,
    threads,
    thread_category_slugs: Object.fromEntries(catSlugById.entries()),
    replies,
    reply_threads: Object.fromEntries(
      Array.from(threadById.entries()).map(([id, t]) => [String(id), t])
    ),
    reply_category_slugs: Object.fromEntries(catSlugById2.entries()),
    garage_cars: garageCars,
  });
}
