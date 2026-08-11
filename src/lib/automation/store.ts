import "server-only";

import { routeServiceClient } from "@/lib/api/routeAuth";
import {
  isRetryable,
  retryDelaySeconds,
  type AutomationFailureCategory,
  type AutomationJobState,
  type AutomationJobType,
} from "./catalogue";

/**
 * Persistence for scheduled jobs. The rules live in `catalogue.ts` and are
 * imported, never restated.
 *
 * Everything here goes through the service client, because `scheduled_jobs` has
 * no grants for `anon` or `authenticated` at all — deliberately, since a
 * customer has no business enumerating the reminders queued about them and staff
 * read this through an authorised route rather than from a browser session.
 */

export type ScheduledJob = {
  id: string;
  job_type: string;
  entity_type: string;
  entity_id: string | null;
  run_at: string;
  state: AutomationJobState;
  dedupe_key: string;
  attempt_count: number;
  last_attempt_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  failure_category: string | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

/** A message with no provider payload, no stack and no row values in it. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return "Unknown error";
}

function logFailure(operation: string, error: unknown, context: Record<string, unknown> = {}) {
  console.error(`automation:${operation} failed`, { ...context, error: describe(error) });
}

const db = () => routeServiceClient;

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export type ScheduleJobInput = {
  type: AutomationJobType;
  entityType: "order" | "production_job" | "support_conversation";
  entityId: string | null;
  runAt: Date | string;
  dedupeKey: string;
  /** Never a customer's words. Ids, counts, thresholds and labels only. */
  metadata?: Record<string, unknown>;
};

export type ScheduleOutcome = "scheduled" | "already_scheduled" | "error";

/**
 * Queue one reminder, or discover it was already queued.
 *
 * The unique `dedupe_key` does the work: a discovery pass that runs every
 * fifteen minutes calls this every fifteen minutes for the same stale
 * conversation, and exactly the first call inserts a row. `already_scheduled` is
 * the *expected* outcome, not an error, which is why it is a distinct return
 * value rather than a swallowed exception — the worker counts them, and a
 * discovery pass that suddenly stops producing them is a signal.
 *
 * Note what is deliberately absent: any check of "did we already send this?".
 * That question belongs to `email_deliveries`, which answers it at send time
 * with its own claim. Asking it here would be a second, weaker answer that could
 * disagree with the first.
 */
