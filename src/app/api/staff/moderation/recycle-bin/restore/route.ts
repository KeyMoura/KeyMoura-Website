import { NextRequest, NextResponse } from "next/server";

import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { logAuditEvent } from "@/lib/audit";
import { deleteRecycleBinItem, getRecycleBinItem } from "@/lib/recycleBin";

function readString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export async function POST(req: NextRequest) {
  const actor = await requirePermission(req, "recycle_bin.restore");
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const bodyUnknown = (await req.json().catch(() => null)) as unknown;
  const body = (bodyUnknown ?? {}) as Record<string, unknown>;
  const recycleId = readString(body.id);
  if (!recycleId) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const got = await getRecycleBinItem(recycleId);
  if ("error" in got) return NextResponse.json({ error: got.error }, { status: 404 });

  const row = got.row;
  const now = new Date().toISOString();

  // Restore the soft-delete flag.
  if (row.item_type === "thread") {
    const { error } = await routeServiceClient
      .from("forum_threads")
      .update({ is_deleted: false, updated_at: now })
      .eq("id", Number(row.original_id));
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else if (row.item_type === "post") {
    const { error } = await routeServiceClient
      .from("forum_posts")
      .update({ is_deleted: false, updated_at: now, edit_reason: null })
      .eq("id", Number(row.original_id));
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else if (row.item_type === "dm_message") {
    const { error } = await routeServiceClient
      .from("dm_messages")
      .update({ is_deleted: false })
      .eq("id", row.original_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    return NextResponse.json({ error: "Unsupported restore type" }, { status: 400 });
  }

  // Remove from recycle bin once restored
  const del = await deleteRecycleBinItem(recycleId);
  if ("error" in del) {
    // Non-fatal: restoration succeeded.
    console.warn("Failed to delete recycle bin item", del.error);
  }

  await logAuditEvent({
    actorUserId: actor.userId,
    actorRole: actor.role,
    eventType: "moderation.recycle_bin.restore",
    targetTable: row.original_table,
    targetId: row.original_id,
    metadata: { recycle_id: row.id, item_type: row.item_type },
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
