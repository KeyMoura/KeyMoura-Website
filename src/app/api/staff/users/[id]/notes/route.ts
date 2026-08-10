import { NextRequest, NextResponse } from "next/server";

import { requireAnyPermission, requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { recordAuditEvent, resolveActorLabel } from "@/lib/audit/events";
import { asRecord, readJson } from "@/lib/json";
import {
  isNoteCategory,
  isValidNoteBody,
  MAX_NOTE_LENGTH,
  noteAuditSummary,
  type NoteCategory,
} from "@/lib/staff/userAccess";
import { isUserUuid } from "@/lib/staff/userDirectory";

/**
 * Internal staff notes about a user.
 *
 * ## Never customer-visible, and structurally so
 *
 * `user_staff_notes` is granted to `service_role` alone; `anon` and
 * `authenticated` have no privilege on it at all, so RLS is the second lock
 * rather than the only one. There is no customer-facing route that reads this
 * table, and there is no column on it that any customer query joins to.
 *
 * ## Append-only
 *
 * A note cannot be edited or deleted — the database refuses both, by trigger and
 * by withheld grant. It can be archived, which is a recorded act with an actor
 * on it. A note saying "customer disputes that this was ever agreed" that can be
 * quietly reworded afterwards is worth less than no note at all.
 *
 * ## What the audit event carries
 *
 * The note id, its category and its **length** — never its text. A note can
 * record a customer's circumstances, and copying that into `audit_logs` would
 * double the number of places it has to be protected and redacted, for no gain:
 * the id is enough to find the note, and the note is the record.
 */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const NOTE_COLUMNS =
  "id,user_id,author_id,author_label,body,category,order_id,archived_at,archived_by_label,created_at";

type NoteRow = {
  id: string;
  user_id: string;
  author_id: string | null;
  author_label: string;
  body: string;
  category: string;
  order_id: string | null;
  archived_at: string | null;
  archived_by_label: string | null;
  created_at: string;
};

export async function GET(req: NextRequest, ctx: Ctx) {
  const actor = await requireAnyPermission(req, ["users.notes.view", "users.notes.manage"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  if (!isUserUuid(id)) return NextResponse.json({ error: "Invalid user id" }, { status: 400 });

  const url = new URL(req.url);
  const includeArchived = url.searchParams.get("archived") === "1";

  let query = routeServiceClient
    .from("user_staff_notes")
    .select(NOTE_COLUMNS)
    .eq("user_id", id)
    .order("created_at", { ascending: false })
    .limit(200);

  if (!includeArchived) query = query.is("archived_at", null);

  const { data, error } = await query;

  if (error) {
    console.error("[staff/users/:id/notes] list failed", {
      code: (error as { code?: string }).code ?? null,
      message: (error as { message?: string }).message?.slice(0, 300) ?? null,
    });
    return NextResponse.json({ error: "Could not load staff notes." }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as NoteRow[];

  // Order numbers for the notes that name one, so a note reads "about KM-0012"
  // rather than about a uuid.
  const orderIds = [...new Set(rows.map((r) => r.order_id).filter((v): v is string => Boolean(v)))];
  const orderNumbers = new Map<string, string>();
  if (orderIds.length) {
    const { data: orders } = await routeServiceClient
      .from("orders")
      .select("id,order_number")
      .in("id", orderIds);
    for (const o of (orders ?? []) as { id: string; order_number: string | null }[]) {
      if (o.order_number) orderNumbers.set(o.id, o.order_number);
    }
  }

  return NextResponse.json({
    notes: rows.map((row) => ({
      id: row.id,
      authorId: row.author_id,
      authorLabel: row.author_label,
      body: row.body,
      category: row.category,
      orderId: row.order_id,
      orderNumber: row.order_id ? orderNumbers.get(row.order_id) ?? null : null,
      archivedAt: row.archived_at,
      archivedByLabel: row.archived_by_label,
      createdAt: row.created_at,
    })),
    canWrite: actor.permissions.has("users.notes.manage"),
  });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const actor = await requirePermission(req, "users.notes.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  if (!isUserUuid(id)) return NextResponse.json({ error: "Invalid user id" }, { status: 400 });

  const body = asRecord(await readJson(req));
  if (!body) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  if (!isValidNoteBody(body.body)) {
    return NextResponse.json(
      { error: `A note must have text and be at most ${MAX_NOTE_LENGTH} characters.` },
      { status: 400 }
    );
  }

  const category: NoteCategory = isNoteCategory(body.category) ? body.category : "general";
  const noteText = body.body.trim();

  // An order may be attached, but only one this account actually owns —
  // otherwise a note could be filed against a stranger's order.
  let orderId: string | null = null;
  if (typeof body.orderId === "string" && isUserUuid(body.orderId)) {
    const { data: order } = await routeServiceClient
      .from("orders")
      .select("id")
      .eq("id", body.orderId)
      .eq("customer_id", id)
      .maybeSingle<{ id: string }>();
    if (!order) {
      return NextResponse.json({ error: "That order does not belong to this user." }, { status: 400 });
    }
    orderId = order.id;
  }

  // The target must exist. A note against a missing profile would be refused by
  // the FK anyway; checking first turns a 23503 into a sentence.
  const { data: target } = await routeServiceClient
    .from("profiles")
    .select("id")
    .eq("id", id)
    .maybeSingle<{ id: string }>();
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const actorLabel = (await resolveActorLabel(actor.userId)) ?? "Staff";

  const { data: inserted, error } = await routeServiceClient
    .from("user_staff_notes")
    .insert({
      user_id: id,
      author_id: actor.userId,
      author_label: actorLabel,
      body: noteText,
      category,
      order_id: orderId,
    })
    .select("id,created_at")
    .maybeSingle<{ id: string; created_at: string }>();

  if (error || !inserted) {
    console.error("[staff/users/:id/notes] insert failed", {
      code: (error as { code?: string } | null)?.code ?? null,
      message: (error as { message?: string } | null)?.message?.slice(0, 300) ?? null,
    });
    return NextResponse.json({ error: "Could not save the note." }, { status: 500 });
  }

  /*
   * Audited after the insert is confirmed, never before.
   *
   * Not strict: a note is additive and recoverable — it is sitting in the table
   * with its author on it. Failing the request would leave the operator thinking
   * the note was lost when it was not. The audit failure is surfaced instead, so
   * they can see the trail has a hole without being told the wrong thing about
   * the note.
   */
  const audit = await recordAuditEvent({
    action: "user.note_created",
    actor: { kind: "staff", userId: actor.userId, role: actor.role, label: actorLabel },
    entity: { type: "user", id, label: await resolveActorLabel(id) },
    related: { orderId },
    summary: noteAuditSummary({ category, bodyLength: noteText.length }),
    // The body is deliberately absent. Only what identifies the note.
    metadata: { noteId: inserted.id, category, bodyLength: noteText.length },
    source: "staff_ui",
    actorIp: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });

  return NextResponse.json(
    { ok: true, id: inserted.id, auditFailed: audit.ok ? undefined : true },
    { status: 201 }
  );
}
