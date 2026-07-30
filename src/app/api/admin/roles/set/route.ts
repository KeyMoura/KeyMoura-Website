import { NextRequest, NextResponse } from "next/server";
import { getActorAccessFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { createAdminActionRequest } from "@/lib/adminApprovals";
import { logAuditEvent } from "@/lib/audit";

type SetRoleBody = {
  userId: string;
  role: string;
};

function readString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

async function getCurrentRole(userId: string): Promise<string> {
  const { data, error } = await routeServiceClient
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) return "member";
  const role = (data as unknown as { role?: unknown } | null)?.role;
  return typeof role === "string" && role.length > 0 ? role : "member";
}

export async function POST(req: NextRequest) {
  try {
    const forwardedFor = req.headers.get("x-forwarded-for");
    const realIp = req.headers.get("x-real-ip");
    const requestIp = forwardedFor?.split(",")[0]?.trim() ?? realIp ?? null;

    const actor = await getActorAccessFromRequest(req);
    if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!actor.permissions.has("roles.assign")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = (await req.json().catch(() => null)) as unknown as SetRoleBody | null;
    const targetUserId = readString((body as unknown as { userId?: unknown })?.userId);
    const role = readString((body as unknown as { role?: unknown })?.role);

    if (!targetUserId || !role) {
      return NextResponse.json({ error: "userId and role are required." }, { status: 400 });
    }

    const normalized = role.trim().toLowerCase();
    const allowed = new Set(["member", "support", "moderator", "admin"]);
    if (!allowed.has(normalized)) {
      return NextResponse.json({ error: "Invalid role." }, { status: 400 });
    }

    const currentRole = await getCurrentRole(targetUserId);

    const involvesAdmin = currentRole === "admin" || normalized === "admin";
    if (involvesAdmin) {
      const create = await createAdminActionRequest({
        action_type: "role_change",
        requested_by: actor.userId,
        requested_ip: requestIp,
        payload: { userId: targetUserId, newRole: normalized, previousRole: currentRole },
      });

      if ("error" in create) {
        return NextResponse.json({ error: create.error }, { status: 500 });
      }

      const requestId = create.row.id;

      await logAuditEvent({
        actorUserId: actor.userId,
        actorRole: actor.role,
        eventType: "admin.roles.request",
        targetTable: "admin_action_requests",
        targetId: requestId,
        metadata: { targetUserId, from: currentRole, to: normalized },
      });

      return NextResponse.json(
        { ok: true, pending: true, requestId: requestId, role: normalized },
        { status: 202 }
      );
    }

    const { error } = await routeServiceClient
      .from("user_roles")
      .upsert({ user_id: targetUserId, role: normalized }, { onConflict: "user_id" });

    if (error) {
      console.error("Failed to update role", error);
      return NextResponse.json({ error: "Failed to update role." }, { status: 500 });
    }

    await logAuditEvent({
      actorUserId: actor.userId,
      actorRole: actor.role,
      eventType: "admin.roles.set",
      targetTable: "user_roles",
      targetId: targetUserId,
      metadata: { from: currentRole, to: normalized },
    });

    return NextResponse.json({ ok: true, pending: false, role: normalized }, { status: 200 });
  } catch (err) {
    console.error("roles set route error", err);
    return NextResponse.json({ error: "Unexpected error." }, { status: 500 });
  }
}
