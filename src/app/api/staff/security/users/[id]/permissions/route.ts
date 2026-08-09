import { NextRequest, NextResponse } from "next/server";
import { readJson, asRecord } from "@/lib/json";
import { isArray, isRecord, isString } from "@/lib/typeGuards";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { resolveActorLabel } from "@/lib/audit/events";
import { diffPermissionSets, recordPermissionSetChange, requestIp } from "@/lib/audit/security";

function parsePermListPayload(v: unknown): { permissions: string[] } | null {
  const r = asRecord(v);
  if (!r) return null;
  if (!isArray(r.permissions)) return null;
  const perms: string[] = [];
  for (const p of r.permissions) {
    if (isString(p)) perms.push(p);
  }
  return { permissions: perms };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "permissions.grant");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "Invalid user id" }, { status: 400 });

  const { data } = await routeServiceClient
    .from("user_permissions")
    .select("permission_key")
    .eq("user_id", id);

  const permissions: string[] = [];
  if (isArray(data)) {
    for (const row of data) {
      if (isRecord(row) && isString(row.permission_key)) permissions.push(row.permission_key);
    }
  }

  return NextResponse.json({ permissions }, { status: 200 });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "permissions.grant");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "Invalid user id" }, { status: 400 });

  const payload = await readJson(req);
  const parsed = parsePermListPayload(payload);
  if (!parsed) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  // Read before the delete: a direct grant is the strongest thing one staff
  // member can hand another, and the only readable record of it is the
  // difference against what they held a moment ago.
  const { data: existingRows } = await routeServiceClient
    .from("user_permissions")
    .select("permission_key")
    .eq("user_id", id);

  const before: string[] = [];
  if (isArray(existingRows)) {
    for (const row of existingRows) {
      if (isRecord(row) && isString(row.permission_key)) before.push(row.permission_key);
    }
  }

  await routeServiceClient.from("user_permissions").delete().eq("user_id", id);

  if (parsed.permissions.length) {
    const rows = parsed.permissions.map((p) => ({ user_id: id, permission_key: p }));
    const { error } = await routeServiceClient.from("user_permissions").insert(rows);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }

  await recordPermissionSetChange({
    actor,
    action: "permission.changed",
    entityType: "user",
    entityId: id,
    entityLabel: (await resolveActorLabel(id)) ?? id,
    change: diffPermissionSets(before, parsed.permissions),
    actorIp: requestIp(req.headers),
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
