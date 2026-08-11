import "server-only";

import { routeServiceClient } from "@/lib/api/routeAuth";
import { SCHEDULER_INTERVAL_MINUTES } from "./cadence";
import type { AutomationJobState } from "./catalogue";

/**
 * What the staff automation page reads.
 *
 * Deliberately not another monitoring suite. Four questions, which are the four
 * somebody actually asks when a reminder did not arrive:
 *
 *   1. Is the scheduler running at all?
 *   2. When did it last work, and when should it next?
 *   3. What is queued?
 *   4. What broke?
 *
 * Everything else — throughput graphs, per-type latency, run history beyond the
 * last handful — is a dashboard, and the brief was explicit about not building
 * one. Integration health and launch readiness already exist for the wider
 * question of whether the platform is well.
 */

const db = () => routeServiceClient;

export type AutomationRun = {
  id: string;
  started_at: string;
  finished_at: string | null;
  outcome: "running" | "success" | "partial" | "failed";
  trigger: "cron" | "manual";
  discovered: number;
  claimed: number;
  completed: number;
  cancelled: number;
  failed: number;
  reservations_expired: number;
  guest_codes_purged: number;
  duration_ms: number | null;
  error: string | null;
};

export type AutomationHealth = {
  /**
   * How the scheduler is doing, in one word.
   *
   * `never_run` is its own state rather than an error: a shop that has just
   * deployed this has a scheduler that is correctly configured and has simply
   * not fired yet, and calling that "down" would be a red badge on a healthy
   * install. It becomes meaningful the moment the first run lands.
   */
  status: "healthy" | "degraded" | "stalled" | "never_run";
  lastRun: AutomationRun | null;
  lastSuccessAt: string | null;
  /**
   * When the next run is expected, derived from the last one plus the configured
   * cadence. Null before the first run, because there is nothing to derive from
   * — the cron schedule lives in deployment configuration this process cannot
   * read, and inventing a time would be a guess presented as a fact.
   */
  nextExpectedAt: string | null;
  /** True when the last run finished longer ago than two intervals. */
  overdue: boolean;
  counts: Record<AutomationJobState, number>;
  /** Pending jobs whose `run_at` has already passed. A backlog, if it grows. */
  dueNow: number;
  recentRuns: AutomationRun[];
};

async function countJobs(state: AutomationJobState): Promise<number> {
  const { count } = await db()
    .from("scheduled_jobs")
    .select("id", { count: "exact", head: true })
    .eq("state", state);
  return count ?? 0;
}

export async function loadAutomationHealth(): Promise<AutomationHealth> {
  const [runsResult, dueResult, ...stateCounts] = await Promise.all([
    db().from("automation_runs").select("*").order("started_at", { ascending: false }).limit(10),
    db()
      .from("scheduled_jobs")
      .select("id", { count: "exact", head: true })
      .eq("state", "pending")
      .lte("run_at", new Date().toISOString()),
    countJobs("pending"),
    countJobs("running"),
    countJobs("completed"),
    countJobs("cancelled"),
    countJobs("failed"),
  ]);

  const recentRuns = (runsResult.data ?? []) as AutomationRun[];
  const lastRun = recentRuns[0] ?? null;
  const lastSuccess = recentRuns.find((run) => run.outcome === "success" || run.outcome === "partial");

  const intervalMs = SCHEDULER_INTERVAL_MINUTES * 60_000;
  const lastStarted = lastRun ? Date.parse(lastRun.started_at) : NaN;
  const nextExpectedAt = Number.isFinite(lastStarted)
    ? new Date(lastStarted + intervalMs).toISOString()
    : null;

  /*
   * Two intervals of grace before calling it overdue.
   *
   * Cron is not a real-time guarantee and a single skipped or delayed
   * invocation is ordinary. Alarming on one missed run trains people to ignore
   * the badge, which costs more than the fifteen minutes it saves.
   */
  const overdue = Number.isFinite(lastStarted) ? Date.now() - lastStarted > intervalMs * 2 : false;

  const counts: Record<AutomationJobState, number> = {
    pending: stateCounts[0],
    running: stateCounts[1],
    completed: stateCounts[2],
    cancelled: stateCounts[3],
    failed: stateCounts[4],
  };

  let status: AutomationHealth["status"];
  if (!lastRun) status = "never_run";
  else if (overdue) status = "stalled";
  else if (lastRun.outcome === "failed" || counts.failed > 0) status = "degraded";
  else status = "healthy";

  return {
    status,
    lastRun,
    lastSuccessAt: lastSuccess?.finished_at ?? lastSuccess?.started_at ?? null,
    nextExpectedAt,
    overdue,
    counts,
    dueNow: dueResult.count ?? 0,
    recentRuns,
  };
}

export type JobListFilter = {
  state?: AutomationJobState;
  limit?: number;
};

/**
 * The job list the page shows.
 *
 * Ordered by `run_at` for pending work — the order it will actually be done in,
 * which is what somebody looking at a queue wants — and by `updated_at` for
 * everything else, where recency is what matters.
 *
 * `last_error` is included because it is already sanitized at the point it is
 * written: handlers put a sentence there, never a provider body or a Postgres
 * `details` field. That constraint lives in `store.ts` and is asserted by the
 * tests; this read simply trusts it rather than re-filtering and implying the
 * write path might not have.
 */
export async function listJobs(filter: JobListFilter = {}) {
  const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
  const pendingFirst = filter.state === "pending" || !filter.state;

  let query = db()
    .from("scheduled_jobs")
    .select(
      "id,job_type,entity_type,entity_id,run_at,state,attempt_count,last_attempt_at," +
        "failure_category,last_error,cancel_reason,metadata,created_at,updated_at"
    )
    .limit(limit);

  if (filter.state) query = query.eq("state", filter.state);

  query = pendingFirst
    ? query.order("run_at", { ascending: true })
    : query.order("updated_at", { ascending: false });

  const { data, error } = await query;
  if (error) {
    console.error("automation:list_jobs failed", { error: error.message });
    return [];
  }
  return data ?? [];
}
