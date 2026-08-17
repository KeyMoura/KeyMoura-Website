import { NextRequest, NextResponse } from "next/server";

import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import {
  completionWarnings,
  completionProblem,
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
import { sendLifecycleNotification, type OrderLifecycleRow } from "@/lib/commerce/orderLifecycleServer";
import { raiseOperationalAlert } from "@/lib/comms/operationalAlerts";
import type { CommerceEmailTemplateKey } from "@/lib/commerceEmail";

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

  if (to === "completed") {
    const { data: tasks } = await routeServiceClient
      .from("production_job_tasks")
      .select(TASK_COLUMNS)
      .eq("job_id", id);

    const normalizedTasks = (tasks ?? []).map((task) => ({
      kind: task.kind as "step" | "completion" | "quality",
      is_done: Boolean(task.is_done),
    }));
    const blocker = completionProblem(normalizedTasks);
    if (blocker) {
      return NextResponse.json({ error: blocker, completionBlocked: true }, { status: 409 });
    }

    const warnings = completionWarnings(
      { materials_acquired: job.materials_acquired, actual_minutes: job.actual_minutes },
      normalizedTasks
    );

    if (warnings.length && body.acknowledge !== true) {
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
    action:
      to === "completed"
        ? "production.completed"
        : to === "on_hold"
          ? "production.blocked"
          : from === "on_hold"
            ? "production.unblocked"
            : "production.status_changed",
    fromStatus: from,
    toStatus: to,
    orderId: updated.order_id,
    productId: updated.product_id,
    // The reason reaches the job timeline, which is where staff read it. It is
    // not copied into the audit metadata: a scrap or rework reason is shop-floor
    // detail and the audit log has a wider readership.
    note: reason || null,
    metadata: { reopened: reopen },
  });

  await announceProductionStatus(updated, to, actor.userId);

  return NextResponse.json({ job: updated });
}

/**
 * Which production states the customer hears about, and which stay internal.
 *
 * Production is an internal system. Scrap reasons, rework counts, materials
 * cost and hold reasons are not customer information, and pass 5 built the job
 * timeline separately from the audit log precisely so operational detail could
 * stay in one place. Announcing every transition would leak the shop floor into
 * the customer's inbox — "rework required" tells a customer their part was made
 * wrong, which is a conversation, not a notification.
 *
 * Three states are genuinely customer news and are announced. Everything else
 * is deliberately silent, and the reason is stated here rather than left as an
 * omission somebody later "fixes".
 */
const CUSTOMER_VISIBLE_PRODUCTION: Partial<Record<ProductionStatus, { template: CommerceEmailTemplateKey; title: string; message: string }>> = {
  in_progress: {
    template: "production_started",
    title: "Work has started",
    message: "We have started making your order.",
  },
  waiting_on_customer: {
    template: "production_waiting_on_customer",
    title: "We are waiting on you",
    message: "Work is paused until we hear back from you. Reply on your order page and we will pick it straight back up.",
  },
  completed: {
    template: "production_completed",
    title: "Your order is finished",
    message: "Your order is finished and moving to dispatch.",
  },
};

/**
 * Tell the customer, when the state is one they should hear about.
 *
 * Keyed on the job and the state, so a job that goes in_progress → on_hold →
 * in_progress does not send "we have started" twice. Nothing from the job
 * itself is interpolated: no note, no hold reason, no failure reason, no cost.
 * A test asserts those column names never appear in this file.
 */
async function announceProductionStatus(job: JobRow, to: ProductionStatus, actorUserId: string) {
  if (!job.order_id) return;

  const { data: order } = await routeServiceClient
    .from("orders")
    .select("id,customer_id,guest_email,guest_name,product_name,order_number,ready_to_fulfill_at")
    .eq("id", job.order_id)
    .maybeSingle();
  if (!order) return;

  /*
   * The handoff, before anything to do with messages.
   *
   * Finishing the job is the moment the goods exist, and it is what the
   * fulfillment queue sorts its backlog by. Both of the writes below used to
   * sit behind `if (!order?.customer_id) return` — a guard about whether the
   * *customer* has an account — so a completed guest order told nobody and
   * carried no handoff stamp. Neither fact is about the customer.
   *
   * `.is(..., null)` makes the stamp first-write-wins: a job reopened and
   * completed again keeps the original handoff time rather than looking newly
   * arrived and jumping the queue.
   */
  if (to === "completed") {
    if (!order.ready_to_fulfill_at) {
      await routeServiceClient
        .from("orders")
        .update({ ready_to_fulfill_at: new Date().toISOString() })
        .eq("id", order.id)
        .is("ready_to_fulfill_at", null);
    }

    // Finished work is the fulfillment desk's cue, and it is a different reader
    // from the machinist who just ticked the box. Keyed on the order, so the
    // order separately reaching `ready` does not ring the bell twice.
    await raiseOperationalAlert({
      kind: "order.ready_to_fulfill",
      subjectId: String(order.id),
      actorUserId,
      message: `${order.order_number || "An order"} has finished production and is ready to prepare.`,
    });
  }

  const spec = CUSTOMER_VISIBLE_PRODUCTION[to];
  if (!spec) return;
  // Guest orders are messaged through `guest_email`; `sendLifecycleNotification`
  // already chooses the channel, so the account check that used to be here only
  // ever suppressed mail a guest was entitled to.
  if (!order.customer_id && !order.guest_email) return;

  await sendLifecycleNotification({
    orderId: String(order.id),
    order: order as unknown as Pick<OrderLifecycleRow, "customer_id" | "guest_email" | "guest_name" | "product_name" | "order_number">,
    actorUserId,
    templateKey: spec.template,
    eventKey: `production-${job.id}-${to}`,
    title: spec.title,
    message: spec.message,
  });
}

export const dynamic = "force-dynamic";
