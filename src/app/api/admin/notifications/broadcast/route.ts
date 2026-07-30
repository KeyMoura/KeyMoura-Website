// app/api/admin/notifications/broadcast/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getActorAccessFromRequest, getUserFromRequest } from "@/lib/api/routeAuth";
import { createAdminActionRequest } from "@/lib/adminApprovals";
import { logAuditEvent } from "@/lib/audit";

type BroadcastNotificationBody = {
  title: string;
  message?: string | null;
  href?: string | null;
  send_as_server?: boolean | null;
  audience?: "all" | "staff" | "users" | null;
  usernames?: string[] | null; // for audience=users, values like "key" or "@key"
};

export async function POST(req: NextRequest) {
  try {
    const forwardedFor = req.headers.get("x-forwarded-for");
    const realIp = req.headers.get("x-real-ip");
    const requestIp = forwardedFor?.split(",")[0]?.trim() ?? realIp ?? null;

    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const actor = await getActorAccessFromRequest(req);
    if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!actor.permissions.has("notifications.broadcast")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = (await req.json().catch(() => null)) as
      | BroadcastNotificationBody
      | null;

    const title = (body?.title ?? "").trim();
    const message = typeof body?.message === "string" ? body?.message : null;
    const href = typeof body?.href === "string" ? body?.href : null;
    const sendAsServer = !!body?.send_as_server;

    const audienceRaw = typeof body?.audience === "string" ? body?.audience : "all";
    const audience: "all" | "staff" | "users" =
      audienceRaw === "staff" || audienceRaw === "users" ? audienceRaw : "all";

    const usernames = Array.isArray(body?.usernames)
      ? body!.usernames!
          .map((u) => String(u).trim())
          .filter(Boolean)
          .map((u) => (u.startsWith("@") ? u.substring(1) : u).toLowerCase())
      : [];

    if (!title) {
      return NextResponse.json(
        { error: "Title is required." },
        { status: 400 }
      );
    }

    // High-risk: requires 2-admin approval
    const create = await createAdminActionRequest({
      action_type: "notification_broadcast",
      requested_by: user.id,
      requested_ip: requestIp,
      payload: {
        title,
        message,
        href,
        send_as_server: sendAsServer,
        actor_user_id: sendAsServer ? null : user.id,
        audience,
        usernames: audience === "users" ? usernames : [],
      },
    });

    if ("error" in create) {
      return NextResponse.json({ error: create.error }, { status: 500 });
    }

    const requestId = create.row.id;

    await logAuditEvent({
      actorUserId: user.id,
      actorRole: "admin",
      eventType: "admin.notifications.broadcast.request",
      targetTable: "admin_action_requests",
      targetId: requestId,
      metadata: { title, hasMessage: !!message, href, sendAsServer, audience, usernamesCount: usernames.length },
    });

    return NextResponse.json(
      { ok: true, pending: true, requestId: requestId },
      { status: 202 }
    );
  } catch (err) {
    console.error("admin notifications broadcast route error", err);
    return NextResponse.json(
      { error: "Unexpected error sending broadcast notification." },
      { status: 500 }
    );
  }
}
