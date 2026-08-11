import "server-only";

import { routeServiceClient } from "@/lib/api/routeAuth";
import {
  automationDedupeKey,
  dayOccurrence,
  endOfDayUtc,
  quoteExpiryDedupeKey,
  sequenceOccurrence,
} from "./catalogue";
import { isJobEnabled, type AutomationSettings } from "./settings";
import { dedupeKeysPresent, scheduleJob, type ScheduleJobInput } from "./store";

/**
 * Finding the work.
 *
 * Discovery answers one question per reminder type — *which rows are now stale?*
 * — and turns each answer into at most one `scheduled_jobs` row. It sends
 * nothing and decides nothing about eligibility beyond "is this worth queueing";
 * the handler re-checks the world at execution time, because the gap between
 * discovery and execution is exactly where a customer pays their invoice.
 *
 * ## Why this is a scan rather than a set of hooks
 *
 * Two of these reminders hang off a deterministic future instant — a quote
 * expires at a known moment — and the brief calls that explicit scheduling. The
 * `run_at` genuinely is explicit: the job is written for `expiry - 24h`, not
 * "whenever a scan next notices". What is a scan is the *noticing*, and that is
 * deliberate. A hook on the quote-setting route would miss every quote that
 * already exists, would miss any future route that sets an expiry without
 * knowing to call it, and would leave nothing to repair the gap. The scan is
 * self-healing: whatever the state of the table, one pass brings the schedule
 * into line with it.
 *
 * The rest are genuinely state-based. "Waiting on staff for eight hours" is not
 * an event anything emits; it is a `where` clause, and writing a speculative row
 * for every open conversation against every future threshold would be millions
 * of rows to express it.
 *
 * ## Bounded, always
 *
 * Every query here carries a `limit`. A worker that tries to process the whole
 * backlog in one invocation is a worker that times out and does none of it. The
 * caps are generous relative to a workshop's real volume and exist so the shape
 * of a bad day is "some of it waited fifteen minutes" rather than "nothing ran".
 */

const db = () => routeServiceClient;

const CANDIDATE_LIMIT = 200;

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return "Unknown error";
}

function logFailure(pass: string, error: unknown) {
  console.error(`automation:discovery:${pass} failed`, { error: describe(error) });
}

/**
 * Schedule a batch, skipping the ones already queued.
 *
 * The pre-read is an optimisation, not the guarantee — the unique index on
 * `dedupe_key` is. Without it every pass would attempt a hundred inserts that
 * are all expected to fail, and a log full of expected unique violations is a
 * log nobody reads.
 */
