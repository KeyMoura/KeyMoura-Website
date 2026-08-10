import { NextRequest, NextResponse } from "next/server";

import { createAdminActionRequest } from "@/lib/adminApprovals";
import { getActorAccessFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { recordAuditEvent, resolveActorLabel } from "@/lib/audit/events";
import { asRecord, readJson } from "@/lib/json";
import { createNotification } from "@/lib/notifications";
import { checkStaffRateLimit } from "@/lib/staffRateLimit";
import {
  canChangeStatus,
  statusChangeNeedsApproval,
  STATUS_ACTIONS,
  type StatusAction,
} from "@/lib/staff/userAccess";
import { ACCOUNT_STATUSES, isUserUuid, type AccountStatus } from "@/lib/staff/userDirectory";

/**
 * Account status, changed from the user workspace.
 *
 * ## Status is derived, so "changing" it means writing a ban or a restriction
 *
 * There is no `status` column and this pass did not add one. `user_bans` and
 * `user_restrictions` already decide standing, and a third table holding a
 * summary of the other two would be a second answer that drifts from the first.
 * `staff_user_directory` computes the label; this route writes the underlying
 * fact.
 *
 * ## What restriction and suspension actually mean
 *
 *  * **Restricted** — signed in, and one or more areas withheld. Site, community
 *    and direct messages are separate restrictions and this route names which.
 *  * **Suspended** — cannot sign in.
 *
 * Neither stops transactional order email. That is not an oversight left
 * unhandled: `email_deliveries` is keyed on the order, not on the account's
 * standing, so a customer who paid is still told when their order ships. A shop
 * that takes someone's money and then goes quiet because they were rude in the
 * forum has a second problem, not a solved one.
 *
 * Supabase Auth is **not** touched. No `banned_until`, no forced password reset,
 * no identity unlink. Standing is an application-level fact here, which keeps it
 * reversible and keeps the auth record a record of who someone is rather than of
 * how they behaved.
 *
 * ## Relationship to the existing moderation routes
 *
 * `/api/staff/ban-user` and `/api/staff/restrictions/set` still serve the
 * moderation surfaces and write the same tables. This route is strictly
 * stricter — it additionally requires a reason, enforces role rank, refuses
 * self-service, and checks the caller's view of the current status is still
 * current — and it is the only path the user workspace uses.
 */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const RESTRICTION_KINDS = ["site", "community", "dm"] as const;
type RestrictionKind = (typeof RESTRICTION_KINDS)[number];

const RESTRICTION_LABELS: Readonly<Record<RestrictionKind, string>> = {
  site: "Site restriction",
  community: "Community restriction",
  dm: "Direct message restriction",
};

/** Recomputed the same way `staff_user_directory` does, so the two agree. */
async function readCurrentStatus(userId: string): Promise<AccountStatus> {
  const [banRes, restrictionRes] = await Promise.all([
    routeServiceClient.from("user_bans").select("id").eq("user_id", userId).eq("active", true).limit(1),
    routeServiceClient
      .from("user_restrictions")
      .select("id,expires_at")
      .eq("user_id", userId)
      .eq("active", true),
  ]);

  if ((banRes.data ?? []).length) return "suspended";

  const now = Date.now();
  const live = ((restrictionRes.data ?? []) as { expires_at: string | null }[]).some(
    (r) => !r.expires_at || new Date(r.expires_at).getTime() > now
  );
  return live ? "restricted" : "active";
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const actor = await getActorAccessFromRequest(req);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  if (!isUserUuid(id)) return NextResponse.json({ error: "Invalid user id" }, { status: 400 });

  const body = asRecord(await readJson(req));
  if (!body) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const action = body.action;
  if (typeof action !== "string" || !(STATUS_ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json({ error: "Unknown status action." }, { status: 400 });
  }
  const statusAction = action as StatusAction;

  const kind: RestrictionKind =
    typeof body.kind === "string" && (RESTRICTION_KINDS as readonly string[]).includes(body.kind)
      ? (body.kind as RestrictionKind)
      : "site";

  const durationHours =
    typeof body.durationHours === "number" && Number.isFinite(body.durationHours) && body.durationHours > 0
      ? Math.min(Math.trunc(body.durationHours), 24 * 365)
      : null;

  const rate = await checkStaffRateLimit({
    actorUserId: actor.userId,
    actorRole: actor.role,
    eventTypes: ["user.status_changed", "admin.ban_user.request", "moderation.restriction.request"],
  });
  if (!rate.ok) return NextResponse.json({ error: "Rate limit reached", rate_limit: rate }, { status: 429 });

  // --- the target, and whether this actor may reach it ----------------------
  const { data: target } = await routeServiceClient
    .from("staff_user_directory")
    .select("id,role_key,role_rank,account_status")
    .eq("id", id)
    .maybeSingle<{ id: string; role_key: string; role_rank: number; account_status: string }>();

  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const { data: actorRoleRow } = await routeServiceClient
    .from("roles")
    .select("rank")
    .eq("key", actor.role)
    .maybeSingle<{ rank: number | null }>();

  const decision = canChangeStatus({
    actor: {
      userId: actor.userId,
      roleKey: actor.role,
      roleRank: actor.isOp ? Number.MAX_SAFE_INTEGER : actorRoleRow?.rank ?? 0,
      isOp: actor.isOp === true,
      permissions: actor.permissions,
    },
    target: { userId: target.id, roleKey: target.role_key, roleRank: target.role_rank },
    action: statusAction,
    reason: body.reason,
  });

  if (!decision.allowed) {
    return NextResponse.json({ error: decision.reason }, { status: decision.status });
  }

  const reason = String(body.reason).trim();

  /*
   * Stale-state protection.
   *
   * The caller sends the status it believes is current. If somebody else changed
   * it since the page loaded, this refuses rather than applying a decision made
   * against a stale screen — the difference between "unsuspend this suspended
   * account" and "unsuspend this account that a colleague already unsuspended
   * and then restricted for a different reason".
   */
  const currentStatus = await readCurrentStatus(id);
  const expected = body.expectedStatus;
  if (typeof expected === "string" && (ACCOUNT_STATUSES as readonly string[]).includes(expected)) {
    if (expected !== currentStatus) {
      return NextResponse.json(
        {
          error: `This account is now ${currentStatus}, not ${expected}. Reload the page and look again.`,
          currentStatus,
        },
        { status: 409 }
      );
    }
  }

  const actorLabel = (await resolveActorLabel(actor.userId)) ?? "Staff";
  const targetLabel = await resolveActorLabel(id);
  const actorIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  // --- the approval path ----------------------------------------------------
  //
  // A request is not a change, so it does not write `user.status_changed`. It
  // writes the existing request event and lands in the same approvals queue the
  // moderation surfaces already use.
  if (statusChangeNeedsApproval({ actor: { permissions: actor.permissions }, action: statusAction })) {
    const created = await createAdminActionRequest({
      action_type: statusAction === "suspend" ? "ban_user" : "restriction_set",
      requested_by: actor.userId,
      requested_ip: actorIp,
      target_user_id: id,
      payload: {
        userId: id,
        action: statusAction,
        kind,
        durationHours,
        reason,
        currentlyBanned: currentStatus === "suspended",
      },
      note: reason,
    });

    if ("error" in created) return NextResponse.json({ error: created.error }, { status: 500 });

    await recordAuditEvent({
      action: statusAction === "suspend" ? "admin.ban_user.request" : "moderation.restriction.request",
      actor: { kind: "staff", userId: actor.userId, role: actor.role, label: actorLabel },
      entity: { type: "user", id, label: targetLabel },
      summary: `Requested: ${statusAction}`,
      metadata: { requestId: created.row.id, action: statusAction, kind, durationHours, reason },
      source: "staff_ui",
      actorIp,
    });

    return NextResponse.json({ ok: true, pending: true, requestId: created.row.id }, { status: 202 });
  }

  // --- apply ---------------------------------------------------------------
  let applied = false;
  let detail: Record<string, unknown> = {};

  if (statusAction === "suspend") {
    const { error } = await routeServiceClient.from("user_bans").insert({ user_id: id, reason });
    if (error) {
      console.error("[staff/users/:id/status] suspend failed", { code: (error as { code?: string }).code ?? null });
      return NextResponse.json({ error: "Could not suspend this account." }, { status: 500 });
    }
    applied = true;
    detail = { reason };
  } else if (statusAction === "unsuspend") {
    const { data, error } = await routeServiceClient
      .from("user_bans")
      .update({ active: false })
      .eq("user_id", id)
      .eq("active", true)
      .select("id");
    if (error) {
      console.error("[staff/users/:id/status] unsuspend failed", { code: (error as { code?: string }).code ?? null });
      return NextResponse.json({ error: "Could not lift the suspension." }, { status: 500 });
    }
    // No affected row means there was nothing active to lift. Reporting a clean
    // success there would record a change that did not happen.
    if (!(data ?? []).length) {
      return NextResponse.json({ error: "This account is not suspended." }, { status: 409 });
    }
    applied = true;
  } else if (statusAction === "restrict") {
    const expiresAt = durationHours ? new Date(Date.now() + durationHours * 3600_000).toISOString() : null;
    const { error } = await routeServiceClient.from("user_restrictions").insert({
      user_id: id,
      kind,
      active: true,
      reason,
      created_by: actor.userId,
      expires_at: expiresAt,
    });
    if (error) {
      console.error("[staff/users/:id/status] restrict failed", { code: (error as { code?: string }).code ?? null });
      return NextResponse.json({ error: "Could not apply the restriction." }, { status: 500 });
    }
    applied = true;
    detail = { kind, expiresAt, durationHours };
  } else {
    const { data, error } = await routeServiceClient
      .from("user_restrictions")
      .update({ active: false })
      .eq("user_id", id)
      .eq("kind", kind)
      .eq("active", true)
      .select("id");
    if (error) {
      console.error("[staff/users/:id/status] unrestrict failed", { code: (error as { code?: string }).code ?? null });
      return NextResponse.json({ error: "Could not lift the restriction." }, { status: 500 });
    }
    if (!(data ?? []).length) {
      return NextResponse.json({ error: `No active ${RESTRICTION_LABELS[kind].toLowerCase()} to lift.` }, { status: 409 });
    }
    applied = true;
    detail = { kind };
  }

  if (!applied) return NextResponse.json({ error: "Nothing changed." }, { status: 409 });

  const nextStatus = await readCurrentStatus(id);

  /*
   * Audited after the write is confirmed, with the before and the after.
   *
   * Not strict, deliberately, and the reasoning is the reverse of the role
   * route's. There the mutation is invisible without its audit row; here the ban
   * or restriction row *is* a durable record carrying its own actor and reason,
   * so a failed audit write leaves evidence either way. `auditFailed` is
   * returned rather than swallowed so the operator can still see the gap.
   */
  const audit = await recordAuditEvent({
    action: "user.status_changed",
    actor: { kind: "staff", userId: actor.userId, role: actor.role, label: actorLabel },
    entity: { type: "user", id, label: targetLabel },
    changes: { status: { before: currentStatus, after: nextStatus } },
    metadata: { action: statusAction, reason, ...detail },
    source: "staff_ui",
    actorIp,
  });

  // The person is told, and the notification bypasses blocks — somebody who has
  // blocked staff still needs to know their account standing changed.
  await createNotification({
    recipientUserId: id,
    actorUserId: actor.userId,
    type: "moderation",
    payload: {
      title:
        statusAction === "suspend"
          ? "Account suspended"
          : statusAction === "unsuspend"
            ? "Suspension lifted"
            : statusAction === "restrict"
              ? `${RESTRICTION_LABELS[kind]} applied`
              : `${RESTRICTION_LABELS[kind]} removed`,
      message: reason,
    },
    bypassBlock: true,
  }).catch(() => {
    /* A failed notification must not undo a completed status change. */
  });

  return NextResponse.json(
    { ok: true, status: nextStatus, previousStatus: currentStatus, auditFailed: audit.ok ? undefined : true },
    { status: 200 }
  );
}
