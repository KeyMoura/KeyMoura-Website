import { NextRequest, NextResponse } from "next/server";
import { getActorAccessFromRequest } from "@/lib/api/routeAuth";
import {
  getAdminActionRequestById,
  markAdminActionRejected,
} from "@/lib/adminApprovals";
import { logAuditEvent } from "@/lib/audit";

type RejectBody = {
  requestId: string;
};

function readString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export async function POST(req: NextRequest) {
  try {
    const actor = await getActorAccessFromRequest(req);
    if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!actor.permissions.has("security.approvals.manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = (await req.json()) as unknown as RejectBody;
    const requestId = readString((body as unknown as { requestId?: unknown })?.requestId);

    if (!requestId) {
      return NextResponse.json({ error: "Missing requestId." }, { status: 400 });
    }

    const fetched = await getAdminActionRequestById(requestId);
    if ("error" in fetched) {
      return NextResponse.json({ error: fetched.error }, { status: 404 });
    }

    const row = fetched.row;
    if (row.status !== "pending") {
      return NextResponse.json({ error: "Request is not pending." }, { status: 409 });
    }

    const rejected = await markAdminActionRejected(requestId, actor.userId);
    if ("error" in rejected) {
      return NextResponse.json({ error: rejected.error }, { status: 500 });
    }

    await logAuditEvent({
      actorUserId: actor.userId,
      actorRole: actor.role,
      eventType: "admin.approvals.reject",
      targetTable: "admin_action_requests",
      targetId: requestId,
      metadata: { actionType: row.action_type },
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error("reject action error", err);
    return NextResponse.json({ error: "Unexpected error." }, { status: 500 });
  }
}
