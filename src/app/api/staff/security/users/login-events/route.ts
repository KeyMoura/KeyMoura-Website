import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";

export async function GET(req: NextRequest) {
  const actor = await requirePermission(req, "security.ip_logs.view");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const profileId = url.searchParams.get("profile_id") ?? "";
  const limitRaw = Number(url.searchParams.get("limit") ?? "20");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;

  if (!profileId) return NextResponse.json({ error: "Missing profile_id" }, { status: 400 });

  const { data, error } = await routeServiceClient
    .from("auth_login_events")
    .select("id,event_type,ip,user_agent,created_at")
    .eq("profile_id", profileId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}
