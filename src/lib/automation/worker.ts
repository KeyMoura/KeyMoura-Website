import "server-only";

import { routeServiceClient } from "@/lib/api/routeAuth";
import { raiseOperationalAlert } from "@/lib/comms/operationalAlerts";
import { recordAuditEvent } from "@/lib/audit/events";
import { loadCommerceSettings, expireReservations } from "@/lib/commerce/commerceSettingsServer";
import { runDiscovery } from "./discovery";
import { handlerFor, type HandlerResult } from "./handlers";
import {
  cancelJob,
  claimDueJobs,
  completeJob,
  failJob,
  pruneFinishedJobs,
  type ScheduledJob,
} from "./store";

/**
 * The worker. Cron wakes it; the database tells it what to do.
 *
 * ## Shape of an invocation
 *
 *   1. Open a run record, so a scheduler that stopped being invoked is
 *      distinguishable from one with nothing to do.
 *   2. Discover newly-stale work and queue it.
 *   3. Claim due jobs in bounded batches and execute them until the batch is
 *      empty or the time budget is spent.
 *   4. Sweep the time-bound holds that have nothing else to release them.
 *   5. Prune finished jobs older than the retention window.
 *   6. Close the run record.
 *
 * Steps 2 and 3 are deliberately in that order but not dependent on it: a job
 * discovered this invocation and due immediately is executed this invocation,
 * and one discovered but not yet due simply waits. Nothing here assumes the
 * previous invocation succeeded.
 *
 * ## The time budget
 *
 * A Vercel function has a wall-clock limit, and the failure mode of ignoring it
 * is the worst one available: the process is killed partway through a batch,
 * leaving jobs in `running` with a live lease and no worker. The budget is
 * deliberately far below the platform limit, and the leases are short enough
 * that a killed batch is reclaimed on the next invocation rather than stranded.
 *
 * Running out of budget is normal and is not an error. The remaining work is
 * still due, and the next invocation is fifteen minutes away.
 */

const db = () => routeServiceClient;

/** Stop claiming new batches after this. Well under any platform limit. */
const TIME_BUDGET_MS = 45_000;

/** Jobs per claim. Small enough that a killed batch loses little. */
const BATCH_SIZE = 25;

/** Hard ceiling per invocation, whatever the budget allows. */
const MAX_JOBS_PER_RUN = 200;

export type WorkerTrigger = "cron" | "manual";

export type WorkerSummary = {
  runId: string | null;
  outcome: "success" | "partial" | "failed";
  discovered: number;
  claimed: number;
  completed: number;
  cancelled: number;
  failed: number;
  reservationsExpired: number;
  guestCodesPurged: number;
  pruned: number;
  durationMs: number;
  /** True when the budget ran out with work still due. Not an error. */
  moreWaiting: boolean;
  automationEnabled: boolean;
};

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return "Unknown error";
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/**
 * Guest access challenges that have served their purpose.
 *
 * These are one-time codes for a guest opening their own order. Consumed or
 * expired, they are dead weight — but a *hashed* code is not a secret, so this
 * is housekeeping rather than a security control, and it is bounded and
 * unhurried accordingly.
 *
 * Nothing depends on it running: `guestOrderVerification` already refuses an
 * expired or consumed row on its own terms. This stops the table growing without
 * limit, and that is all it is for.
 */
async function purgeGuestAccessCodes(limit = 500): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { data, error } = await db()
      .from("guest_order_access_codes")
      .select("id")
      .or(`expires_at.lt.${cutoff},consumed_at.lt.${cutoff}`)
      .limit(limit);
    if (error) throw error;
    const ids = (data ?? []).map((row) => (row as { id: string }).id);
    if (!ids.length) return 0;
    const { error: deleteError } = await db().from("guest_order_access_codes").delete().in("id", ids);
    if (deleteError) throw deleteError;
    return ids.length;
  } catch (error) {
    console.error("automation:purge_guest_codes failed", { error: describe(error) });
    return 0;
  }
}

/**
 * The time-bound commerce holds.
 *
 * `expire_inventory_reservations` moves only `active` rows whose `expires_at`
 * has passed. It cannot touch a committed hold and cannot decrement stock — it
 * releases a reservation that is already being ignored by every availability
 * calculation, so running it twice releases nothing the second time. That is
 * what makes it safe to call unconditionally on every invocation.
 *
 * This is a safety net, not a source of truth. The Stripe webhook still commits
 * and releases holds as payments settle, `reserve_cart_inventory` still sweeps
 * before it measures, and availability still ignores a lapsed hold regardless.
 * If all three of those stopped working, this would keep the table tidy; it is
 * not what keeps the numbers right.
 */
