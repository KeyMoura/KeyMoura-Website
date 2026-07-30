import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { readJson, asRecord } from "@/lib/json";
import { isArray, isString } from "@/lib/typeGuards";

function parsePermissionsPayload(v: unknown): string[] | null {
  const r = asRecord(v);
  if (!r || !isArray(r.permissions)) return null;
  const list: string[] = [];
  for (const p of r.permissions) {
    if (isString(p)) {
      const key = p.trim();
      if (key) list.push(key);
    }
  }
  return list;
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const actor = await requirePermission(req, "roles.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { key } = await ctx.params;
  const roleKey = String(key ?? "").trim().toLowerCase();
  if (!roleKey) return NextResponse.json({ error: "Invalid role key" }, { status: 400 });

  const payload = await readJson(req);
  const permissions = parsePermissionsPayload(payload);
  if (!permissions) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const { error: delErr } = await routeServiceClient.from("role_permissions").delete().eq("role_key", roleKey);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 400 });

  if (permissions.length) {
    const rows = permissions.map((permission_key) => ({ role_key: roleKey, permission_key }));
    const { error: insErr } = await routeServiceClient.from("role_permissions").insert(rows);
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
