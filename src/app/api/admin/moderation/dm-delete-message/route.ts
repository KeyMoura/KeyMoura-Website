import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { logAuditEvent } from "@/lib/audit";
import { createNotification } from "@/lib/notifications";

function readString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export async function POST(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: roleRow, error: roleErr } = await routeServiceClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle<{ role: string }>();

    const actorRole = !roleErr && roleRow?.role ? String(roleRow.role) : "member";
    const isAdmin = actorRole === "admin";
    if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const bodyUnknown = (await req.json().catch(() => null)) as unknown;
    const body = (bodyUnknown ?? {}) as Record<string, unknown>;
    const messageId = readString(body.messageId);

    if (!messageId) {
      return NextResponse.json({ error: "messageId is required." }, { status: 400 });
    }

    // Fetch message for audit/notification context
    const { data: msg, error: msgErr } = await routeServiceClient
      .from("dm_messages")
      .select("id, thread_id, created_by, is_deleted")
      .eq("id", messageId)
      .maybeSingle<{ id: string; thread_id: string; created_by: string; is_deleted: boolean | null }>();

    if (msgErr) {
      console.error("dm delete load message error", msgErr);
      return NextResponse.json({ error: "Failed to load message." }, { status: 500 });
    }

    if (!msg) {
      return NextResponse.json({ error: "Message not found." }, { status: 404 });
    }

    if (msg.is_deleted === true) {
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    const { error: updErr } = await routeServiceClient
      .from("dm_messages")
      .update({ is_deleted: true })
      .eq("id", messageId);

    if (updErr) {
      console.error("dm delete update error", updErr);
      return NextResponse.json({ error: "Failed to delete message." }, { status: 500 });
    }

    await logAuditEvent({
      actorUserId: user.id,
      actorRole: "admin",
      eventType: "moderation.dm_message.delete",
      targetTable: "dm_messages",
      targetId: messageId,
      metadata: { thread_id: msg.thread_id, message_id: msg.id, author_user_id: msg.created_by },
    });

    // Notify the author (bypass blocks; moderation/system)
    if (msg.created_by && msg.created_by !== user.id) {
      await createNotification({
        recipientUserId: msg.created_by,
        actorUserId: user.id,
        type: "moderation",
        payload: {
          title: "Message Removed",
          message: "A message you sent was removed by staff.",
          href: `/messages/${encodeURIComponent(msg.thread_id)}`,
        },
        bypassBlock: true,
      });
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e: unknown) {
    console.error("dm delete route error", e);
    return NextResponse.json({ error: "Unexpected error." }, { status: 500 });
  }
}
