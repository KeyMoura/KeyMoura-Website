import { NextRequest, NextResponse } from "next/server";

import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import {
  completionWarnings,
  isProductionStatus,
  statusSideEffects,
  transitionProblem,
  type ProductionStatus,
} from "@/lib/production/jobs";
import {
  JOB_COLUMNS,
  TASK_COLUMNS,
  logProductionFailure,
  recordJobAction,
  type JobRow,
} from "@/lib/production/server";

/**
 * Moving a job through the workflow.
 *
 * Separate from PATCH on the job itself so that saving a note can never move
 * work, and so every transition passes the same three guards:
 *
 *   1. the transition is legal for the state the job is actually in
 *   2. a state that must be explained carries its explanation
 *   3. the job has not moved since the browser last read it
 *
 * (3) is what "prevent conflicting status transitions" means in practice. Two
 * staff on the shop floor with the same job open will otherwise both write, and
 * the second silently wins.
 */

const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "production.manage");
  if (!actor) return forbidden();

  const { id } = await context.params;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Send the status to move to." }, { status: 400 });

  const to = body.status;
  if (!isProductionStatus(to)) {
    return NextResponse.json({ error: "That is not a production status." }, { status: 400 });
  }

  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) : "";
  const reopen = body.reopen === true;

  const { data: existing } = await routeServiceClient
    .from("production_jobs")
    .select(JOB_COLUMNS)
    .eq("id", id)
    .maybeSingle<JobRow>();

  if (!existing) return NextResponse.json({ error: "That job no longer exists." }, { status: 404 });
  const job = existing;
  const from = job.status as ProductionStatus;

  const expected = body.expectedStatus;
  if (typeof expected === "string" && expected && expected !== from) {
    return NextResponse.json(
      {
        error: `This job is now ${from.replace(/_/g, " ")}, not ${String(expected).replace(/_/g, " ")}. Reload before changing it.`,
        conflict: true,
        currentStatus: from,
      },
      { status: 409 }
    );
  }

  const problem = transitionProblem(from, to, { reason, reopen });
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  // Completion warnings are advisory. They are returned unacknowledged once so
  // the browser can show them in the confirmation, and the same request with
  // `acknowledge: true` goes through. Nothing here blocks a job from finishing.
  if (to === "completed" && body.acknowledge !== true) {
    const { data: tasks } = await routeServiceClient
      .from("production_job_tasks")
      .select(TASK_COLUMNS)
      .eq("job_id", id);

    const warnings = completionWarnings(
      { materials_acquired: job.materials_acquired, actual_minutes: job.actual_minutes },
      (tasks ?? []).map((task) => ({
        kind: task.kind as "step" | "completion" | "quality",
        is_done: Boolean(task.is_done),
      }))
    );

    if (warnings.length) {
      return NextResponse.json({ warnings, requiresAcknowledgement: true }, { status: 409 });
    }
  }

  const patch = statusSideEffects(from, to, new Date());

  if (to === "on_hold") patch.hold_reason = reason;
  if (to === "rework_required") {
    patch.failure_reason = reason;
    patch.rework_count = (Number(job.rework_count) || 0) + 1;
  }

  const { data, error } = await routeServiceClient
    .from("production_jobs")
    .update(patch)
    .eq("id", id)
    // Re-asserting the from-status in the WHERE clause closes the gap between
    // the read above and this write. If another request moved the job in
    // between, this matches zero rows instead of overwriting their change.
    .eq("status", from)
    .select(JOB_COLUMNS)
    .maybeSingle<JobRow>();

  if (error) {
    logProductionFailure("job.status", error);
    return NextResponse.json({ error: error.message || "Could not change the status." }, { status: 400 });
  }

  if (!data) {
    return NextResponse.json(
      { error: "Somebody changed this job a moment ago. Reload and try again.", conflict: true },
      { status: 409 }
    );
  }

  const updated = data;

  await recordJobAction({
    actor,
    jobId: updated.id,
    jobNumber: updated.job_number,
    eventType: reopen ? "job.reopened" : "job.status_changed",
    auditType: "staff.production.job.status",
    fromStatus: from,
    toStatus: to,
    note: reason || null,
    metadata: { reopened: reopen },
  });

  return NextResponse.json({ job: updated });
}

export const dynamic = "force-dynamic";
