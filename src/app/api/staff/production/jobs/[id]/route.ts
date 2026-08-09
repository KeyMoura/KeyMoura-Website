import { NextRequest, NextResponse } from "next/server";

import { requireAnyPermission, requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { parseJobDraft } from "@/lib/production/jobs";
import {
  EVENT_COLUMNS,
  FILE_COLUMNS,
  JOB_COLUMNS,
  TASK_COLUMNS,
  loadJobReferences,
  logProductionFailure,
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

  if (error) {
    logProductionFailure("job.get", error);
    return NextResponse.json({ error: "Could not load the job." }, { status: 500 });
  }
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

  /*
   * `status` is stripped: this endpoint saves fields, it does not move work.
   *
   * The four link columns are stripped for a sharper reason. `parseJobDraft`
   * resolves each of them with `uuid(input.orderId)`, which answers `null` for
   * an absent key — and the job form has never sent them: `toDraft` builds
   * fourteen fields and none is a link. So every "Save" on the details form
   * wrote `order_id = null, order_item_id = null, product_id = null,
   * customer_id = null` and **silently detached the job from its order**.
   *
   * Nothing surfaced it. The job simply stopped appearing in the order's Shop
   * work panel, and the audit event faithfully recorded `fields: ["order_id",
   * …]` for anyone who thought to look.
   *
   * Links now move only through ./link, which checks the order exists, refuses
   * a relink that raced another one, and writes its own event — the same
   * separation ./status already has, and for the same reason: a save that can
   * change what a record *is* should not be the same call as a save that
   * changes what it *says*.
   */
  const {
    status: _status,
    order_id: _orderId,
    order_item_id: _orderItemId,
    product_id: _productId,
    customer_id: _customerId,
    ...fields
  } = draft;
  void _status;
  void _orderId;
  void _orderItemId;
  void _productId;
  void _customerId;

  const { data, error } = await routeServiceClient
    .from("production_jobs")
    .update(fields)
    .eq("id", id)
    .select(JOB_COLUMNS)
    .single<JobRow>();

  if (error || !data) {
    logProductionFailure("job.update", error);
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
      // `before` and `job` are the whole rows; the helper's allowlist decides
      // which of their fields become a diff, so the free-text notes counted in
      // `changed` are named there and nowhere else.
      before,
      after: job,
      orderId: job.order_id,
      productId: job.product_id,
      metadata: { fields: changed },
    });
  }

  return NextResponse.json({ job, changed });
}

export const dynamic = "force-dynamic";
