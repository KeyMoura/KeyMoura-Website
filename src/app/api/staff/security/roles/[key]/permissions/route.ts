import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { recordPermissionSetChange, requestIp } from "@/lib/audit/security";
import { readJson, asRecord } from "@/lib/json";
import { isArray, isString } from "@/lib/typeGuards";
import { canSetRolePermissions } from "@/lib/staff/userAccess";

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

  const { data: roleRows, error: roleError } = await routeServiceClient
    .from("roles")
    .select("key,rank")
    .in("key", [...new Set([actor.role, roleKey])]);
  if (roleError) return NextResponse.json({ error: "Could not verify the role hierarchy." }, { status: 500 });
  const ranks = new Map((roleRows ?? []).map((row) => [String(row.key), Number(row.rank)]));
  if (!ranks.has(roleKey)) return NextResponse.json({ error: "That role no longer exists." }, { status: 404 });
  if (!actor.isOp && !ranks.has(actor.role)) {
    return NextResponse.json({ error: "Could not verify your role hierarchy." }, { status: 500 });
  }
  const decision = canSetRolePermissions({
    actor: {
      userId: actor.userId,
      roleKey: actor.role,
      roleRank: ranks.get(actor.role) ?? 0,
      isOp: actor.isOp === true,
      permissions: actor.permissions,
    },
    targetRoleRank: ranks.get(roleKey) ?? 0,
    permissions,
  });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: decision.status });

  /*
   * Read before the delete, so the audit event can say what was *granted* and
   * what was *revoked* rather than restating the resulting list.
   *
   * A permission set stored as "the role now has these 41 keys" is unreadable
   * six months later. "Granted refunds.issue" is the line that matters, and it
   * is only computable against the previous state — which this write destroys.
   */
  const { data: existingRows } = await routeServiceClient
    .from("role_permissions")
    .select("permission_key")
    .eq("role_key", roleKey);

  const previous = new Set((existingRows ?? []).map((row) => String((row as { permission_key: string }).permission_key)));
  const next = new Set(permissions);
  const granted = [...next].filter((key) => !previous.has(key)).sort();
  const revoked = [...previous].filter((key) => !next.has(key)).sort();

  const { error: delErr } = await routeServiceClient.from("role_permissions").delete().eq("role_key", roleKey);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 400 });

  if (permissions.length) {
    const rows = permissions.map((permission_key) => ({ role_key: roleKey, permission_key }));
    const { error: insErr } = await routeServiceClient.from("role_permissions").insert(rows);
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 400 });
  }

  // A save that granted and revoked nothing is not an event, even though the
  // rows were rewritten.
  await recordPermissionSetChange({
    actor,
    action: "permission.changed",
    entityType: "role",
    entityId: roleKey,
    entityLabel: roleKey,
    change: { granted, revoked, beforeCount: previous.size, afterCount: next.size },
    actorIp: requestIp(req.headers),
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
