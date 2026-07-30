import { NextRequest, NextResponse } from "next/server";
import { getActorAccessFromRequest, getUserFromRequest } from "@/lib/api/routeAuth";
import { createAdminActionRequest } from "@/lib/adminApprovals";
import { logAuditEvent } from "@/lib/audit";

type BroadcastBody = {
  enabled: boolean;
  text: string;
  level: "info" | "warning" | "critical";
};

function readString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export async function POST(req: NextRequest) {
  try {
    const forwardedFor = req.headers.get("x-forwarded-for");
    const realIp = req.headers.get("x-real-ip");
    const requestIp = forwardedFor?.split(",")[0]?.trim() ?? realIp ?? null;

    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const actor = await getActorAccessFromRequest(req);
    if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!actor.permissions.has("security.broadcast")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = (await req.json()) as unknown as BroadcastBody;

    const enabledRaw = (body as unknown as { enabled?: unknown })?.enabled;
    const textRaw = readString((body as unknown as { text?: unknown })?.text) ?? "";
    const levelRaw = readString((body as unknown as { level?: unknown })?.level);

    if (typeof enabledRaw !== "boolean") {
      return NextResponse.json({ error: "enabled must be boolean" }, { status: 400 });
    }

    const text = textRaw.trim();
    const level: "info" | "warning" | "critical" =
      levelRaw === "warning" || levelRaw === "critical" ? levelRaw : "info";

    // High-risk: requires 2-admin approval
    const create = await createAdminActionRequest({
      action_type: "security_broadcast",
      requested_by: user.id,
      requested_ip: requestIp,
      payload: {
        enabled: enabledRaw,
        text,
        level,
      },
    });

    if ("error" in create) {
      return NextResponse.json({ error: create.error }, { status: 500 });
    }

    const requestId = create.row.id;

    await logAuditEvent({
      actorUserId: user.id,
      actorRole: "admin",
      eventType: "admin.security.broadcast.request",
      targetTable: "admin_action_requests",
      targetId: requestId,
      metadata: { enabled: enabledRaw, text, level },
    });

    return NextResponse.json(
      { ok: true, pending: true, requestId: requestId },
      { status: 202 }
    );
  } catch (err) {
    console.error("security broadcast request error", err);
    return NextResponse.json({ error: "Unexpected error." }, { status: 500 });
  }
}