async function sweepReservations(): Promise<number> {
  try {
    return await expireReservations(500);
  } catch (error) {
    console.error("automation:sweep_reservations failed", { error: describe(error) });
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Run one claimed job and record what happened to it.
 *
 * Never throws. A handler that blows up is a failed job, not a failed
 * invocation: one bad row must not stop the other twenty-four in the batch, and
 * certainly must not stop the reservation sweep that runs afterwards.
 */
async function executeJob(
  job: ScheduledJob,
  settings: Awaited<ReturnType<typeof loadCommerceSettings>>
): Promise<"completed" | "cancelled" | "failed" | "retrying"> {
  const handler = handlerFor(job.job_type);
  if (!handler) {
    /*
     * A job type the code no longer knows about — a row queued by a previous
     * deployment whose handler has since been removed. Cancelled rather than
     * failed: there is nothing to retry, and leaving it to exhaust attempts
     * would put a permanent red mark on the health page for a reminder nobody
     * wants any more.
     */
    await cancelJob(job.id, `No handler for "${job.job_type}".`);
    return "cancelled";
  }

  let result: HandlerResult;
  try {
    result = await handler({
      job,
      settings: settings.automation,
      timezone: settings.business.timezone,
    });
  } catch (error) {
    result = { outcome: "failed", category: "unknown", error: describe(error) };
  }

  switch (result.outcome) {
    case "sent":
      await completeJob(job.id, result.summary);
      return "completed";
    case "skipped":
      await completeJob(job.id, result.summary);
      return "completed";
    case "ineligible":
      await cancelJob(job.id, result.reason);
      return "cancelled";
    case "failed": {
      const outcome = await failJob(job.id, job.attempt_count, result.category, result.error);
      if (outcome === "failed") await announceFailure(job, result.category, result.error);
      return outcome === "failed" ? "failed" : "retrying";
    }
  }
}

/**
 * A job that has spent its attempts.
 *
 * Two things happen, and both matter. An operational alert reaches whoever holds
 * `automation.view`, because a reminder that never went out is somebody's
 * problem and silence is how it stays one. And an audit row records it, because
 * "we did not tell that customer their quote was expiring" is a fact that may
 * need accounting for later.
 *
 * `configuration` failures are the ones worth reading twice: they mean the
 * worker is running and correctly cannot do its job. That is not the same as a
 * provider having a bad afternoon, and the alert says so.
 */
async function announceFailure(job: ScheduledJob, category: string, error: string) {
  await raiseOperationalAlert({
    kind: "ops.automation_failure",
    subjectId: job.id,
    message:
      category === "configuration"
        ? `A scheduled "${job.job_type}" reminder cannot run: ${error} Nothing will send until this is configured.`
        : `A scheduled "${job.job_type}" reminder failed after ${job.attempt_count} attempts (${category.replace(/_/g, " ")}).`,
  }).catch(() => undefined);

  await recordAuditEvent({
    action: "automation.job_failed",
    actor: { kind: "scheduled", job: job.job_type },
    entity: { type: job.entity_type, id: job.entity_id, label: job.job_type },
    summary: `Scheduled ${job.job_type} failed after ${job.attempt_count} attempts.`,
    source: "job",
    metadata: { job_type: job.job_type, failure_category: category, attempts: job.attempt_count },
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function runAutomationWorker(
  trigger: WorkerTrigger = "cron"
): Promise<WorkerSummary> {
  const startedAt = Date.now();
  const workerId = `${trigger}-${startedAt.toString(36)}`;

  const { data: runRow } = await db()
    .from("automation_runs")
    .insert({ trigger, outcome: "running" })
    .select("id")
    .maybeSingle();
  const runId = (runRow as { id: string } | null)?.id ?? null;

  const summary: WorkerSummary = {
    runId,
    outcome: "success",
    discovered: 0,
    claimed: 0,
    completed: 0,
    cancelled: 0,
    failed: 0,
    reservationsExpired: 0,
    guestCodesPurged: 0,
    pruned: 0,
    durationMs: 0,
    moreWaiting: false,
    automationEnabled: true,
  };

  let fatal: string | null = null;

  try {
    const settings = await loadCommerceSettings();
    summary.automationEnabled = settings.automation.enabled;

    /*
     * The master switch stops reminders, not the worker.
     *
     * An operator silencing automation for a week should still get the
     * housekeeping and should still be able to see on the health page that the
     * scheduler is alive. A run that does nothing and a scheduler that is not
     * running look identical otherwise, and that is the failure this whole run
     * log exists to make visible.
     */
    if (settings.automation.enabled) {
      summary.discovered = await runDiscovery(settings.automation);

      while (Date.now() - startedAt < TIME_BUDGET_MS && summary.claimed < MAX_JOBS_PER_RUN) {
        const batch = await claimDueJobs(BATCH_SIZE, workerId);
        if (!batch.length) break;
        summary.claimed += batch.length;

        /*
         * Sequential, not parallel.
         *
         * Every one of these handlers writes to `email_deliveries` and most send
         * a provider request; twenty-five at once is a burst that a rate limiter
         * answers with 429s, which this system would then dutifully retry. The
         * batch is small precisely so that doing it in order is fast enough.
         */
        for (const job of batch) {
          const outcome = await executeJob(job, settings);
          if (outcome === "completed") summary.completed += 1;
          else if (outcome === "cancelled") summary.cancelled += 1;
          else if (outcome === "failed") summary.failed += 1;
        }

        if (batch.length < BATCH_SIZE) break;
      }

      // Budget spent or ceiling hit with a full batch behind us: there is more.
      summary.moreWaiting =
        summary.claimed >= MAX_JOBS_PER_RUN || Date.now() - startedAt >= TIME_BUDGET_MS;
    }

    summary.reservationsExpired = await sweepReservations();
    summary.guestCodesPurged = await purgeGuestAccessCodes();
    summary.pruned = await pruneFinishedJobs();
  } catch (error) {
    fatal = describe(error);
    summary.outcome = "failed";
  }

  summary.durationMs = Date.now() - startedAt;
  if (!fatal) summary.outcome = summary.failed > 0 ? "partial" : "success";

  if (runId) {
    await db()
      .from("automation_runs")
      .update({
        finished_at: new Date().toISOString(),
        outcome: summary.outcome,
        discovered: summary.discovered,
        claimed: summary.claimed,
        completed: summary.completed,
        cancelled: summary.cancelled,
        failed: summary.failed,
        reservations_expired: summary.reservationsExpired,
        guest_codes_purged: summary.guestCodesPurged,
        duration_ms: summary.durationMs,
        error: fatal,
      })
      .eq("id", runId)
      .then(undefined, () => undefined);
  }

  return summary;
}
