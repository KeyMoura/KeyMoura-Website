import { NextRequest, NextResponse } from "next/server";

import { requireAnyPermission, requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { isRecord, isString } from "@/lib/typeGuards";

const TABLE = "info_admin_todos";

type TodoStatus = "open" | "in_progress" | "done";

function parseStatus(v: unknown): TodoStatus | null {
  if (!isString(v)) return null;
  const s = v.trim();
  if (s === "open" || s === "in_progress" || s === "done") return s;
  return null;
}

function parsePriority(v: unknown): "low" | "normal" | "high" | null {
  if (v === "low" || v === "normal" || v === "high") return v;
  return null;
}

export async function GET(req: NextRequest) {
  // Viewing the list is allowed for anyone who can view or act on todos.
  const actor = await requireAnyPermission(req, ["todo.view", "todo.edit", "todo.create_task", "todo.mark_done"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Use a broad select so this route won't break if the table evolves.
  const { data, error } = await routeServiceClient.from(TABLE).select("*").order("created_at", { ascending: true });

  if (error) {
    // Surface the underlying message (e.g. missing table) so staff can fix it quickly.
    return NextResponse.json(
      {
        error: error.message || "Failed to load todo list.",
        hint: error.hint ?? null,
        code: (error as any)?.code ?? null,
        details: error.details ?? null,
      },
      { status: 500 }
    );
  }
  return NextResponse.json({ items: data ?? [] });
}

export async function POST(req: NextRequest) {
  const actor = await requirePermission(req, "todo.create_task");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as unknown;
  if (!isRecord(body)) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const title = isString(body.title) ? body.title.trim() : "";
  if (!title) return NextResponse.json({ error: "Title is required" }, { status: 400 });

  const description = isString(body.description) ? body.description.trim() : null;
  const priority = parsePriority(body.priority) ?? "normal";
  const relatedSlug = isString(body.related_info_page_slug) ? body.related_info_page_slug.trim() : null;

  const insertBase: Record<string, any> = {
    title,
    description,
    priority,
    related_info_page_slug: relatedSlug && relatedSlug.length ? relatedSlug : null,
    status: "open",
    created_by: actor.userId,
  };

  // Optional column: track edits to content fields only.
  // If the schema doesn't have it, we retry without.
  insertBase.content_updated_at = new Date().toISOString();

  let data: any = null;
  let error: any = null;
  {
    const res = await routeServiceClient.from(TABLE).insert(insertBase).select("*").single();
    data = res.data;
    error = res.error;
  }

  if (error && String(error.message || "").includes("content_updated_at")) {
    delete insertBase.content_updated_at;
    const res = await routeServiceClient.from(TABLE).insert(insertBase).select("*").single();
    data = res.data;
    error = res.error;
  }

  if (error) {
    return NextResponse.json(
      {
        error: error.message || "Failed to create task",
        hint: error.hint ?? null,
        code: (error as any)?.code ?? null,
        details: error.details ?? null,
      },
      { status: 500 }
    );
  }
  return NextResponse.json({ item: data });
}

export async function PATCH(req: NextRequest) {
  const actor = await requireAnyPermission(req, ["todo.edit", "todo.mark_done"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as unknown;
  if (!isRecord(body)) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const id = isString(body.id) ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  // Load existing row so we can ignore unchanged fields (prevents false "Edited" when only changing status).
  // IMPORTANT: use a broad select so the route doesn't hard-depend on optional columns
  // like `content_updated_at`. Some deployments won't have them.
  const existingRes = await routeServiceClient.from(TABLE).select("*").eq("id", id).maybeSingle();
  if (existingRes.error) {
    return NextResponse.json(
      {
        error: existingRes.error.message || "Failed to load task",
        hint: existingRes.error.hint ?? null,
        code: (existingRes.error as any)?.code ?? null,
        details: existingRes.error.details ?? null,
      },
      { status: 500 }
    );
  }
  if (!existingRes.data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const existing = existingRes.data as any;

  // NOTE: Keep payload compatible with minimal schemas.
  // Some deployments may not have optional columns like `updated_by`.
  const patch: Record<string, any> = {};
  let contentTouched = false;

  if (isString(body.title)) {
    const next = body.title.trim();
    if (next !== (existing.title ?? "")) {
      patch.title = next;
      contentTouched = true;
    }
  }
  if (body.description === null || isString(body.description)) {
    const next = body.description ? String(body.description).trim() : null;
    if ((next ?? null) !== (existing.description ?? null)) {
      patch.description = next;
      contentTouched = true;
    }
  }
  const priority = parsePriority(body.priority);
  if (priority !== null) {
    if (priority !== (existing.priority ?? "normal")) {
      patch.priority = priority;
      contentTouched = true;
    }
  }
  if (isString(body.related_info_page_slug) || body.related_info_page_slug === null) {
    const s = isString(body.related_info_page_slug) ? body.related_info_page_slug.trim() : "";
    const next = s ? s : null;
    if ((next ?? null) !== (existing.related_info_page_slug ?? null)) {
      patch.related_info_page_slug = next;
      contentTouched = true;
    }
  }
  const status = parseStatus(body.status);
  if (status && status !== (existing.status ?? null)) patch.status = status;

  // Notes and completion metadata
  if (body.resolution_notes === null || isString(body.resolution_notes)) {
    const next = body.resolution_notes ? String(body.resolution_notes).trim() : null;
    if ((next ?? null) !== (existing.resolution_notes ?? null)) patch.resolution_notes = next;
  }
  if (body.done_at === null || isString(body.done_at)) {
    const next = body.done_at ? String(body.done_at) : null;
    if ((next ?? null) != (existing.done_at ?? null)) patch.done_at = next;
  }
  if (body.done_by === null || isString(body.done_by)) {
    const next = body.done_by ? String(body.done_by) : null;
    if ((next ?? null) != (existing.done_by ?? null)) patch.done_by = next;
  }
  if (body.done_by_name === null || isString(body.done_by_name)) {
    const next = body.done_by_name ? String(body.done_by_name) : null;
    if ((next ?? null) != (existing.done_by_name ?? null)) patch.done_by_name = next;
  }


  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ item: existingRes.data });
  }
  if (contentTouched) {
    // Optional column. If missing, we retry without.
    patch.content_updated_at = new Date().toISOString();
  }

  let data: any = null;
  let error: any = null;
  {
    const res = await routeServiceClient.from(TABLE).update(patch).eq("id", id).select("*").maybeSingle();
    data = res.data;
    error = res.error;
  }

  if (error && String(error.message || "").includes("content_updated_at")) {
    delete patch.content_updated_at;
    const res = await routeServiceClient.from(TABLE).update(patch).eq("id", id).select("*").maybeSingle();
    data = res.data;
    error = res.error;
  }

  if (error) {
    return NextResponse.json(
      {
        error: error.message || "Failed to update task",
        hint: error.hint ?? null,
        code: (error as any)?.code ?? null,
        details: error.details ?? null,
      },
      { status: 500 }
    );
  }
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ item: data });
}
