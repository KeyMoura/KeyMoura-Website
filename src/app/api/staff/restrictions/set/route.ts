import { NextRequest, NextResponse } from "next/server";
import { getActorAccessFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { createAdminActionRequest } from "@/lib/adminApprovals";
import { createNotification } from "@/lib/notifications";
import { logAuditEvent } from "@/lib/audit";
import { checkStaffRateLimit } from "@/lib/staffRateLimit";
import type { PermissionKey } from "@/lib/permissions";

type RestrictionKind = "site" | "community" | "dm";
type RestrictionAction = "set" | "clear";

type RestrictionBody = {
  userId: string;
  kind: RestrictionKind;
  action: RestrictionAction;
  durationHours?: number | null;
  reason?: string | null;
};

type UserRoleRow = { role: string };

type RestrictionRow = {
  id: string;
  user_id: string;
  kind: string;
  active: boolean | null;
  expires_at: string | null;
};

function readString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function readNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function isRestrictionKind(v: unknown): v is RestrictionKind {
  return v === "site" || v === "community" || v === "dm";
}

function isRestrictionAction(v: unknown): v is RestrictionAction {
  return v === "set" || v === "clear";
}

function formatRestrictionLabel(kind: RestrictionKind): string {
  switch (kind) {
    case "site":
      return "Site Restriction";
    case "community":
      return "Community Restriction";
    case "dm":
      return "DM Restriction";
  }
}

export async function POST(req: NextRequest) {
  try {
    const forwardedFor = req.headers.get("x-forwarded-for");
    const realIp = req.headers.get("x-real-ip");
    const requestIp = forwardedFor?.split(",")[0]?.trim() ?? realIp ?? null;

    const actor = await getActorAccessFromRequest(req);
    if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const actorRole = actor.role;

    const rate = await checkStaffRateLimit({
      actorUserId: actor.userId,
      actorRole,
      eventTypes: ["moderation.restriction.set", "moderation.restriction.clear", "moderation.restriction.request"],
    });
    if (!rate.ok) {
      return NextResponse.json({ error: "Rate limit reached", rate_limit: rate }, { status: 429 });
    }

    const bodyUnknown = (await req.json().catch(() => null)) as unknown;
    const body = (bodyUnknown ?? {}) as Record<string, unknown>;

    const targetUserId = readString(body.userId);
    const kindRaw = body.kind;
    const actionRaw = body.action;
    const durationHours = readNumber(body.durationHours);
    const reason = readString(body.reason);

    if (!targetUserId || !isRestrictionKind(kindRaw) || !isRestrictionAction(actionRaw)) {
      return NextResponse.json({ error: "userId/kind/action are required." }, { status: 400 });
    }

    const directPermission: PermissionKey =
      kindRaw === "site"
        ? "moderation.restrict"
        : kindRaw === "community"
          ? "moderation.restrict.community"
          : "moderation.restrict.dm";

    const requestPermission: PermissionKey =
      kindRaw === "site"
        ? "moderation.restrict.request"
        : kindRaw === "community"
          ? "moderation.restrict.community.request"
          : "moderation.restrict.dm.request";


    const canApplyByPermission = actor.permissions.has(directPermission);
    const canRequestByPermission = actor.permissions.has(requestPermission);
    if (!canApplyByPermission && !canRequestByPermission) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // Permission-based: if you have the direct permission, you may apply; otherwise you may only request.
    const shouldRequest = !canApplyByPermission;

    if (shouldRequest) {
      if (!canRequestByPermission) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      const create = await createAdminActionRequest({
        action_type: "restriction_set",
        requested_by: actor.userId,
        requested_ip: requestIp,
        target_user_id: targetUserId,
        payload: {
          userId: targetUserId,
          kind: kindRaw,
          action: actionRaw,
          durationHours: durationHours ?? null,
          reason: reason ?? null,
        },
        note: reason ?? null,
      });

      if ("error" in create) {
        return NextResponse.json({ error: create.error }, { status: 500 });
      }

      await logAuditEvent({
        actorUserId: actor.userId,
        actorRole,
        eventType: "moderation.restriction.request",
        targetTable: "user_restrictions",
        targetId: targetUserId,
        metadata: { kind: kindRaw, action: actionRaw, durationHours: durationHours ?? null, reason: reason ?? null },
      });

      return NextResponse.json({ ok: true, pending: true, rate_limit: rate }, { status: 200 });
    }

    const kind: RestrictionKind = kindRaw;
    const action: RestrictionAction = actionRaw;

    // Permanent site bans remain handled by the existing ban-user approvals flow.
    if (kind === "site" && action === "set" && (durationHours === null || durationHours === 0)) {
      return NextResponse.json(
        { error: "Permanent site bans must use the Ban/Unban approval flow." },
        { status: 400 }
      );
    }

    const nowIso = new Date().toISOString();
    const expiresAtIso =
      action === "set" && typeof durationHours === "number" && durationHours > 0
        ? new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString()
        : null;

    if (action === "clear") {
      const { error: clearErr } = await routeServiceClient
        .from("user_restrictions")
        .update({ active: false })
        .eq("user_id", targetUserId)
        .eq("kind", kind)
        .eq("active", true);

      if (clearErr) {
        console.error("restriction clear error", clearErr);
        return NextResponse.json({ error: "Failed to clear restriction." }, { status: 500 });
      }

      await createNotification({
        recipientUserId: targetUserId,
        actorUserId: actor.userId,
        type: "moderation",
        payload: {
          title: "Restriction Removed",
          message: `${formatRestrictionLabel(kind)} removed.`,
        },
        bypassBlock: true,
      });

      await logAuditEvent({
        actorUserId: actor.userId,
        actorRole: actorRole === "admin" ? "admin" : "moderator",
        eventType: "moderation.restriction.clear",
        targetTable: "user_restrictions",
        targetId: targetUserId,
        metadata: { kind, at: nowIso },
      });

      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // action === "set"
    const insertRow: Record<string, unknown> = {
      user_id: targetUserId,
      kind,
      active: true,
      reason: reason && reason.trim().length ? reason.trim() : null,
      created_by: actor.userId,
      created_at: nowIso,
      expires_at: expiresAtIso,
    };

    const { data: created, error: insErr } = await routeServiceClient
      .from("user_restrictions")
      .insert(insertRow)
      .select("id, user_id, kind, active, expires_at")
      .maybeSingle<RestrictionRow>();

    if (insErr) {
      console.error("restriction insert error", insErr);
      return NextResponse.json({ error: "Failed to set restriction." }, { status: 500 });
    }

    const expiresText = expiresAtIso ? ` until ${expiresAtIso}` : "";

    await createNotification({
      recipientUserId: targetUserId,
      actorUserId: actor.userId,
      type: "moderation",
      payload: {
        title: "Restriction Applied",
        message: `${formatRestrictionLabel(kind)} applied${expiresText}.`,
        kind,
        expires_at: expiresAtIso,
      },
      bypassBlock: true,
    });

    await logAuditEvent({
      actorUserId: actor.userId,
      actorRole: actorRole === "admin" ? "admin" : "moderator",
      eventType: "moderation.restriction.set",
      targetTable: "user_restrictions",
      targetId: created?.id ?? targetUserId,
      metadata: { kind, expires_at: expiresAtIso, reason: reason ?? null },
    });

    return NextResponse.json({ ok: true, restrictionId: created?.id ?? null }, { status: 200 });
  } catch (e: unknown) {
    console.error("restrictions set route error", e);
    return NextResponse.json({ error: "Unexpected error." }, { status: 500 });
  }
}
