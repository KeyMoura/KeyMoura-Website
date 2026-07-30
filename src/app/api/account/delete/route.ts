import { NextRequest, NextResponse } from "next/server";

import { getUserFromRequest } from "@/lib/api/routeAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { logAuditEvent } from "@/lib/audit";

type DeletePayload = {
  confirm: string;
};

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return jsonError(401, "Unauthorized");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const payload = body as Partial<DeletePayload>;
  if ((payload.confirm ?? "") !== "DELETE") {
    return jsonError(400, "You must type DELETE to confirm.");
  }

  // Server-side deletes:
  // - Remove profile (hard delete)
  // - Remove personal/user-specific rows
  // - Delete auth user
  // Content stays where created_by is nullable (renders as [deleted]).
  const admin = supabaseAdmin;

  // Best effort cleanup. Ignore individual failures so the account delete can proceed.
  await admin.from("user_roles").delete().eq("user_id", user.id);
  await admin
    .from("user_blocks")
    .delete()
    .or(`blocker_user_id.eq.${user.id},blocked_user_id.eq.${user.id}`);
  await admin.from("notifications").delete().eq("user_id", user.id);
  await admin.from("dm_thread_members").delete().eq("user_id", user.id);

  const { error: profileErr } = await admin.from("profiles").delete().eq("id", user.id);
  if (profileErr) {
    console.error("Failed to delete profile", profileErr);
    return jsonError(500, "Failed to delete profile.");
  }

  const { error: authErr } = await admin.auth.admin.deleteUser(user.id);
  if (authErr) {
    console.error("Failed to delete auth user", authErr);
    return jsonError(500, "Failed to delete auth user.");
  }

  await logAuditEvent({
    actorUserId: user.id,
    actorRole: "user",
    eventType: "security.account_delete",
    targetTable: "profiles",
    targetId: user.id,
    metadata: {},
  });

  return NextResponse.json({ ok: true });
}
