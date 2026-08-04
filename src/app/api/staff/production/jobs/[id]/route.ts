import { NextRequest, NextResponse } from "next/server";

import { requireAnyPermission, requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { parseJobDraft } from "@/lib/production/jobs";
import {
  EVENT_COLUMNS,
  FILE_COLUMNS,
  JOB_COLUMNS,
  TASK_COLUMNS,
  loadJobReferences,
  recordJobAction,
  type JobRow,
} from "@/lib/production/server";

/**
 * A single production job: the operational workspace behind /staff/production/[id].
 *
 * PATCH saves fields only. It deliberately cannot change `status` — that goes
 * through ./status, which enforces the transition rules and demands a reason
 * where one is required. Splitting them is what stops a field save from
 * quietly moving a job through the workflow.
 */

const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });
const missing = () => NextResponse.json({ error: "That job no longer exists." }, { status: 404 });

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAnyPermission(req, ["production.view", "production.manage"]);
  if (!actor) return forbidden();

  const { id } = await context.params;

  const [{ data: jobRow, error }, { data: tasks }, { data: files }, { data: events }] = await Promise.all([
    routeServiceClient.from("production_jobs").select(JOB_COLUMNS).eq("id", id).maybeSingle<JobRow>(),
    routeServiceClient
      .from("production_job_tasks")
      .select(TASK_COLUMNS)
      .eq("job_id", id)
      .order("kind")
      .order("position")
      .order("created_at")
      .returns<Array<Record<string, unknown>>>(),
    routeServiceClient
      .from("production_job_files")
      .select(FILE_COLUMNS)
      .eq("job_id", id)
      .order("created_at")
      .returns<Array<Record<string, unknown>>>(),
    // The timeline is capped. A job reworked twenty times must not turn its own
    // page into an unbounded query.
    routeServiceClient
      .from("production_job_events")
      .select(EVENT_COLUMNS)
      .eq("job_id", id)
      .order("created_at", { ascending: false })
      .limit(200)
      .returns<Array<Record<string, unknown>>>(),
  ]);

  if (error) return NextResponse.json({ error: "Could not load the job." }, { status: 500 });
  if (!jobRow) return missing();

  const job = jobRow;
  const references = await loadJobReferences([job]);

  // Resolve the people named in the timeline too, so it reads as names rather
  // than as a column of uuids.
  const actorIds = [...new Set((events ?? []).map((event) => event.actor_id as string | null).filter(Boolean))];
  const extraPeople = actorIds.length
    ? await routeServiceClient.from("profiles").select("id,username,display_name").in("id", actorIds as string[])
    : { data: [] as Array<Record<string, unknown>> };

  const people = {
    ...references.people,
    ...Object.fromEntries(
      (extraPeople.data ?? []).map((row) => [
        row.id as string,
        (row.display_name as string | null) || (row.username as string | null) || "Unknown",
      ])
    ),
  };

  return NextResponse.json({
    job,
    tasks: tasks ?? [],
    files: files ?? [],
    events: events ?? [],
    people,
    orders: references.orders,
    products: references.products,
    canManage: actor.permissions.has("production.manage"),
  });
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "production.manage");
  if (!actor) return forbidden();

  const { id } = await context.params;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Send the fields to save." }, { status: 400 });

  const { data: existing } = await routeServiceClient
    .from("production_jobs")
    .select(JOB_COLUMNS)
    .eq("id", id)
    .maybeSingle<JobRow>();

  if (!existing) return missing();
  const before = existing;

  // The status the browser was showing when the form was opened. If the job has
  // moved since — somebody else finished it, or a second tab acted first — the
  // save is refused rather than silently applied to a job in a different state.
  const expected = body.expectedUpdatedAt;
  if (typeof expected === "string" && expected && expected !== before.updated_at) {
    return NextResponse.json(
      {
        error: "This job changed while you were editing it. Reload to see the current version before saving.",
        conflict: true,
      },
      { status: 409 }
    );
  }

  const { draft, errors } = parseJobDraft({ ...body, status: before.status });
  if (!draft) return NextResponse.json({ error: errors[0], errors }, { status: 400 });

  // `status` is stripped: this endpoint saves fields, it does not move work.
  const { status: _ignored, ...fields } = draft;
  void _ignored;

  const { data, error } = await routeServiceClient
    .from("production_jobs")
    .update(fields)
    .eq("id", id)
    .select(JOB_COLUMNS)
    .single<JobRow>();

  if (error || !data) {
    return NextResponse.json({ error: error?.message || "Could not save the job." }, { status: 400 });
  }

  const job = data;

  // Record which fields actually changed rather than the values themselves:
  // internal notes and customer notes are free text and do not belong in the
  // audit log, but "somebody edited the internal notes" does.
  const changed = Object.keys(fields).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(job[key])
  );

  if (changed.length) {
    await recordJobAction({
      actor,
      jobId: job.id,
      jobNumber: job.job_number,
      eventType: "job.updated",
      auditType: "staff.production.job.update",
      metadata: { fields: changed },
    });
  }

  return NextResponse.json({ job, changed });
}

export const dynamic = "force-dynamic";
