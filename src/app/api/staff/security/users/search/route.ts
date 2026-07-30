import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission, routeServiceClient } from "@/lib/api/routeAuth";
import { isArray, isRecord, isString } from "@/lib/typeGuards";

type UserRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  location: string | null;
  karma: number | null;
  role: string | null;
  is_verified: boolean | null;
  donation_rank: string | null;
  created_at?: string | null;
  last_seen_at?: string | null;
  last_ip?: string | null;
  last_user_agent?: string | null;
  username_last_changed_at?: string | null;
  is_op?: boolean | null;
};

function normalizeUserRow(v: unknown): UserRow | null {
  if (!isRecord(v)) return null;
  const id = isString(v.id) ? v.id : null;
  if (!id) return null;
  return {
    id,
    username: isString(v.username) ? v.username : null,
    display_name: isString(v.display_name) ? v.display_name : null,
    avatar_url: isString(v.avatar_url) ? v.avatar_url : null,
    bio: isString(v.bio) ? v.bio : null,
    location: isString(v.location) ? v.location : null,
    karma: typeof v.karma === "number" ? v.karma : null,
    role: isString(v.role) ? v.role : null,
    is_verified: typeof v.is_verified === "boolean" ? v.is_verified : null,
    donation_rank: isString(v.donation_rank) ? v.donation_rank : null,
    created_at: isString((v as any).created_at) ? (v as any).created_at : null,
    last_seen_at: isString((v as any).last_seen_at) ? (v as any).last_seen_at : null,
    last_ip: isString((v as any).last_ip) ? (v as any).last_ip : null,
    last_user_agent: isString((v as any).last_user_agent) ? (v as any).last_user_agent : null,
    username_last_changed_at: isString((v as any).username_last_changed_at)
      ? (v as any).username_last_changed_at
      : null,
    is_op: typeof (v as any).is_op === "boolean" ? (v as any).is_op : null,
  };
}

export async function GET(req: NextRequest) {
  // .view grants access to the page and the basic list. .search grants advanced querying.
  const actor = await requireAnyPermission(req, ["users.view", "users.search"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const canViewIp = actor.permissions.has("security.ip_logs.view");

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const cursorRaw = url.searchParams.get("cursor");
  const cursor = (() => {
    if (!cursorRaw) return 0;
    const n = Number(cursorRaw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  })();

  const limit = 20;

  const isSearch = q.length >= 2;

  const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q);

  const like = `%${q}%`;

  // Prefer richer profile fields when available (safe fallback if a column is missing).
  const selectRich = canViewIp
    ? "id,username,display_name,avatar_url,bio,location,karma,is_verified,donation_rank,created_at,last_seen_at,last_ip,last_user_agent,username_last_changed_at,is_op"
    : "id,username,display_name,avatar_url,bio,location,karma,is_verified,donation_rank,created_at,last_seen_at,username_last_changed_at,is_op";
  const selectFallback =
    "id,username,display_name,avatar_url,bio,location,karma,is_verified,donation_rank,created_at";

  const baseQuery = (select: string) =>
    routeServiceClient.from("profiles").select(select).order("created_at", { ascending: false });

  const or = (() => {
    const parts = [`username.ilike.${like}`, `display_name.ilike.${like}`];
    if (looksLikeUuid) parts.push(`id.eq.${q}`);
    return parts.join(",");
  })();

  const run = async (select: string) => {
    const q0 = baseQuery(select);
    return isSearch ? await q0.or(or).limit(25) : await q0.range(cursor, cursor + limit - 1);
  };

  let { data, error } = await run(selectRich);
  // If the instance doesn't have the newer columns yet, fall back gracefully.
  if (error && (error as any).code === "PGRST204") {
    const retry = await run(selectFallback);
    data = retry.data;
    error = retry.error;
  }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const ids: string[] = [];
  const users: UserRow[] = [];
  if (isArray(data)) {
    for (const row of data) {
      const u = normalizeUserRow(row);
      if (u) {
        ids.push(u.id);
        users.push(u);
      }
    }
  }

  if (ids.length) {
    const { data: rolesData } = await routeServiceClient
      .from("user_roles")
      .select("user_id,role")
      .in("user_id", ids);

    if (isArray(rolesData)) {
      const byId = new Map<string, string>();
      for (const r of rolesData) {
        if (isRecord(r) && isString(r.user_id) && isString(r.role)) byId.set(r.user_id, r.role);
      }
      for (const u of users) u.role = byId.get(u.id) ?? u.role;
    }
  }

  const nextCursor = isSearch ? null : cursor + users.length;
  const hasMore = isSearch ? false : users.length === limit;

  return NextResponse.json({ users, nextCursor, hasMore }, { status: 200 });
}
