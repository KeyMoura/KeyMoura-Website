/**
 * The scheduled-automation catalogue — one definition, read by everything.
 *
 * Pure and dependency-free on purpose, exactly like `comms/emailEvents.ts` and
 * `comms/notificationEvents.ts`. The worker, the discovery pass, the staff
 * settings page, the API routes and the tests all read *these* definitions
 * rather than four readings of a paragraph. A threshold that means eight hours
 * in the worker and eight days in a form is not a typo, it is a customer being
 * pestered.
 *
 * ## What this system is, and what it is deliberately not
 *
 * This is **operational** automation: it notices that a real piece of work has
 * gone stale and tells the one person or customer who can act on it, once. It
 * is not marketing automation. There is no campaign, no audience, no send-time
 * optimisation, and no job type here that exists to sell anything. Every job
 * below hangs off a row whose state a staff member could point at.
 *
 * ## Discovery versus explicit scheduling
 *
 * Each job type declares which pattern it uses, because the two fail
 * differently and the choice is not obvious from the code that runs them.
 *
 * - `explicit` — the future moment is *known* when the state changes. A quote
 *   that expires at 14:00 on Friday earns a reminder row for 14:00 on Thursday
 *   the moment the expiry is set. Cheap, exact, and it survives the discovery
 *   pass never running.
 * - `discovery` — there is no single moment, only a condition that becomes true
 *   by the clock moving. "Waiting on staff for eight hours" is not an event
 *   anything emits; it is a query. Writing a speculative row for every open
 *   conversation against every future threshold would be millions of rows to
 *   express a `where` clause.
 *
 * Both end up as rows in `scheduled_jobs`, so there is one worker, one retry
 * policy and one place to look when something did not happen.
 *
 * ## The rule the whole file exists for
 *
 * A dedupe key identifies a *logical reminder*, never a call. It carries the
 * entity and the occurrence — `pickup-reminder:<order>:day3` — and never the
 * clock, because a key containing `Date.now()` is a fresh key every time and
 * deduplicates nothing. Where the underlying schedule can legitimately move, the
 * key carries the schedule (see `quoteExpiryDedupeKey`), so changing a quote's
 * expiry produces a *different* reminder rather than silently reusing the one
 * that was already sent.
 */

// ---------------------------------------------------------------------------
// Job types
// ---------------------------------------------------------------------------

export const AUTOMATION_JOB_TYPES = [
  // Quotes and payment
  "quote_expiry_warning",
  "quote_expired",
  "order_action_required",
  // Fulfillment
  "pickup_reminder",
  "pickup_stale_staff",
  // Support
  "support_waiting_customer",
  "support_waiting_staff",
  // Production
  "production_due_soon",
  "production_overdue",
  "production_blocked",
] as const;

export type AutomationJobType = (typeof AUTOMATION_JOB_TYPES)[number];

export function isAutomationJobType(value: unknown): value is AutomationJobType {
  return typeof value === "string" && (AUTOMATION_JOB_TYPES as readonly string[]).includes(value);
}

/** Which side of the shop the reminder is addressed to. Decides the channel. */
export type AutomationAudience = "customer" | "staff";

/** How the job comes to exist. See the module header. */
export type AutomationPattern = "explicit" | "discovery";

/**
 * The settings group this job's timing belongs to.
 *
 * Drives the staff settings page's layout directly, so a new job type cannot be
 * added without deciding where an operator would look for its timer.
 */
export const AUTOMATION_GROUPS = ["orders", "production", "fulfillment", "support"] as const;
export type AutomationGroup = (typeof AUTOMATION_GROUPS)[number];

export const AUTOMATION_GROUP_LABELS: Readonly<Record<AutomationGroup, string>> = {
  orders: "Orders & quotes",
  production: "Production",
  fulfillment: "Fulfillment",
  support: "Support",
};

export const AUTOMATION_GROUP_DESCRIPTIONS: Readonly<Record<AutomationGroup, string>> = {
  orders: "Reminders about quotes that are running out and orders waiting on the customer.",
  production: "Alerts for the workshop when a job is due, late, or has been blocked too long.",
  fulfillment: "Reminders for orders that are ready and have not been collected.",
  support: "Follow-up when a conversation has been sitting with one side too long.",
};

