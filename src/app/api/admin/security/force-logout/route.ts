import { NextRequest, NextResponse } from "next/server";
import { getActorAccessFromRequest, getUserFromRequest } from "@/lib/api/routeAuth";
import { createAdminActionRequest } from "@/lib/adminApprovals";
import { logAuditEvent } from "@/lib/audit";

export async function POST(req: NextRequest) {
  try {
    const forwardedFor = req.headers.get("x-forwarded-for");
    const realIp = req.headers.get("x-real-ip");
    const requestIp = forwardedFor?.split(",")[0]?.trim() ?? realIp ?? null;

    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const actor = await getActorAccessFromRequest(req);
    if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!actor.permissions.has("security.force_logout")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const create = await createAdminActionRequest({
      action_type: "force_logout",
      requested_by: user.id,
      requested_ip: requestIp,
      payload: {},
    });

    if ("error" in create) {
      return NextResponse.json({ error: create.error }, { status: 500 });
    }

    const requestId = create.row.id;

    await logAuditEvent({
      actorUserId: user.id,
      actorRole: "admin",
      eventType: "admin.security.force_logout.request",
      targetTable: "admin_action_requests",
      targetId: requestId,
    });

    return NextResponse.json(
      { ok: true, pending: true, requestId: requestId },
      { status: 202 }
    );
  } catch (err) {
    console.error("force logout request error", err);
    return NextResponse.json({ error: "Unexpected error." }, { status: 500 });
  }
}
