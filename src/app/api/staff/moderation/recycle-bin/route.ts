import { NextRequest, NextResponse } from "next/server";

import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";

export async function GET(req: NextRequest) {
  const actor = await requirePermission(req, "recycle_bin.view");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
  const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
  const { data, error, count } = await routeServiceClient
    .from("moderation_recycle_bin")
    .select("id, item_type, original_table, original_id, deleted_by, deleted_at, expires_at, payload", { count: "exact" })
    .order("deleted_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data ?? [], count: count ?? 0 });
}