async function scheduleBatch(inputs: ScheduleJobInput[]): Promise<number> {
  if (!inputs.length) return 0;
  const existing = await dedupeKeysPresent(inputs.map((input) => input.dedupeKey));
  const fresh = inputs.filter((input) => !existing.has(input.dedupeKey));

  let scheduled = 0;
  for (const input of fresh) {
    if ((await scheduleJob(input)) === "scheduled") scheduled += 1;
  }
  return scheduled;
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/**
 * Orders whose quote is still live, and the two jobs each one earns.
 *
 * A quote is *live* when it has an expiry in the future, has not been paid, and
 * belongs to an order nobody has cancelled. Everything else is filtered here so
 * the queue does not fill with work the handler would only cancel — but the
 * handler checks all of it again, because the interesting cases (paid at 11:59
 * for a job due at 12:00) happen in between.
 *
 * The warning's `run_at` can be in the past when a quote is created with less
 * than the configured warning window left on it. That is correct: a quote due to
 * expire in six hours with a twenty-four hour warning deserves its warning now,
 * not never. `run_at <= now()` simply means the next claim picks it up.
 */
export async function discoverQuoteReminders(settings: AutomationSettings): Promise<number> {
  try {
    const { data, error } = await db()
      .from("orders")
      .select("id,quote_expires_at,payment_status,status,cancelled_at")
      .not("quote_expires_at", "is", null)
      .gt("quote_expires_at", new Date().toISOString())
      .is("cancelled_at", null)
      .in("payment_status", ["unpaid", "payment_failed", "payment_canceled"])
      .not("status", "in", "(cancelled,declined,completed)")
      .limit(CANDIDATE_LIMIT);
    if (error) throw error;

    const jobs: ScheduleJobInput[] = [];
    for (const row of (data ?? []) as { id: string; quote_expires_at: string }[]) {
      const expiresAt = Date.parse(row.quote_expires_at);
      if (!Number.isFinite(expiresAt)) continue;

      const warnAt = expiresAt - settings.orders.quoteExpiryWarningHours * 3_600_000;
      jobs.push({
        type: "quote_expiry_warning",
        entityType: "order",
        entityId: row.id,
        runAt: new Date(warnAt),
        dedupeKey: quoteExpiryDedupeKey("quote_expiry_warning", row.id, row.quote_expires_at),
        metadata: { expires_at: row.quote_expires_at },
      });
      jobs.push({
        type: "quote_expired",
        entityType: "order",
        entityId: row.id,
        runAt: new Date(expiresAt),
        dedupeKey: quoteExpiryDedupeKey("quote_expired", row.id, row.quote_expires_at),
        metadata: { expires_at: row.quote_expires_at },
      });
    }
    return await scheduleBatch(jobs);
  } catch (error) {
    logFailure("quotes", error);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Orders waiting on the customer
// ---------------------------------------------------------------------------

/**
 * The three states that mean "we cannot proceed until the customer does
 * something", and nothing else.
 *
 * Explicitly *not* inferred from message text. "Can you confirm the colour?" in
 * a message body is not a state, and a reminder system that reads prose will
 * eventually remind somebody about a sentence that was not a question. Only a
 * status the shop actually set counts.
 */
const CUSTOMER_ACTION_STATUSES = ["needs_information", "awaiting_payment", "customer_review"] as const;

export async function discoverOrderActionReminders(settings: AutomationSettings): Promise<number> {
  if (!isJobEnabled(settings, "order_action_required")) return 0;
  try {
    const { data, error } = await db()
      .from("orders")
      .select("id,status,cancelled_at,payment_status")
      .in("status", CUSTOMER_ACTION_STATUSES as unknown as string[])
      .is("cancelled_at", null)
      .limit(CANDIDATE_LIMIT);
    if (error) throw error;

    const orders = (data ?? []) as { id: string; status: string; payment_status: string }[];
    if (!orders.length) return 0;

    /**
     * How long each order has held its *current* status.
     *
     * `orders.updated_at` cannot answer this: it moves when staff edit a note,
     * so an order that has been waiting three weeks looks like it changed this
     * morning. `order_status_history` records the transition itself, which is
     * the only timestamp that means what this reminder needs it to mean.
     */
    const { data: history, error: historyError } = await db()
      .from("order_status_history")
      .select("order_id,to_status,created_at")
      .in("order_id", orders.map((order) => order.id))
      .in("to_status", CUSTOMER_ACTION_STATUSES as unknown as string[])
      .order("created_at", { ascending: false })
      .limit(CANDIDATE_LIMIT * 4);
    if (historyError) throw historyError;

    const enteredAt = new Map<string, string>();
    for (const row of (history ?? []) as { order_id: string; to_status: string; created_at: string }[]) {
      const order = orders.find((candidate) => candidate.id === row.order_id);
      // Ordered newest-first, so the first row matching the order's *current*
      // status is the transition that put it there. A later row for a status it
      // has since left describes a different episode and is ignored.
      if (order && order.status === row.to_status && !enteredAt.has(row.order_id)) {
        enteredAt.set(row.order_id, row.created_at);
      }
    }

    const now = Date.now();
    const jobs: ScheduleJobInput[] = [];
    for (const order of orders) {
      const since = enteredAt.get(order.id);
      // No recorded transition means no authoritative clock to measure from.
      // Guessing one from `created_at` would remind on orders that have been in
      // this state since before the history table did.
      if (!since) continue;
      const days = Math.floor((now - Date.parse(since)) / 86_400_000);
      if (!Number.isFinite(days)) continue;

      // Later threshold first: an order that has been waiting nine days wants
      // its second nudge, not the first one it should have had on day three.
      const stage =
        days >= settings.orders.actionRequiredSecondDays
          ? 2
          : days >= settings.orders.actionRequiredFirstDays
            ? 1
            : 0;
      if (stage === 0) continue;

      jobs.push({
        type: "order_action_required",
        entityType: "order",
        entityId: order.id,
        runAt: new Date(),
        dedupeKey: automationDedupeKey("order_action_required", order.id, sequenceOccurrence(stage)),
        metadata: { stage, status: order.status, waiting_days: days },
      });
    }
    return await scheduleBatch(jobs);
  } catch (error) {
    logFailure("order_action", error);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Pickup
// ---------------------------------------------------------------------------

/**
 * Orders ready for collection that nobody has collected.
 *
 * Shipping is deliberately absent. A parcel in transit does not need us to tell
 * the customer it is in transit — the carrier is doing that, and the tracking
 * updates already sent are authoritative. Nagging somebody about a thing that is
 * on a van is how a transactional sender becomes a filtered one.
 */
export async function discoverPickupReminders(settings: AutomationSettings): Promise<number> {
  const wantCustomer = isJobEnabled(settings, "pickup_reminder");
  const wantStaff = isJobEnabled(settings, "pickup_stale_staff");
  if (!wantCustomer && !wantStaff) return 0;

  try {
    const { data, error } = await db()
      .from("orders")
      .select("id,ready_at,fulfillment_status,picked_up_at,cancelled_at")
      .eq("fulfillment_status", "ready_for_pickup")
      .not("ready_at", "is", null)
      .is("picked_up_at", null)
      .is("cancelled_at", null)
      .limit(CANDIDATE_LIMIT);
    if (error) throw error;

    const now = Date.now();
    const jobs: ScheduleJobInput[] = [];
    for (const row of (data ?? []) as { id: string; ready_at: string }[]) {
      const readyAt = Date.parse(row.ready_at);
      if (!Number.isFinite(readyAt)) continue;
      const days = Math.floor((now - readyAt) / 86_400_000);

      if (wantCustomer) {
        /**
         * The *largest* configured day that has passed, and only that one.
         *
         * An order that has sat for nine days with a [3, 7] cadence should get
         * the day-7 reminder, not both. Scheduling every threshold it has passed
         * would mean an order discovered late — because reminders were switched
         * on after it was already stale — receives the whole backlog at once.
         */
        const due = settings.fulfillment.pickupReminderDays.filter((day) => days >= day);
        const latest = due.length ? Math.max(...due) : null;
        if (latest !== null) {
          jobs.push({
            type: "pickup_reminder",
            entityType: "order",
            entityId: row.id,
            runAt: new Date(),
            dedupeKey: automationDedupeKey("pickup_reminder", row.id, dayOccurrence(latest)),
            metadata: { day: latest, ready_at: row.ready_at },
          });
        }
      }

      if (wantStaff && days >= settings.fulfillment.pickupStaleStaffDays) {
        jobs.push({
          type: "pickup_stale_staff",
          entityType: "order",
          entityId: row.id,
          runAt: new Date(),
          dedupeKey: automationDedupeKey(
            "pickup_stale_staff",
            row.id,
            dayOccurrence(settings.fulfillment.pickupStaleStaffDays)
          ),
          metadata: { waiting_days: days },
        });
      }
    }
    return await scheduleBatch(jobs);
  } catch (error) {
    logFailure("pickup", error);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

/**
 * Conversations that have been sitting with one side too long.
 *
 * `resolved` and `closed` are excluded by the status filter rather than checked
 * afterwards, and the two clocks are different columns on purpose:
 * `last_customer_message_at` is when the customer last spoke, which is what
 * "waiting on staff" measures; `last_staff_message_at` is when we last did,
 * which is what "waiting on customer" measures. Using `last_message_at` for both
 * would make an internal note look like a reply.
 */
export async function discoverSupportReminders(settings: AutomationSettings): Promise<number> {
  const wantStaff = isJobEnabled(settings, "support_waiting_staff");
  const wantCustomer = isJobEnabled(settings, "support_waiting_customer");
  if (!wantStaff && !wantCustomer) return 0;

  try {
    const jobs: ScheduleJobInput[] = [];
    const now = Date.now();

    if (wantStaff) {
      const cutoff = new Date(now - settings.support.waitingOnStaffHours * 3_600_000).toISOString();
      const { data, error } = await db()
        .from("support_conversations")
        .select("id,reference,status,last_customer_message_at")
        // `open` counts too: nobody has replied at all, which is the worst
        // version of waiting on staff rather than a different situation.
        .in("status", ["open", "waiting_on_staff"])
        .not("last_customer_message_at", "is", null)
        .lt("last_customer_message_at", cutoff)
        .limit(CANDIDATE_LIMIT);
      if (error) throw error;

      for (const row of (data ?? []) as { id: string; last_customer_message_at: string }[]) {
        jobs.push({
          type: "support_waiting_staff",
          entityType: "support_conversation",
          entityId: row.id,
          runAt: new Date(),
          // Keyed on the customer's message, so a *new* customer message
          // restarts the clock and earns a new alert, while the same unanswered
          // message never alerts twice however many passes see it.
          dedupeKey: automationDedupeKey(
            "support_waiting_staff",
            row.id,
            row.last_customer_message_at.slice(0, 16).replace(/[:T-]/g, "")
          ),
          metadata: { waiting_since: row.last_customer_message_at },
        });
      }
    }

    if (wantCustomer) {
      const cutoff = new Date(now - settings.support.waitingOnCustomerDays * 86_400_000).toISOString();
      const { data, error } = await db()
        .from("support_conversations")
        .select("id,reference,status,last_staff_message_at,requester_email")
        .eq("status", "waiting_on_customer")
        .not("last_staff_message_at", "is", null)
        .lt("last_staff_message_at", cutoff)
        .limit(CANDIDATE_LIMIT);
      if (error) throw error;

      for (const row of (data ?? []) as { id: string; last_staff_message_at: string }[]) {
        jobs.push({
          type: "support_waiting_customer",
          entityType: "support_conversation",
          entityId: row.id,
          runAt: new Date(),
          dedupeKey: automationDedupeKey(
            "support_waiting_customer",
            row.id,
            dayOccurrence(settings.support.waitingOnCustomerDays)
          ),
          metadata: { waiting_since: row.last_staff_message_at },
        });
      }
    }

    return await scheduleBatch(jobs);
  } catch (error) {
    logFailure("support", error);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------

/** The states that mean the shop is waiting on something outside its control. */
const BLOCKED_STATUSES = ["waiting_on_customer", "waiting_on_materials", "on_hold"] as const;

/** States where a due date no longer means anything. */
const FINISHED_STATUSES = ["completed", "cancelled"] as const;

/**
 * Jobs that are late, nearly late, or stuck.
 *
 * `due_date` is a bare `date` — no time, no zone — so "overdue" is measured
 * against the *end* of that day. Comparing against the start would mark every
 * job overdue for the twenty-four hours during which it is merely due.
 *
 * Overdue and due-soon are mutually exclusive per job: a job that is already
 * late does not also want a warning that it is approaching.
 */
export async function discoverProductionReminders(settings: AutomationSettings): Promise<number> {
  const wantDue = isJobEnabled(settings, "production_due_soon");
  const wantOverdue = isJobEnabled(settings, "production_overdue");
  const wantBlocked = isJobEnabled(settings, "production_blocked");
  if (!wantDue && !wantOverdue && !wantBlocked) return 0;

  try {
    const { data, error } = await db()
      .from("production_jobs")
      .select("id,job_number,status,due_date,updated_at,completed_at,cancelled_at")
      .not("status", "in", `(${FINISHED_STATUSES.join(",")})`)
      .is("completed_at", null)
      .is("cancelled_at", null)
      .limit(CANDIDATE_LIMIT);
    if (error) throw error;

    const now = Date.now();
    const jobs: ScheduleJobInput[] = [];

    for (const row of (data ?? []) as {
      id: string;
      job_number: string;
      status: string;
      due_date: string | null;
      updated_at: string;
    }[]) {
      if (row.due_date && (wantDue || wantOverdue)) {
        const dueEnd = endOfDayUtc(row.due_date);
        if (Number.isFinite(dueEnd)) {
          if (now > dueEnd) {
            if (wantOverdue) {
              jobs.push({
                type: "production_overdue",
                entityType: "production_job",
                entityId: row.id,
                runAt: new Date(),
                // The due date is the occurrence: moving a deadline creates a
                // genuinely new lateness, and the old alert is not reused.
                dedupeKey: automationDedupeKey("production_overdue", row.id, row.due_date),
                metadata: {
                  job_number: row.job_number,
                  due_date: row.due_date,
                  days_late: Math.floor((now - dueEnd) / 86_400_000),
                },
              });
            }
          } else if (wantDue && now >= dueEnd - settings.production.dueSoonDays * 86_400_000) {
            jobs.push({
              type: "production_due_soon",
              entityType: "production_job",
              entityId: row.id,
              runAt: new Date(),
              dedupeKey: automationDedupeKey("production_due_soon", row.id, row.due_date),
              metadata: { job_number: row.job_number, due_date: row.due_date },
            });
          }
        }
      }

      if (
        wantBlocked &&
        (BLOCKED_STATUSES as readonly string[]).includes(row.status) &&
        now - Date.parse(row.updated_at) >= settings.production.blockedHours * 3_600_000
      ) {
        jobs.push({
          type: "production_blocked",
          entityType: "production_job",
          entityId: row.id,
          runAt: new Date(),
          // Keyed on the status *and* the moment it was last touched, so a job
          // that is unblocked and blocks again alerts a second time while one
          // that simply stays blocked does not alert every pass.
          dedupeKey: automationDedupeKey(
            "production_blocked",
            row.id,
            `${row.status}-${row.updated_at.slice(0, 13).replace(/[:T-]/g, "")}`
          ),
          metadata: {
            job_number: row.job_number,
            status: row.status,
            blocked_hours: Math.floor((now - Date.parse(row.updated_at)) / 3_600_000),
          },
        });
      }
    }

    return await scheduleBatch(jobs);
  } catch (error) {
    logFailure("production", error);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

/**
 * Cancel queued work whose entity has plainly moved on.
 *
 * ## Why this is a sweep rather than a hook on every mutation
 *
 * The brief asks for stale jobs to be cancelled when state changes *and* to be
 * revalidated at execution, preferring both. The second is done and is the
 * actual guarantee — no handler sends anything without reloading its entity
 * first. This is the first, arrived at from the other direction.
 *
 * The obvious implementation is a `cancelJobsForEntity` call inside each
 * mutation: the Stripe webhook when a payment settles, the fulfillment
 * transition when a parcel is collected, the support routes when somebody
 * replies. That is six edits, and one of them is inside the payment webhook —
 * the most safety-critical file in this repository, where a new failure mode
 * costs a customer their order confirmation. The benefit being bought is that a
 * doomed job is cancelled *now* rather than within one cadence, and since the
 * handler refuses it either way, what that actually buys is a tidier table.
 *
 * So the tidying happens here, in one bounded place that cannot break a payment.
 * Set-based and cheap: five queries that name terminal states, no per-entity
 * round trips, and nothing that can cancel a job whose entity is still live.
 *
 * Every predicate below is a state the matching handler would refuse anyway.
 * That is the invariant worth holding — this sweep may only ever anticipate a
 * refusal, never cause one.
 */
export async function reconcileStaleJobs(): Promise<number> {
  let cancelled = 0;

  const sweep = async (
    label: string,
    entityType: string,
    types: readonly string[],
    deadEntityIds: string[]
  ) => {
    if (!deadEntityIds.length) return;
    const { data, error } = await db()
      .from("scheduled_jobs")
      .update({
        state: "cancelled",
        cancelled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        cancel_reason: `No longer applicable: ${label}.`,
      })
      .eq("entity_type", entityType)
      .eq("state", "pending")
      .in("job_type", types as string[])
      .in("entity_id", deadEntityIds.slice(0, 500))
      .select("id");
    if (error) {
      logFailure(`reconcile:${label}`, error);
      return;
    }
    cancelled += (data ?? []).length;
  };

  try {
    // The set of entities any pending job still points at. Everything below is
    // scoped to these, so the sweep never scans the whole orders table.
    const { data: pending, error } = await db()
      .from("scheduled_jobs")
      .select("entity_type,entity_id,job_type")
      .eq("state", "pending")
      .limit(1000);
    if (error) throw error;

    const rows = (pending ?? []) as { entity_type: string; entity_id: string | null; job_type: string }[];
    const idsFor = (entityType: string) =>
      [...new Set(rows.filter((row) => row.entity_type === entityType && row.entity_id).map((row) => row.entity_id!))];

    const orderIds = idsFor("order");
    if (orderIds.length) {
      const { data: orders } = await db()
        .from("orders")
        .select("id,status,payment_status,cancelled_at,picked_up_at,fulfillment_status,quote_expires_at")
        .in("id", orderIds.slice(0, 500));
      const list = (orders ?? []) as {
        id: string;
        status: string;
        payment_status: string;
        cancelled_at: string | null;
        picked_up_at: string | null;
        fulfillment_status: string;
        quote_expires_at: string | null;
      }[];

      await sweep(
        "the order was cancelled",
        "order",
        ["quote_expiry_warning", "quote_expired", "order_action_required", "pickup_reminder", "pickup_stale_staff"],
        list.filter((order) => order.cancelled_at || ["cancelled", "declined"].includes(order.status)).map((o) => o.id)
      );
      await sweep(
        "the quote was paid",
        "order",
        ["quote_expiry_warning", "quote_expired"],
        list.filter((order) => ["paid", "partial", "refunded", "partially_refunded"].includes(order.payment_status)).map((o) => o.id)
      );
      await sweep(
        "the order was collected",
        "order",
        ["pickup_reminder", "pickup_stale_staff"],
        list.filter((order) => order.picked_up_at || order.fulfillment_status !== "ready_for_pickup").map((o) => o.id)
      );
    }

    const conversationIds = idsFor("support_conversation");
    if (conversationIds.length) {
      const { data: conversations } = await db()
        .from("support_conversations")
        .select("id,status,last_customer_message_at,last_staff_message_at")
        .in("id", conversationIds.slice(0, 500));
      const list = (conversations ?? []) as {
        id: string;
        status: string;
        last_customer_message_at: string | null;
        last_staff_message_at: string | null;
      }[];

      const replied = (a: string | null, b: string | null) =>
        Boolean(a && b && Date.parse(a) > Date.parse(b));

      await sweep(
        "the conversation was resolved or closed",
        "support_conversation",
        ["support_waiting_staff", "support_waiting_customer"],
        list.filter((row) => ["resolved", "closed"].includes(row.status)).map((row) => row.id)
      );
      await sweep(
        "a staff member replied",
        "support_conversation",
        ["support_waiting_staff"],
        list.filter((row) => replied(row.last_staff_message_at, row.last_customer_message_at)).map((row) => row.id)
      );
      await sweep(
        "the customer replied",
        "support_conversation",
        ["support_waiting_customer"],
        list.filter((row) => replied(row.last_customer_message_at, row.last_staff_message_at)).map((row) => row.id)
      );
    }

    const jobIds = idsFor("production_job");
    if (jobIds.length) {
      const { data: productionJobs } = await db()
        .from("production_jobs")
        .select("id,status,completed_at,cancelled_at")
        .in("id", jobIds.slice(0, 500));
      const list = (productionJobs ?? []) as {
        id: string;
        status: string;
        completed_at: string | null;
        cancelled_at: string | null;
      }[];

      await sweep(
        "the production job finished",
        "production_job",
        ["production_due_soon", "production_overdue", "production_blocked"],
        list
          .filter((row) => row.completed_at || row.cancelled_at || ["completed", "cancelled"].includes(row.status))
          .map((row) => row.id)
      );
    }
  } catch (error) {
    logFailure("reconcile", error);
  }

  return cancelled;
}

/** Every discovery pass, in one call. Returns how many jobs were newly queued. */
export async function runDiscovery(settings: AutomationSettings): Promise<number> {
  if (!settings.enabled) return 0;
  /*
   * Invalidation first, then discovery.
   *
   * A job cancelled here frees its dedupe key for nothing — the key stays taken
   * by the cancelled row, which is correct, because that occurrence genuinely
   * happened and should not be re-queued. Doing it first simply means the
   * numbers the run record reports describe the same moment.
   */
  await reconcileStaleJobs();

  const counts = await Promise.all([
    discoverQuoteReminders(settings),
    discoverOrderActionReminders(settings),
    discoverPickupReminders(settings),
    discoverSupportReminders(settings),
    discoverProductionReminders(settings),
  ]);
  return counts.reduce((total, count) => total + count, 0);
}
