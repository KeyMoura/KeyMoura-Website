import { NextRequest, NextResponse } from "next/server";

import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { recordAuditEvent, resolveActorLabel } from "@/lib/audit/events";
import { noteAuditSummary } from "@/lib/staff/userAccess";
import { isUserUuid } from "@/lib/staff/userDirectory";

/**
 * Archives a staff note.
 *
 * Archiving is the only mutation `user_staff_notes` permits — the trigger
 * refuses every other kind of update, and DELETE is refused twice over (no grant
 * and a trigger). So this is not "soft delete dressed up": the row keeps its
 * text, its author and its timestamp, and gains a record of who filed it away.
 *
 * The `.is("archived_at", null)` guard is what makes the write idempotent and
 * stale-state-safe. Two staff pressing Archive on the same note produce one
 * archive and one 409, rather than a second event claiming the note was archived
 * twice by different people.
 */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; noteId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const actor = await requirePermission(req, "users.notes.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id, noteId } = await ctx.params;
  if (!isUserUuid(id) || !isUserUuid(noteId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const { data: existing } = await routeServiceClient
    .from("user_staff_notes")
    .select("id,user_id,category,body,archived_at")
    .eq("id", noteId)
    .eq("user_id", id)
    .maybeSingle<{
      id: string;
      user_id: string;
      category: string;
      body: string;
      archived_at: string | null;
    }>();

  if (!existing) return NextResponse.json({ error: "Note not found" }, { status: 404 });
  if (existing.archived_at) {
    return NextResponse.json({ error: "That note is already archived." }, { status: 409 });
  }

  const actorLabel = (await resolveActorLabel(actor.userId)) ?? "Staff";

  // Guarded update: the `.is(archived_at, null)` is re-applied here so the write
  // itself refuses a note somebody archived between the read above and this
  // line, rather than trusting the check to still hold.
  const { data: updated, error } = await routeServiceClient
    .from("user_staff_notes")
    .update({
      archived_at: new Date().toISOString(),
      archived_by: actor.userId,
      archived_by_label: actorLabel,
    })
    .eq("id", noteId)
    .eq("user_id", id)
    .is("archived_at", null)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error) {
    console.error("[staff/users/:id/notes/:noteId/archive] update failed", {
      code: (error as { code?: string }).code ?? null,
      message: (error as { message?: string }).message?.slice(0, 300) ?? null,
    });
    return NextResponse.json({ error: "Could not archive the note." }, { status: 500 });
  }

  if (!updated) {
    return NextResponse.json({ error: "That note was archived by somebody else. Reload the page." }, { status: 409 });
  }

  const audit = await recordAuditEvent({
    action: "user.note_archived",
    actor: { kind: "staff", userId: actor.userId, role: actor.role, label: actorLabel },
    entity: { type: "user", id, label: await resolveActorLabel(id) },
    summary: noteAuditSummary({ category: existing.category, bodyLength: existing.body.length }),
    // The note id and its shape, never its text — the note itself is the record.
    metadata: { noteId, category: existing.category, bodyLength: existing.body.length },
    source: "staff_ui",
    actorIp: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });

  return NextResponse.json({ ok: true, auditFailed: audit.ok ? undefined : true }, { status: 200 });
}
