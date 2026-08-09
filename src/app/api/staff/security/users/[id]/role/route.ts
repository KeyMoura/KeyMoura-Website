import { NextRequest, NextResponse } from "next/server";
import { readJson, asRecord } from "@/lib/json";
import { isString } from "@/lib/typeGuards";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { recordAuditEventStrict, resolveActorLabel } from "@/lib/audit/events";
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

  /*
   * Strict, unlike every other audit write in this codebase.
   *
   * "Somebody's role changed and there is no record of who did it" is the
   * precise question an audit log exists to answer, so this one is allowed to
   * fail the request. The role change has already committed by this point and
   * is not rolled back — what the 500 does is stop the operator being told the
   * change succeeded cleanly when the trail has a hole in it, so they can look.
   *
   * `recordAuditEventStrict` throws; the surrounding try/catch is deliberately
   * absent so the failure is not swallowed by a generic handler.
   */
  await recordAuditEventStrict({
    action: nextRole === "member" && currentRole !== "member" ? "role.removed" : "role.assigned",
    actor: {
      kind: "staff",
      userId: actor.userId,
      role: actor.role,
      label: await resolveActorLabel(actor.userId),
    },
    entity: { type: "user", id, label: await resolveActorLabel(id) },
    changes: { role: { before: currentRole, after: nextRole } },
    source: "staff_ui",
    actorIp: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
