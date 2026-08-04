import { NextRequest, NextResponse } from "next/server";

import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { isProductionTaskKind, TASK_KIND_META } from "@/lib/production/jobs";
import {
  JOB_COLUMNS,
  TASK_COLUMNS,
  logProductionFailure,
  recordJobAction,
  type JobRow,
} from "@/lib/production/server";

/**
 * Manufacturing steps and the completion / quality checklists.
 *
 * One endpoint for all three lists because they differ only by `kind`. Ticking
 * a box is a PATCH, not a status change: a finished checklist does not move the
 * job on its own, because deciding a job is done is a person's call.
 */

const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });

/** A checklist that grows without limit stops being a checklist. */
const MAX_TASKS_PER_KIND = 100;

async function loadJob(id: string): Promise<JobRow | null> {
  const { data } = await routeServiceClient
    .from("production_jobs")
    .select(JOB_COLUMNS)
    .eq("id", id)
    .maybeSingle<JobRow>();
  return data ?? null;
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "production.manage");
  if (!actor) return forbidden();

  const { id } = await context.params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;

  const kind = body?.kind;
  if (!isProductionTaskKind(kind)) {
    return NextResponse.json({ error: "Say which list this belongs to." }, { status: 400 });
  }

  const label = typeof body?.label === "string" ? body.label.trim().slice(0, 300) : "";
  if (!label) return NextResponse.json({ error: "Give the item a label." }, { status: 400 });

  const job = await loadJob(id);
  if (!job) return NextResponse.json({ error: "That job no longer exists." }, { status: 404 });

  const { data: siblings } = await routeServiceClient
    .from("production_job_tasks")
    .select("id,position")
    .eq("job_id", id)
    .eq("kind", kind);

  if ((siblings?.length ?? 0) >= MAX_TASKS_PER_KIND) {
    return NextResponse.json(
      { error: `A ${TASK_KIND_META[kind].label.toLowerCase()} list holds at most ${MAX_TASKS_PER_KIND} items.` },
      { status: 400 }
    );
  }

  const position = (siblings ?? []).reduce((highest, row) => Math.max(highest, Number(row.position) || 0), -1) + 1;

  const { data, error } = await routeServiceClient
    .from("production_job_tasks")
    .insert({
      job_id: id,
      kind,
      label,
      detail: typeof body?.detail === "string" ? body.detail.trim().slice(0, 2000) || null : null,
      position,
    })
    .select(TASK_COLUMNS)
    .single();

  if (error) {
    logProductionFailure("task.add", error);
    return NextResponse.json({ error: error.message || "Could not add the item." }, { status: 400 });
  }

  await recordJobAction({
    actor,
    jobId: job.id,
    jobNumber: job.job_number,
    eventType: "job.task_added",
    auditType: "staff.production.job.task_add",
    metadata: { kind, label },
  });

  return NextResponse.json({ task: data }, { status: 201 });
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "production.manage");
  if (!actor) return forbidden();

  const { id } = await context.params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;

  const taskId = typeof body?.taskId === "string" ? body.taskId : "";
  if (!taskId) return NextResponse.json({ error: "Say which item to update." }, { status: 400 });

  const job = await loadJob(id);
  if (!job) return NextResponse.json({ error: "That job no longer exists." }, { status: 404 });

  const { data: existing } = await routeServiceClient
    .from("production_job_tasks")
    .select(TASK_COLUMNS)
    .eq("id", taskId)
    // Scoped to the job in the URL so a task id from another job cannot be
    // reached by guessing it.
    .eq("job_id", id)
    .maybeSingle();

  if (!existing) return NextResponse.json({ error: "That item no longer exists." }, { status: 404 });

  const patch: Record<string, unknown> = {};

  if (typeof body?.isDone === "boolean") {
    patch.is_done = body.isDone;
    // The database constraint requires these to agree; setting both here means
    // a tick always carries who ticked it and when.
    patch.done_at = body.isDone ? new Date().toISOString() : null;
    patch.done_by = body.isDone ? actor.userId : null;
  }

  if (typeof body?.label === "string") {
    const label = body.label.trim().slice(0, 300);
    if (!label) return NextResponse.json({ error: "Give the item a label." }, { status: 400 });
    patch.label = label;
  }

  if (typeof body?.detail === "string") patch.detail = body.detail.trim().slice(0, 2000) || null;

  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  }

  const { data, error } = await routeServiceClient
    .from("production_job_tasks")
    .update(patch)
    .eq("id", taskId)
    .eq("job_id", id)
    .select(TASK_COLUMNS)
    .single();

  if (error) {
    logProductionFailure("task.update", error);
    return NextResponse.json({ error: error.message || "Could not update the item." }, { status: 400 });
  }

  // Only a tick is worth a timeline row. Fixing a typo in a label is not the
  // kind of thing anybody reads a job history to find.
  if (typeof body?.isDone === "boolean") {
    await recordJobAction({
      actor,
      jobId: job.id,
      jobNumber: job.job_number,
      eventType: body.isDone ? "job.task_completed" : "job.task_reopened",
      auditType: "staff.production.job.task_update",
      metadata: { kind: existing.kind, label: existing.label, done: body.isDone },
    });
  }

  return NextResponse.json({ task: data });
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "production.manage");
  if (!actor) return forbidden();

  const { id } = await context.params;
  const taskId = req.nextUrl.searchParams.get("taskId") ?? "";
  if (!taskId) return NextResponse.json({ error: "Say which item to remove." }, { status: 400 });

  const job = await loadJob(id);
  if (!job) return NextResponse.json({ error: "That job no longer exists." }, { status: 404 });

  const { data: existing } = await routeServiceClient
    .from("production_job_tasks")
    .select(TASK_COLUMNS)
    .eq("id", taskId)
    .eq("job_id", id)
    .maybeSingle();

  if (!existing) return NextResponse.json({ error: "That item no longer exists." }, { status: 404 });

  const { error } = await routeServiceClient
    .from("production_job_tasks")
    .delete()
    .eq("id", taskId)
    .eq("job_id", id);

  if (error) {
    logProductionFailure("task.remove", error);
    return NextResponse.json({ error: "Could not remove the item." }, { status: 400 });
  }

  await recordJobAction({
    actor,
    jobId: job.id,
    jobNumber: job.job_number,
    eventType: "job.task_removed",
    auditType: "staff.production.job.task_remove",
    metadata: { kind: existing.kind, label: existing.label },
  });

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
