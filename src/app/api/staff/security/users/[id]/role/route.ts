import { NextRequest, NextResponse } from "next/server";
import { readJson, asRecord } from "@/lib/json";
import { isString } from "@/lib/typeGuards";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { createAdminActionRequest } from "@/lib/adminApprovals";

function parseRolePayload(v: unknown): { role: string } | null {
  const r = asRecord(v);
  if (!r) return null;
  const role = isString(r.role) ? r.role.trim().toLowerCase() : "";
  if (!role) return null;
  return { role };
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "roles.assign");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "Invalid user id" }, { status: 400 });

  const payload = await readJson(req);
  const parsed = parseRolePayload(payload);
  if (!parsed) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const { data: currentRow } = await routeServiceClient
    .from("user_roles")
    .select("role")
    .eq("user_id", id)
    .maybeSingle<{ role: string | null }>();

  const currentRole = (currentRow?.role ?? "member").toLowerCase();
  const nextRole = parsed.role.toLowerCase();

  const adminTouched = currentRole === "admin" || nextRole === "admin";

  if (adminTouched) {
    if (actor.role !== "admin") {
      return NextResponse.json({ error: "Only admins can request admin role changes." }, { status: 403 });
    }

    if (currentRole === "admin" && nextRole !== "admin") {
      const { count } = await routeServiceClient
        .from("user_roles")
        .select("user_id", { count: "exact", head: true })
        .eq("role", "admin");

      if (typeof count === "number" && count <= 1) {
        return NextResponse.json({ error: "Cannot remove the last remaining admin." }, { status: 409 });
      }
    }

    const requesterIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip")?.trim() ?? null;

    const created = await createAdminActionRequest({
      action_type: "role_change",
      requested_by: actor.userId,
      requested_ip: requesterIp,
      target_user_id: id,
      payload: { userId: id, newRole: nextRole, fromRole: currentRole },
      note: "Admin role changes require approval by a different admin.",
    });

    if ("error" in created) {
      return NextResponse.json({ error: created.error }, { status: 500 });
    }

    return NextResponse.json({ ok: true, requiresApproval: true, requestId: created.row.id }, { status: 200 });
  }

  const { error } = await routeServiceClient.from("user_roles").upsert(
    { user_id: id, role: nextRole },
    { onConflict: "user_id" }
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true }, { status: 200 });
}