export type AutomationJobSpec = {
  type: AutomationJobType;
  audience: AutomationAudience;
  pattern: AutomationPattern;
  group: AutomationGroup;
  /** The table a job of this type points at. */
  entityType: "order" | "production_job" | "support_conversation";
  /** One line, written for a staff member reading the settings page. */
  label: string;
  /** What causes it, in a sentence. */
  description: string;
  /**
   * False for the reminders that keep an active transaction moving. Those stay
   * on: a customer cannot be left unable to complete a purchase because an
   * operator turned off the message telling them their quote is about to lapse.
   * See `docs/` and Phase 11 of the brief — these are transactional, not
   * marketing, and the switch that would disable them does not exist.
   */
  optional: boolean;
  /**
   * How many times this reminder may ever fire for one entity, across the whole
   * lifecycle. `null` means the cadence itself is the cap (pickup fires once per
   * configured day, and there are only two configured days).
   */
  maxOccurrences: number | null;
};

export const AUTOMATION_JOBS: readonly AutomationJobSpec[] = [
  {
    type: "quote_expiry_warning",
    audience: "customer",
    pattern: "explicit",
    group: "orders",
    entityType: "order",
    label: "Quote expiry warning",
    description: "Tells a customer their quote is about to run out, before it does.",
    // Not optional: this is the message that lets somebody complete a purchase
    // they have already started. Silencing it turns an expiry into a surprise.
    optional: false,
    maxOccurrences: 1,
  },
  {
    type: "quote_expired",
    audience: "customer",
    pattern: "explicit",
    group: "orders",
    entityType: "order",
    label: "Quote expired",
    description: "Confirms a quote has lapsed once its expiry passes, and records the expiry.",
    optional: false,
    maxOccurrences: 1,
  },
  {
    type: "order_action_required",
    audience: "customer",
    pattern: "discovery",
    group: "orders",
    entityType: "order",
    label: "Waiting on the customer",
    description:
      "Follows up when an order has been sitting in a state that needs the customer to do something.",
    optional: true,
    // Two nudges and then silence. A third is nagging, and the order is still
    // visible to staff in the queue regardless.
    maxOccurrences: 2,
  },
  {
    type: "pickup_reminder",
    audience: "customer",
    pattern: "discovery",
    group: "fulfillment",
    entityType: "order",
    label: "Pickup reminder",
    description: "Reminds a customer that a finished order is waiting to be collected.",
    optional: true,
    maxOccurrences: null,
  },
  {
    type: "pickup_stale_staff",
    audience: "staff",
    pattern: "discovery",
    group: "fulfillment",
    entityType: "order",
    label: "Uncollected pickup",
    description: "Tells staff an order has been ready for collection for an unusually long time.",
    optional: true,
    maxOccurrences: 1,
  },
  {
    type: "support_waiting_customer",
    audience: "customer",
    pattern: "discovery",
    group: "support",
    entityType: "support_conversation",
    label: "Support waiting on the customer",
    description: "Reminds a customer that a conversation is waiting on their reply.",
    optional: true,
    maxOccurrences: 1,
  },
  {
    type: "support_waiting_staff",
    audience: "staff",
    pattern: "discovery",
    group: "support",
    entityType: "support_conversation",
    label: "Support waiting on staff",
    description: "Alerts the support desk that a customer has been waiting for a reply.",
    optional: true,
    maxOccurrences: 1,
  },
  {
    type: "production_due_soon",
    audience: "staff",
    pattern: "discovery",
    group: "production",
    entityType: "production_job",
    label: "Production due soon",
    description: "Warns the workshop that a job's due date is approaching.",
    optional: true,
    maxOccurrences: 1,
  },
  {
    type: "production_overdue",
    audience: "staff",
    pattern: "discovery",
    group: "production",
    entityType: "production_job",
    label: "Production overdue",
    description: "Alerts the workshop that a job has passed its due date.",
    optional: true,
    maxOccurrences: 1,
  },
  {
    type: "production_blocked",
    audience: "staff",
    pattern: "discovery",
    group: "production",
    entityType: "production_job",
    label: "Production blocked too long",
    description: "Alerts the workshop that a job has been blocked or on hold beyond the threshold.",
    optional: true,
    maxOccurrences: 1,
  },
];

