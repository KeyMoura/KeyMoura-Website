import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { recordAuditEvent } from "@/lib/audit/events";
import { cancelJob } from "@/lib/automation/store";

/**
 * The two manual controls a staff member gets over a scheduled job: retry it, or
 * cancel it.
 *
 * ## What this deliberately is not
 *
 * There is no "run any job" interface. A staff member cannot invent a job, name
 * an entity, choose a job type, or make one fire against a row of their
 * choosing. Both actions here take an existing row id and do one predetermined
 * thing to it. The reason is the obvious one: an endpoint that can be told which
 * customer to email, and what to email them about, is a different and much more
 * dangerous endpoint than this one.
 *
 * ## Why retry is safe
 *
 * It does not send anything. It moves a `failed` row back to `pending` with
 * `run_at` of now, and the worker picks it up on its next pass — where it goes
 * through the same handler, the same re-validation of current state, and the
 * same `email_deliveries` claim as any other job. So retrying a reminder for an
 * order that has since been paid sends nothing and cancels the job, and
 * retrying one that already succeeded is caught by the delivery claim.
 *
 * `attempt_count` is deliberately reset. The bounded-retry policy exists to stop
 * a machine looping; a person deciding to try again after fixing the underlying
 * problem is not that, and making them press the button five times to get one
 * more attempt would be a worse interface for no safety gain.
 */

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, { params }: Params) {
  const actor = await requirePermission(req, "automation.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid job." }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  const action = body?.action;
  if (action !== "retry" && action !== "cancel") {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  const { data: job } = await routeServiceClient
    .from("scheduled_jobs")
    .select("id,job_type,state,entity_type,entity_id,attempt_count")
    .eq("id", id)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: "That job no longer exists." }, { status: 404 });

  const row = job as {
    id: string;
    job_type: string;
    state: string;
    entity_type: string;
    entity_id: string | null;
    attempt_count: number;
  };

  if (action === "cancel") {
    /*
     * Only work that has not happened. A completed job cannot be un-sent, and
     * offering to "cancel" one would imply it could.
     */
    if (!["pending", "failed"].includes(row.state)) {
      return NextResponse.json(
        { error: `A ${row.state} job cannot be cancelled.` },
        { status: 409 }
      );
    }
    const cancelled =
      row.state === "pending"
        ? await cancelJob(row.id, `Cancelled by staff.`)
        : await forceCancel(row.id);
    if (!cancelled) {
      return NextResponse.json({ error: "Somebody else changed this job while you were looking at it." }, { status: 409 });
    }

    await recordAuditEvent({
      action: "automation.job_cancelled",
      actor: { kind: "staff", userId: actor.userId, role: actor.role },
      entity: { type: row.entity_type, id: row.entity_id, label: row.job_type },
      summary: `Cancelled a scheduled ${row.job_type}.`,
      source: "staff_ui",
      metadata: { job_type: row.job_type, previous_state: row.state },
    });
    return NextResponse.json({ ok: true, state: "cancelled" });
  }

  if (row.state !== "failed") {
    return NextResponse.json(
      { error: `Only a failed job can be retried; this one is ${row.state}.` },
      { status: 409 }
    );
  }

  const { data: updated, error } = await routeServiceClient
    .from("scheduled_jobs")
    .update({
      state: "pending",
      run_at: new Date().toISOString(),
      attempt_count: 0,
      failure_category: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    // Re-asserted, so a job the worker claimed between the page load and this
    // click matches zero rows rather than being yanked out from under it.
    .eq("state", "failed")
    .select("id")
    .maybeSingle();

  if (error || !updated) {
    return NextResponse.json(
      { error: "Somebody else changed this job while you were looking at it." },
      { status: 409 }
    );
  }

  await recordAuditEvent({
    action: "automation.job_cancelled",
    actor: { kind: "staff", userId: actor.userId, role: actor.role },
    entity: { type: row.entity_type, id: row.entity_id, label: row.job_type },
    summary: `Queued a failed ${row.job_type} to run again.`,
    source: "staff_ui",
    metadata: { job_type: row.job_type, action: "retry", previous_attempts: row.attempt_count },
  });

  return NextResponse.json({ ok: true, state: "pending" });
}

/** `cancelJob` guards on pending/running; a failed job needs its own guarded write. */
async function forceCancel(id: string): Promise<boolean> {
  const { data } = await routeServiceClient
    .from("scheduled_jobs")
    .update({
      state: "cancelled",
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      cancel_reason: "Cancelled by staff after failing.",
    })
    .eq("id", id)
    .eq("state", "failed")
    .select("id")
    .maybeSingle();
  return Boolean(data);
}
