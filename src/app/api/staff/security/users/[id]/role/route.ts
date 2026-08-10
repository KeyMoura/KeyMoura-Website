import { NextRequest, NextResponse } from "next/server";
import { readJson, asRecord } from "@/lib/json";
import { isString } from "@/lib/typeGuards";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { recordAuditEventStrict, resolveActorLabel } from "@/lib/audit/events";
import { createAdminActionRequest } from "@/lib/adminApprovals";
import { canAssignRole, wouldRemoveLastAdmin } from "@/lib/staff/userAccess";

/**
 * Assigns a user's role.
 *
 * `user_roles` has `user_id` as its primary key, so a user holds exactly one
 * role. "Assign" and "remove" are therefore the same write with a different
 * destination, which is why one route serves both and the audit action is
 * chosen from the direction of travel.
 *
 * ## The four guards, and why each is separate
 *
 * 1. **Permission** — `roles.assign`.
 * 2. **Reach** — you cannot act on somebody at or above your own rank.
 * 3. **Grant** — you cannot hand out a role at or above your own rank.
 * 4. **Last admin** — the final admin cannot be demoted by anyone, owner
 *    included, because an installation with no admin has nobody who can appoint
 *    one and the recovery is a database edit.
 *
 * Guards 2 and 3 look like one rule and are not. Without 2, a moderator demotes
 * an admin. Without 3, a moderator promotes a sock puppet to admin and reaches
 * everything indirectly. Dropping either leaves the escalation open.
 *
 * Admin changes additionally require a second admin's approval, which predates
 * this pass and is unchanged.
 */

function parseRolePayload(v: unknown): { role: string; expectedRole: string | null } | null {
  const r = asRecord(v);
  if (!r) return null;
  const role = isString(r.role) ? r.role.trim().toLowerCase() : "";
  if (!role) return null;
  const expectedRole = isString(r.expectedRole) ? r.expectedRole.trim().toLowerCase() : null;
  return { role, expectedRole };
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

  /*
   * Stale-state protection.
   *
   * The caller states the role it believes the user currently holds. If somebody
   * else changed it since the page loaded, this refuses — otherwise a promotion
   * decided against a stale screen silently overwrites a demotion made thirty
   * seconds ago, and the audit log shows two changes with no sign that the
   * second person never saw the first.
   */
  if (parsed.expectedRole && parsed.expectedRole !== currentRole) {
    return NextResponse.json(
      { error: `This user is now "${currentRole}", not "${parsed.expectedRole}". Reload and look again.`, currentRole },
      { status: 409 }
    );
  }

  // Ranks for the actor, the target and the proposed role. A role the `roles`
  // table does not have is refused outright rather than defaulted to rank 0,
  // which would make an unknown string the weakest possible role and therefore
  // always assignable.
  const { data: roleRows } = await routeServiceClient
    .from("roles")
    .select("key,rank,is_staff")
    .in("key", [...new Set([actor.role, currentRole, nextRole])]);

  const rankByKey = new Map<string, number>();
  for (const row of (roleRows ?? []) as { key: string; rank: number }[]) rankByKey.set(row.key, row.rank);

  if (!rankByKey.has(nextRole)) {
    return NextResponse.json({ error: `There is no role called "${nextRole}".` }, { status: 400 });
  }

  const decision = canAssignRole({
    actor: {
      userId: actor.userId,
      roleKey: actor.role,
      roleRank: actor.isOp ? Number.MAX_SAFE_INTEGER : rankByKey.get(actor.role) ?? 0,
      isOp: actor.isOp === true,
      permissions: actor.permissions,
    },
    target: { userId: id, roleKey: currentRole, roleRank: rankByKey.get(currentRole) ?? 0 },
    nextRoleKey: nextRole,
    nextRoleRank: rankByKey.get(nextRole) ?? 0,
  });

  if (!decision.allowed) {
    return NextResponse.json({ error: decision.reason }, { status: decision.status });
  }

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

      if (wouldRemoveLastAdmin({ currentRoleKey: currentRole, nextRoleKey: nextRole, adminCount: count ?? 0 })) {
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

  return NextResponse.json({ ok: true, role: nextRole }, { status: 200 });
}