export const AUTOMATION_JOBS_BY_TYPE: Readonly<Record<AutomationJobType, AutomationJobSpec>> =
  Object.freeze(
    Object.fromEntries(AUTOMATION_JOBS.map((spec) => [spec.type, spec])) as Record<
      AutomationJobType,
      AutomationJobSpec
    >
  );

export function jobsInGroup(group: AutomationGroup): AutomationJobSpec[] {
  return AUTOMATION_JOBS.filter((spec) => spec.group === group);
}

// ---------------------------------------------------------------------------
// Job state
// ---------------------------------------------------------------------------

/**
 * Five states, and the distinction between `cancelled` and `completed` is real.
 *
 * - `pending` — due at `run_at`, nothing has claimed it.
 * - `running` — a worker holds it. A crash leaves it here, which is why the
 *   claim carries a lease that a later invocation can reclaim.
 * - `completed` — the action was taken, or was correctly skipped because the
 *   entity was still eligible but the send was already recorded upstream.
 * - `cancelled` — the reminder became wrong before it fired. A paid quote, a
 *   collected order, a customer who replied. Nothing was sent and nothing
 *   should have been.
 * - `failed` — it should have fired and did not, and the attempts are spent.
 *   This is the only state that is somebody's problem.
 */
export const AUTOMATION_JOB_STATES = ["pending", "running", "completed", "cancelled", "failed"] as const;
export type AutomationJobState = (typeof AUTOMATION_JOB_STATES)[number];

export const AUTOMATION_STATE_LABELS: Readonly<Record<AutomationJobState, string>> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
};

// ---------------------------------------------------------------------------
// Failure categories and the retry policy
// ---------------------------------------------------------------------------

/**
 * Why a job did not do its work.
 *
 * The category decides whether a retry is correct, so it is chosen by the
 * handler rather than inferred from an error string at the call site. Two of
 * these are not really failures at all and are recorded as such: `not_eligible`
 * means the world changed and the reminder was correctly abandoned.
 */
export const AUTOMATION_FAILURE_CATEGORIES = [
  "transient",
  "invalid_recipient",
  "not_eligible",
  "configuration",
  "unknown",
] as const;
export type AutomationFailureCategory = (typeof AUTOMATION_FAILURE_CATEGORIES)[number];

export const AUTOMATION_FAILURE_LABELS: Readonly<Record<AutomationFailureCategory, string>> = {
  transient: "Temporary problem",
  invalid_recipient: "Bad address",
  not_eligible: "No longer applicable",
  configuration: "Not configured",
  unknown: "Unknown",
};

/**
 * How many attempts each category is worth, and how long to wait between them.
 *
 * Bounded on purpose. A reminder that has failed five times is not going to
 * succeed on the sixth, and a job retried forever is a job that hides a real
 * outage behind a number that never stops going up.
 */
export const MAX_ATTEMPTS_BY_CATEGORY: Readonly<Record<AutomationFailureCategory, number>> = {
  // A provider timeout or a network blip. Worth several goes.
  transient: 5,
  // The address is wrong. It will be wrong next time too.
  invalid_recipient: 1,
  // Not a failure. The job is cancelled rather than retried.
  not_eligible: 1,
  // Missing API key, unset staff address. Retrying cannot fix it, and the
  // worker raises an operational alert instead so somebody configures it.
  configuration: 1,
  unknown: 3,
};

/** The ceiling no category may exceed, asserted by the tests. */
export const ABSOLUTE_MAX_ATTEMPTS = 5;

export function isRetryable(category: AutomationFailureCategory, attemptCount: number): boolean {
  if (category === "not_eligible" || category === "invalid_recipient" || category === "configuration") {
    return false;
  }
  return attemptCount < MAX_ATTEMPTS_BY_CATEGORY[category];
}

