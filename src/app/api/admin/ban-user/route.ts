import { NextRequest, NextResponse } from "next/server";
import { getActorAccessFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { createAdminActionRequest } from "@/lib/adminApprovals";
import { logAuditEvent } from "@/lib/audit";
import { checkStaffRateLimit } from "@/lib/staffRateLimit";
import { createNotification } from "@/lib/notifications";

type BanBody = {
  userId: string;
  currentlyBanned: boolean;
  reason?: string | null;
};

function readString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export async function POST(req: NextRequest) {
  try {
    const forwardedFor = req.headers.get("x-forwarded-for");
    const realIp = req.headers.get("x-real-ip");
    const requestIp = forwardedFor?.split(",")[0]?.trim() ?? realIp ?? null;

    const actor = await getActorAccessFromRequest(req);
    if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const actorRole = actor.role;

    // Permission-based moderation actions (no role checks).
    const canDirect = actor.permissions.has("moderation.ban");
    const canRequest = actor.permissions.has("moderation.ban.request") || canDirect;
    if (!canRequest) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const rate = await checkStaffRateLimit({
      actorUserId: actor.userId,
      actorRole,
      eventTypes: ["admin.ban_user.apply", "admin.ban_user.request"],
    });
    if (!rate.ok) {
      return NextResponse.json({ error: "Rate limit reached", rate_limit: rate }, { status: 429 });
    }

    const body = (await req.json()) as unknown as BanBody;
    const userId = readString((body as unknown as { userId?: unknown })?.userId);
    const currentlyBanned = (body as unknown as { currentlyBanned?: unknown })
      ?.currentlyBanned;
    const reason = readString((body as unknown as { reason?: unknown })?.reason);

    if (!userId) {
      return NextResponse.json({ error: "userId is required." }, { status: 400 });
    }

    if (typeof currentlyBanned !== "boolean") {
      return NextResponse.json(
        { error: "currentlyBanned must be a boolean." },
        { status: 400 }
      );
    }

    // Direct bans/unbans require moderation.ban. Otherwise, the action becomes an approval request.
    if (canDirect) {
      const banReason = reason && reason.trim().length > 0 ? reason.trim() : null;

      if (currentlyBanned) {
        const { error: unbanErr } = await routeServiceClient
          .from("user_bans")
          .update({ active: false })
          .eq("user_id", userId)
          .eq("active", true);

        if (unbanErr) {
          console.error("apply unban error", unbanErr);
          return NextResponse.json({ error: "Failed to unban user." }, { status: 500 });
        }

        await createNotification({
          recipientUserId: userId,
          actorUserId: actor.userId,
          type: "moderation",
          payload: {
            title: "Ban Removed",
            message: banReason ? `Ban removed. (${banReason})` : "Ban removed.",
          },
          bypassBlock: true,
        });

        await logAuditEvent({
          actorUserId: actor.userId,
          actorRole,
          eventType: "admin.ban_user.apply",
          targetTable: "user_bans",
          targetId: userId,
          metadata: { userId, action: "unban", reason: banReason },
        });

        return NextResponse.json({ ok: true, pending: false }, { status: 200 });
      }

      const { error: banErr } = await routeServiceClient.from("user_bans").insert({
        user_id: userId,
        reason: banReason,
      });

      if (banErr) {
        console.error("apply ban error", banErr);
        return NextResponse.json({ error: "Failed to ban user." }, { status: 500 });
      }

      await createNotification({
        recipientUserId: userId,
        actorUserId: actor.userId,
        type: "moderation",
        payload: {
          title: "Banned",
          message: banReason ? `You have been banned. (${banReason})` : "You have been banned.",
        },
        bypassBlock: true,
      });

      await logAuditEvent({
        actorUserId: actor.userId,
        actorRole,
        eventType: "admin.ban_user.apply",
        targetTable: "user_bans",
        targetId: userId,
        metadata: { userId, action: "ban", reason: banReason },
      });

      return NextResponse.json({ ok: true, pending: false }, { status: 200 });
    }

    // Moderator flow: high-risk action requires admin approval
    const create = await createAdminActionRequest({
      action_type: "ban_user",
      requested_by: actor.userId,
      requested_ip: requestIp,
      payload: {
        userId,
        currentlyBanned,
        reason: reason ?? null,
      },
    });

    if ("error" in create) {
      return NextResponse.json({ error: create.error }, { status: 500 });
    }

    const requestId = create.row.id;

    await logAuditEvent({
      actorUserId: actor.userId,
      actorRole,
      eventType: "admin.ban_user.request",
      targetTable: "admin_action_requests",
      targetId: requestId,
      metadata: { userId, currentlyBanned, reason: reason ?? null },
    });

    return NextResponse.json(
      { ok: true, pending: true, requestId },
      { status: 202 }
    );
  } catch (err) {
    console.error("ban-user route error", err);
    return NextResponse.json({ error: "Unexpected error." }, { status: 500 });
  }
}