export async function scheduleJob(input: ScheduleJobInput): Promise<ScheduleOutcome> {
  const runAt = input.runAt instanceof Date ? input.runAt.toISOString() : input.runAt;
  const { error } = await db().from("scheduled_jobs").insert({
    job_type: input.type,
    entity_type: input.entityType,
    entity_id: input.entityId,
    run_at: runAt,
    dedupe_key: input.dedupeKey,
    metadata: input.metadata ?? {},
  });

  if (!error) return "scheduled";
  // 23505 is the unique violation on `dedupe_key`: this reminder already exists.
  // Anything else is a real failure and must not be mistaken for one.
  if (error.code === "23505") return "already_scheduled";
  logFailure("schedule_job", error, { type: input.type, entityId: input.entityId });
  return "error";
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/**
 * Take a batch of due jobs, exclusively.
 *
 * The exclusivity is the database's, not this function's: `claim_scheduled_jobs`
 * uses `for update skip locked` and moves the rows to `running` in the same
 * statement. Two workers invoked at the same instant get disjoint sets. Neither
 * blocks, neither waits, and neither can send the same reminder.
 */
export async function claimDueJobs(limit: number, workerId: string): Promise<ScheduledJob[]> {
  const { data, error } = await db().rpc("claim_scheduled_jobs", {
    p_limit: Math.min(200, Math.max(1, limit)),
    p_worker: workerId.slice(0, 80),
    p_lease_seconds: 300,
  });
  if (error) {
    logFailure("claim_due_jobs", error, { limit });
    return [];
  }
  return (data ?? []) as ScheduledJob[];
}

// ---------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------

/**
 * The work was done, or was correctly a no-op.
 *
 * Guarded on `state = 'running'`, so a job whose lease expired and was reclaimed
 * by a second worker cannot be marked complete by the first one waking up late.
 */
export async function completeJob(id: string, note?: string): Promise<boolean> {
  const { data, error } = await db()
    .from("scheduled_jobs")
    .update({
      state: "completed",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_error: note?.slice(0, 300) ?? null,
      failure_category: null,
    })
    .eq("id", id)
    .eq("state", "running")
    .select("id")
    .maybeSingle();
  if (error) {
    logFailure("complete_job", error, { id });
    return false;
  }
  return Boolean(data);
}

/**
 * The reminder became wrong before it fired.
 *
 * A paid quote, a collected parcel, a customer who replied. Nothing was sent and
 * nothing should have been, so this is not a failure and does not consume a
 * retry. Cancelling is the *expected* end state for a large share of scheduled
 * work — it means the world moved on, which is what we wanted.
 */
export async function cancelJob(id: string, reason: string): Promise<boolean> {
  const { data, error } = await db()
    .from("scheduled_jobs")
    .update({
      state: "cancelled",
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      cancel_reason: reason.slice(0, 300),
    })
    .eq("id", id)
    .in("state", ["running", "pending"])
    .select("id")
    .maybeSingle();
  if (error) {
    logFailure("cancel_job", error, { id });
    return false;
  }
  return Boolean(data);
}

export type FailOutcome = "retrying" | "failed";

/**
 * The work should have happened and did not.
 *
 * The category decides whether trying again is sensible, and the attempt count
 * decides whether there is any left. A retry goes back to `pending` with a
 * future `run_at` rather than being looped in place, so a provider having a bad
 * ten minutes is waited out by the *next* invocation rather than hammered by
 * this one.
 *
 * `last_error` is a caller-written summary. Provider bodies, stack traces and
 * Postgres `details` fields never reach it — on this schema a `details` field
 * can echo a customer's address back, and this column is rendered on a staff
 * page.
 */
export async function failJob(
  id: string,
  attemptCount: number,
  category: AutomationFailureCategory,
  error: string
): Promise<FailOutcome> {
  const retry = isRetryable(category, attemptCount);
  const patch: Record<string, unknown> = {
    state: retry ? "pending" : "failed",
    failure_category: category,
    last_error: error.slice(0, 300),
    updated_at: new Date().toISOString(),
  };
  if (retry) {
    patch.run_at = new Date(Date.now() + retryDelaySeconds(attemptCount) * 1000).toISOString();
  }

  const { error: dbError } = await db()
    .from("scheduled_jobs")
    .update(patch)
    .eq("id", id)
    .eq("state", "running");
  if (dbError) logFailure("fail_job", dbError, { id, category });
  return retry ? "retrying" : "failed";
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

/**
 * Cancel every reminder still queued about an entity.
 *
 * Called when the underlying state changes in a way that makes pending work
 * meaningless — a quote paid, an order cancelled, a parcel collected. This is
 * the *proactive* half of Phase 23; the handlers re-check current state at
 * execution time regardless, which is the half that has to be right. Doing both
 * means a stale job is usually gone before it is ever claimed, and is refused
 * even when it is not.
 *
 * Only `pending` rows move. A job already `running` belongs to a worker that is
 * about to re-validate it anyway, and reaching into its state from here would
 * race that check.
 */
export async function cancelJobsForEntity(
  entityType: string,
  entityId: string,
  reason: string,
  types?: readonly AutomationJobType[]
): Promise<number> {
  let query = db()
    .from("scheduled_jobs")
    .update({
      state: "cancelled",
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      cancel_reason: reason.slice(0, 300),
    })
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .eq("state", "pending");

  if (types?.length) query = query.in("job_type", types as string[]);

  const { data, error } = await query.select("id");
  if (error) {
    logFailure("cancel_jobs_for_entity", error, { entityType, entityId });
    return 0;
  }
  return (data ?? []).length;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * How many times this reminder type has *actually reached* the entity.
 *
 * Counts `completed` only. A cancelled job never sent anything and must not
 * consume one of the occurrences an entity is allowed, or a customer whose order
 * legitimately re-entered a waiting state would be silently capped by reminders
 * that were correctly abandoned.
 */
export async function completedOccurrences(
  type: AutomationJobType,
  entityId: string
): Promise<number> {
  const { count, error } = await db()
    .from("scheduled_jobs")
    .select("id", { count: "exact", head: true })
    .eq("job_type", type)
    .eq("entity_id", entityId)
    .eq("state", "completed");
  if (error) {
    logFailure("completed_occurrences", error, { type, entityId });
    // Fail closed. An unreadable count must not be read as "nothing sent yet",
    // because that is the reading that sends a duplicate.
    return Number.MAX_SAFE_INTEGER;
  }
  return count ?? 0;
}

/**
 * Whether a dedupe key already exists in any state.
 *
 * Used by discovery to avoid a pointless insert-and-catch on every pass. The
 * unique index remains the actual guarantee; this only keeps the log quiet.
 */
export async function dedupeKeysPresent(keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const { data, error } = await db()
    .from("scheduled_jobs")
    .select("dedupe_key")
    .in("dedupe_key", keys.slice(0, 500));
  if (error) {
    logFailure("dedupe_keys_present", error, { count: keys.length });
    // Fail closed: pretend they all exist, so a database blip schedules nothing
    // rather than scheduling everything a second time.
    return new Set(keys);
  }
  return new Set((data ?? []).map((row) => (row as { dedupe_key: string }).dedupe_key));
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Drop finished work older than the window.
 *
 * `completed` and `cancelled` only — a `failed` row is somebody's problem and
 * stays until it is dealt with. Bounded per invocation so this can never become
 * the reason a worker runs out of time.
 */
export async function pruneFinishedJobs(olderThanDays = 30, limit = 500): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  const { data: rows, error: readError } = await db()
    .from("scheduled_jobs")
    .select("id")
    .in("state", ["completed", "cancelled"])
    .lt("updated_at", cutoff)
    .limit(limit);
  if (readError) {
    logFailure("prune_read", readError);
    return 0;
  }
  const ids = (rows ?? []).map((row) => (row as { id: string }).id);
  if (!ids.length) return 0;

  const { error } = await db().from("scheduled_jobs").delete().in("id", ids);
  if (error) {
    logFailure("prune_delete", error, { count: ids.length });
    return 0;
  }
  return ids.length;
}
