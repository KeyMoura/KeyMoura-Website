import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { isArray, isRecord, isString } from "@/lib/typeGuards";

type Row = { permission_key: string };

export async function GET(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const actor = await requirePermission(req, "roles.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { key } = await ctx.params;
  const roleKey = String(key ?? "").trim().toLowerCase();
  if (!roleKey) return NextResponse.json({ error: "Invalid role key" }, { status: 400 });

  const { data, error } = await routeServiceClient
    .from("role_permissions")
    .select("permission_key")
    .eq("role_key", roleKey)
    .order("permission_key", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const rows: Row[] = [];
  if (isArray(data)) {
    for (const r of data) {
      if (isRecord(r) && isString(r.permission_key)) rows.push({ permission_key: r.permission_key });
    }
  }

  return NextResponse.json({ rows }, { status: 200 });
}