/**
 * When to try again, in seconds from now.
 *
 * Exponential with a ceiling, so a provider having a bad ten minutes is waited
 * out rather than hammered, and a job cannot schedule itself a week away.
 */
export function retryDelaySeconds(attemptCount: number): number {
  const base = 5 * 60;
  const delay = base * Math.pow(2, Math.max(0, attemptCount - 1));
  return Math.min(delay, 6 * 60 * 60);
}

// ---------------------------------------------------------------------------
// Dedupe keys
// ---------------------------------------------------------------------------

/** Characters a key may hold, mirroring `notificationEventKey`. */
const KEY_SAFE = /[^a-zA-Z0-9._:-]/g;

const safe = (value: unknown, max: number): string =>
  String(value ?? "").replace(KEY_SAFE, "-").slice(0, max);

/**
 * The durable identity of one logical reminder.
 *
 * `occurrence` is what makes a second reminder for the same entity genuinely
 * new — `day3`, `day7`, `n1`, an ISO date. It is never a full timestamp: a key
 * that changes every second is a key that dedupes nothing.
 */
export function automationDedupeKey(
  type: AutomationJobType,
  entityId: string,
  occurrence: string
): string {
  return `${type}:${safe(entityId, 60)}:${safe(occurrence, 40)}`.slice(0, 160);
}

/**
 * The quote reminder's key, which deliberately carries the expiry it was
 * scheduled against.
 *
 * This is the one case where the schedule itself belongs in the key. If staff
 * move a quote's expiry from Friday to the following Wednesday, the Thursday
 * reminder is no longer the right reminder — it is a *different* one, and the
 * customer should get the new one even though they may already have had the
 * old. Keying on the entity alone would suppress it forever; keying on the
 * clock would send one every run. Keying on the expiry sends exactly one per
 * distinct expiry, which is the behaviour a person would describe.
 *
 * Truncated to the minute, so a re-save that does not move the expiry does not
 * mint a second reminder.
 */
export function quoteExpiryDedupeKey(
  type: "quote_expiry_warning" | "quote_expired",
  orderId: string,
  expiresAt: string
): string {
  const minute = expiresAt.slice(0, 16).replace(/[:T-]/g, "");
  return automationDedupeKey(type, orderId, minute);
}

/** The `dayN` occurrence for a cadence-driven customer reminder. */
export function dayOccurrence(days: number): string {
  return `day${Math.max(0, Math.trunc(days))}`;
}

/** The `nN` occurrence for a capped follow-up sequence. */
export function sequenceOccurrence(index: number): string {
  return `n${Math.max(1, Math.trunc(index))}`;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * Whole hours between two instants, floored.
 *
 * Everything scheduling-related in this system is computed from a stored
 * `timestamptz` against `Date.now()`, both of which are UTC instants. No part of
 * the backend consults a local timezone, and no threshold is expressed in one:
 * "waiting eight hours" is eight hours wherever the reader is standing. The
 * business timezone in `commerce_settings` exists for *display*, and the worker
 * never reads it.
 */
export function hoursBetween(from: string | Date, to: string | Date): number {
  const start = from instanceof Date ? from.getTime() : Date.parse(from);
  const end = to instanceof Date ? to.getTime() : Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.floor((end - start) / 3_600_000);
}

/** Whole days between two instants, floored. */
export function daysBetween(from: string | Date, to: string | Date): number {
  return Math.floor(hoursBetween(from, to) / 24);
}

/**
 * A `date` column read as the end of that day in UTC.
 *
 * `production_jobs.due_date` is a bare `date` — it carries no time and no zone.
 * A job due "today" is not late at 00:01, so the comparison instant is the end
 * of the day rather than its start. Doing this any other way makes every job
 * overdue for twenty-four hours before it actually is.
 */
export function endOfDayUtc(date: string): number {
  return Date.parse(`${String(date).slice(0, 10)}T23:59:59.999Z`);
}
