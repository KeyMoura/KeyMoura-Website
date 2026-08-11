/**
 * Production job domain rules.
 *
 * Pure and dependency-free on purpose: the API routes, the queue, the job page
 * and the printable documents all import from here, so a rule cannot be stated
 * one way on the server and another way in the browser. Everything in this file
 * is directly unit-testable without a database.
 */

export const PRODUCTION_STATUSES = [
  "not_started",
  "planning",
  "waiting_on_customer",
  "waiting_on_materials",
  "scheduled",
  "in_progress",
  "quality_check",
  "rework_required",
  "ready_for_pickup",
  "ready_to_ship",
  "completed",
  "on_hold",
  "cancelled",
] as const;

export type ProductionStatus = (typeof PRODUCTION_STATUSES)[number];

export const PRODUCTION_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type ProductionPriority = (typeof PRODUCTION_PRIORITIES)[number];

export const PRODUCTION_TASK_KINDS = ["step", "completion", "quality"] as const;
export type ProductionTaskKind = (typeof PRODUCTION_TASK_KINDS)[number];

export const PRODUCTION_FILE_KINDS = [
  "cad",
  "cam",
  "drawing",
  "reference",
  "customer_approved",
  "other",
] as const;
export type ProductionFileKind = (typeof PRODUCTION_FILE_KINDS)[number];

/**
 * Staff-facing wording. `blocked` marks the states where the shop is waiting on
 * something outside its control — the queue groups by it, so "what is actually
 * stalled" is answerable without reading every job.
 */
export const STATUS_META: Readonly<
  Record<ProductionStatus, { label: string; description: string; blocked: boolean }>
> = {
  not_started: { label: "Not started", description: "Raised but no work has begun.", blocked: false },
  planning: { label: "Planning", description: "Being designed, programmed, or costed.", blocked: false },
  waiting_on_customer: {
    label: "Waiting on customer",
    description: "Blocked until the customer answers or approves something.",
    blocked: true,
  },
  waiting_on_materials: {
    label: "Waiting on materials",
    description: "Blocked until stock or an outside service arrives.",
    blocked: true,
  },
  scheduled: { label: "Scheduled", description: "Planned onto the machine, not yet running.", blocked: false },
  in_progress: { label: "In progress", description: "Being made right now.", blocked: false },
  quality_check: { label: "Quality check", description: "Made, being inspected.", blocked: false },
  rework_required: { label: "Rework required", description: "Failed inspection and must be reworked.", blocked: false },
  ready_for_pickup: { label: "Ready for pickup", description: "Finished and waiting for the customer to collect.", blocked: false },
  ready_to_ship: { label: "Ready to ship", description: "Finished and waiting to be packed and sent.", blocked: false },
  completed: { label: "Completed", description: "Handed over. No further work.", blocked: false },
  on_hold: { label: "On hold", description: "Deliberately paused.", blocked: true },
  cancelled: { label: "Cancelled", description: "Abandoned. No further work.", blocked: false },
};

export const PRIORITY_META: Readonly<
  Record<ProductionPriority, { label: string; weight: number }>
> = {
  urgent: { label: "Urgent", weight: 0 },
  high: { label: "High", weight: 1 },
  normal: { label: "Normal", weight: 2 },
  low: { label: "Low", weight: 3 },
};

export const TASK_KIND_META: Readonly<Record<ProductionTaskKind, { label: string; heading: string }>> = {
  step: { label: "Manufacturing step", heading: "Manufacturing steps" },
  completion: { label: "Completion check", heading: "Completion checklist" },
  quality: { label: "Quality check", heading: "Quality control" },
};

export const FILE_KIND_META: Readonly<Record<ProductionFileKind, { label: string }>> = {
  cad: { label: "CAD" },
  cam: { label: "CAM" },
  drawing: { label: "Drawing" },
  reference: { label: "Reference image" },
  customer_approved: { label: "Customer-approved" },
  other: { label: "Other" },
};

/** Terminal states. Reaching one ends the job; leaving one is an explicit reopen. */
export const TERMINAL_STATUSES: readonly ProductionStatus[] = ["completed", "cancelled"];

/** States that require the actor to say why. */
export const REASON_REQUIRED_STATUSES: readonly ProductionStatus[] = [
  "on_hold",
  "rework_required",
  "cancelled",
];

export const isProductionStatus = (value: unknown): value is ProductionStatus =>
  typeof value === "string" && (PRODUCTION_STATUSES as readonly string[]).includes(value);

export const isProductionPriority = (value: unknown): value is ProductionPriority =>
  typeof value === "string" && (PRODUCTION_PRIORITIES as readonly string[]).includes(value);

export const isProductionTaskKind = (value: unknown): value is ProductionTaskKind =>
  typeof value === "string" && (PRODUCTION_TASK_KINDS as readonly string[]).includes(value);

export const isProductionFileKind = (value: unknown): value is ProductionFileKind =>
  typeof value === "string" && (PRODUCTION_FILE_KINDS as readonly string[]).includes(value);

export const isTerminalStatus = (status: ProductionStatus) => TERMINAL_STATUSES.includes(status);

export const statusNeedsReason = (status: ProductionStatus) => REASON_REQUIRED_STATUSES.includes(status);

export type ProductionJobLike = {
  status: ProductionStatus;
  priority: ProductionPriority;
  due_date: string | null;
  promised_date?: string | null;
  created_at?: string;
};

export type ProductionTaskLike = {
  kind: ProductionTaskKind;
  is_done: boolean;
};

/**
 * Whether a status change is allowed, and if not, why in staff wording.
 *
 * Deliberately permissive between live states. A shop knob may go
 * not_started → in_progress → completed while a one-off fixture wanders through
 * planning, materials, rework and QC; hard-coding one path would make the
 * simple job fight the tool. What is refused is only what is actually wrong:
 *
 *  - re-selecting the current status, so a dropdown touch is never a write
 *  - leaving a terminal state by anything other than an explicit reopen
 *  - entering a state that must be explained, without the explanation
 */
export function transitionProblem(
  from: ProductionStatus,
  to: ProductionStatus,
  options: { reason?: string | null; reopen?: boolean } = {}
): string | null {
  if (!isProductionStatus(to)) return "That is not a production status.";

  if (from === to) return `This job is already ${STATUS_META[to].label.toLowerCase()}.`;

  if (isTerminalStatus(from)) {
    if (!options.reopen) {
      return `${STATUS_META[from].label} is a final state. Reopen the job to keep working on it.`;
    }
    if (isTerminalStatus(to)) {
      return `Reopening moves a job back into live work, not to ${STATUS_META[to].label.toLowerCase()}.`;
    }
  }

  if (statusNeedsReason(to) && !(options.reason ?? "").trim()) {
    return `Say why this job is going to ${STATUS_META[to].label.toLowerCase()}.`;
  }

  return null;
}

/** The statuses offered for a job, excluding its current one. */
export function nextStatusOptions(from: ProductionStatus): ProductionStatus[] {
  if (isTerminalStatus(from)) return [];
  return PRODUCTION_STATUSES.filter((status) => status !== from);
}

/**
 * The column writes a status change implies.
 *
 * Kept here rather than in the route so "entering rework increments the rework
 * counter" is a tested rule instead of a line of code somebody can forget to
 * copy into a second update path.
 */
export function statusSideEffects(
  from: ProductionStatus,
  to: ProductionStatus,
  now: Date
): Record<string, string | number | null> {
  const iso = now.toISOString();
  const patch: Record<string, string | number | null> = { status: to };

  if (to === "in_progress") patch.started_at = iso;
  if (to === "ready_for_pickup" || to === "ready_to_ship") patch.ready_at = iso;

  if (to === "completed") {
    patch.completed_at = iso;
    patch.cancelled_at = null;
  }
  if (to === "cancelled") patch.cancelled_at = iso;

  // Reopening clears the terminal stamp it is leaving, so a reopened job does
  // not read as both finished and running.
  if (isTerminalStatus(from) && !isTerminalStatus(to)) {
    patch.completed_at = null;
    patch.cancelled_at = null;
  }

  // Leaving a hold clears the reason with it; a stale "waiting on 6061 bar"
  // sitting on a running job is worse than no reason at all.
  if (from === "on_hold" && to !== "on_hold") patch.hold_reason = null;

  return patch;
}

/**
 * Advisory checks shown in the confirmation before a job is completed.
 *
 * These never block. An unchecked QC list on a job that has one is worth a
 * second look; a job with no QC list at all raises nothing, which is what keeps
 * simple work simple.
 */
export function completionWarnings(
  job: { materials_acquired: boolean; actual_minutes: number | null },
  tasks: ProductionTaskLike[]
): string[] {
  const warnings: string[] = [];

  const openQuality = tasks.filter((task) => task.kind === "quality" && !task.is_done).length;
  if (openQuality > 0) {
    warnings.push(
      `${openQuality} quality check${openQuality === 1 ? " is" : "s are"} still unticked.`
    );
  }

  const openSteps = tasks.filter((task) => task.kind === "step" && !task.is_done).length;
  if (openSteps > 0) {
    warnings.push(`${openSteps} manufacturing step${openSteps === 1 ? " is" : "s are"} not marked done.`);
  }

  const openCompletion = tasks.filter((task) => task.kind === "completion" && !task.is_done).length;
  if (openCompletion > 0) {
    warnings.push(
      `${openCompletion} completion check${openCompletion === 1 ? " is" : "s are"} still unticked.`
    );
  }

  if (job.actual_minutes == null) warnings.push("No actual labour time has been recorded.");

  return warnings;
}

/**
 * Hard manufacturing gates for declaring a job complete.
 *
 * A checklist is optional, but once a job has one it is part of the work
 * definition rather than an advisory note. In particular, an open quality
 * check cannot be acknowledged away: doing so would make a failed or skipped
 * inspection indistinguishable from a passed one at the fulfillment handoff.
 */
export function completionProblem(tasks: ProductionTaskLike[]): string | null {
  const openQuality = tasks.filter((task) => task.kind === "quality" && !task.is_done).length;
  if (openQuality) {
    return `Complete ${openQuality} open quality check${openQuality === 1 ? "" : "s"} before finishing production.`;
  }

  const openRequired = tasks.filter((task) => task.kind !== "quality" && !task.is_done).length;
  if (openRequired) {
    return `Complete ${openRequired} open production task${openRequired === 1 ? "" : "s"} before finishing production.`;
  }

  return null;
}

/** Local-date comparison. A due date is a calendar day, not an instant. */
function startOfDay(value: Date) {
  const copy = new Date(value);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function parseDateOnly(value: string | null | undefined): Date | null {
  if (!value) return null;
  // `2026-08-04` parsed bare is UTC midnight, which reads as the previous day
  // west of Greenwich. Anchoring to local midnight keeps "due today" true all
  // day in the shop's own timezone.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const parsed = new Date(year, month - 1, day);
  if (Number.isNaN(parsed.getTime())) return null;

  // `new Date(2026, 12, 45)` is not an error — it rolls forward to 2027-02-14.
  // Without this round-trip an impossible date typed by staff would be accepted
  // as a real one months away, and the job would quietly carry a due date
  // nobody chose. Comparing the components back out is what makes the parser
  // reject rather than reinterpret.
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
    return null;
  }

  return parsed;
}

/** Overdue means: still live, has a due date, and that date is behind us. */
export function jobIsOverdue(job: ProductionJobLike, now: Date): boolean {
  if (isTerminalStatus(job.status)) return false;
  const due = parseDateOnly(job.due_date);
  if (!due) return false;
  return due < startOfDay(now);
}

/** Whole days until the due date. Negative when overdue, null when undated. */
export function daysUntilDue(job: ProductionJobLike, now: Date): number | null {
  const due = parseDateOnly(job.due_date);
  if (!due) return null;
  const diff = due.getTime() - startOfDay(now).getTime();
  return Math.round(diff / 86_400_000);
}

/**
 * Queue order: overdue first, then priority, then the nearest due date, then
 * oldest. Undated jobs sort behind dated ones at the same priority rather than
 * ahead of them, which is what `nulls last` does in the matching index.
 */
export function compareQueue(a: ProductionJobLike, b: ProductionJobLike, now: Date): number {
  const overdue = Number(jobIsOverdue(b, now)) - Number(jobIsOverdue(a, now));
  if (overdue !== 0) return overdue;

  const priority = PRIORITY_META[a.priority].weight - PRIORITY_META[b.priority].weight;
  if (priority !== 0) return priority;

  const dueA = parseDateOnly(a.due_date);
  const dueB = parseDateOnly(b.due_date);
  if (dueA && dueB && dueA.getTime() !== dueB.getTime()) return dueA.getTime() - dueB.getTime();
  if (dueA && !dueB) return -1;
  if (!dueA && dueB) return 1;

  return (a.created_at ?? "").localeCompare(b.created_at ?? "");
}

export function sortQueue<T extends ProductionJobLike>(jobs: readonly T[], now: Date): T[] {
  return [...jobs].sort((a, b) => compareQueue(a, b, now));
}

/** Checklist completion for one kind. `total` 0 means the list does not exist. */
export function checklistProgress(tasks: readonly ProductionTaskLike[], kind: ProductionTaskKind) {
  const relevant = tasks.filter((task) => task.kind === kind);
  const done = relevant.filter((task) => task.is_done).length;
  return {
    done,
    total: relevant.length,
    percent: relevant.length ? Math.round((done / relevant.length) * 100) : 0,
  };
}

export type JobDraftInput = {
  title?: unknown;
  description?: unknown;
  status?: unknown;
  priority?: unknown;
  quantity?: unknown;
  dueDate?: unknown;
  promisedDate?: unknown;
  assignedTo?: unknown;
  estimatedMinutes?: unknown;
  actualMinutes?: unknown;
  materialsRequired?: unknown;
  materialsAcquired?: unknown;
  externalServicesRequired?: unknown;
  internalNotes?: unknown;
  customerVisibleNotes?: unknown;
  orderId?: unknown;
  orderItemId?: unknown;
  productId?: unknown;
  customerId?: unknown;
};

export type JobDraft = {
  title: string;
  description: string | null;
  status: ProductionStatus;
  priority: ProductionPriority;
  quantity: number;
  due_date: string | null;
  promised_date: string | null;
  assigned_to: string | null;
  estimated_minutes: number | null;
  actual_minutes: number | null;
  materials_required: string | null;
  materials_acquired: boolean;
  external_services_required: string | null;
  internal_notes: string | null;
  customer_visible_notes: string | null;
  order_id: string | null;
  order_item_id: string | null;
  product_id: string | null;
  customer_id: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed || null;
};

const uuid = (value: unknown): string | null =>
  typeof value === "string" && UUID.test(value.trim()) ? value.trim() : null;

const dateOnly = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return parseDateOnly(trimmed) ? trimmed : null;
};

/**
 * Minutes. Refuses a value that is not a whole number rather than rounding it,
 * for the same reason the discount form refuses 12.5: staff must not type one
 * number and have a different one saved.
 */
function minutes(value: unknown, field: string, errors: string[]): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) {
    errors.push(`${field} has to be a number of minutes.`);
    return null;
  }
  if (!Number.isInteger(parsed)) {
    errors.push(`${field} has to be a whole number of minutes.`);
    return null;
  }
  if (parsed < 0) {
    errors.push(`${field} cannot be negative.`);
    return null;
  }
  return parsed;
}

/**
 * Validates and normalizes a job form submission.
 *
 * Returns every problem at once rather than the first, so a staff member fixes
 * one form instead of resubmitting three times.
 */
export function parseJobDraft(input: JobDraftInput): { draft: JobDraft | null; errors: string[] } {
  const errors: string[] = [];

  const title = text(input.title, 200);
  if (!title) errors.push("Give the job a title.");

  const status = input.status == null || input.status === "" ? "not_started" : input.status;
  if (!isProductionStatus(status)) errors.push("That is not a production status.");

  const priority = input.priority == null || input.priority === "" ? "normal" : input.priority;
  if (!isProductionPriority(priority)) errors.push("That is not a priority.");

  let quantity = 1;
  if (input.quantity != null && input.quantity !== "") {
    const parsed = typeof input.quantity === "number" ? input.quantity : Number(String(input.quantity).trim());
    if (!Number.isInteger(parsed) || parsed < 1) errors.push("Quantity has to be a whole number of at least 1.");
    else quantity = parsed;
  }

  const estimatedMinutes = minutes(input.estimatedMinutes, "Estimated labour", errors);
  const actualMinutes = minutes(input.actualMinutes, "Actual labour", errors);

  const dueDate = dateOnly(input.dueDate);
  if (input.dueDate && !dueDate) errors.push("The due date has to be a real date.");

  const promisedDate = dateOnly(input.promisedDate);
  if (input.promisedDate && !promisedDate) errors.push("The promised date has to be a real date.");

  if (errors.length) return { draft: null, errors };

  return {
    draft: {
      title: title as string,
      description: text(input.description, 5000),
      status: status as ProductionStatus,
      priority: priority as ProductionPriority,
      quantity,
      due_date: dueDate,
      promised_date: promisedDate,
      assigned_to: uuid(input.assignedTo),
      estimated_minutes: estimatedMinutes,
      actual_minutes: actualMinutes,
      materials_required: text(input.materialsRequired, 5000),
      materials_acquired: input.materialsAcquired === true || input.materialsAcquired === "true",
      external_services_required: text(input.externalServicesRequired, 5000),
      internal_notes: text(input.internalNotes, 10000),
      customer_visible_notes: text(input.customerVisibleNotes, 5000),
      order_id: uuid(input.orderId),
      order_item_id: uuid(input.orderItemId),
      product_id: uuid(input.productId),
      customer_id: uuid(input.customerId),
    },
    errors: [],
  };
}

/** "2 h 30 m" / "45 m" / "—". Used by the queue, the job page and the traveler. */
export function formatMinutes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const total = Math.max(0, Math.trunc(value));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (!hours) return `${rest} m`;
  if (!rest) return `${hours} h`;
  return `${hours} h ${rest} m`;
}

/**
 * Variance between estimate and actual, for the job page and workload view.
 * Null when either side is missing — an estimate compared against nothing is
 * not a variance, and showing 0 would read as "exactly on estimate".
 */
export function labourVariance(estimated: number | null, actual: number | null) {
  if (estimated == null || actual == null) return null;
  const delta = actual - estimated;
  return {
    deltaMinutes: delta,
    percent: estimated === 0 ? null : Math.round((delta / estimated) * 100),
    over: delta > 0,
  };
}

export type QueueBuckets<T> = {
  overdue: T[];
  blocked: T[];
  active: T[];
  finished: T[];
};

/**
 * Splits a queue into the four groups the dashboard and the queue page both
 * show. One job appears in exactly one bucket, so the counts add up to the
 * total and staff never chase the same job twice.
 */
export function bucketJobs<T extends ProductionJobLike>(jobs: readonly T[], now: Date): QueueBuckets<T> {
  const buckets: QueueBuckets<T> = { overdue: [], blocked: [], active: [], finished: [] };

  for (const job of sortQueue(jobs, now)) {
    if (isTerminalStatus(job.status)) buckets.finished.push(job);
    else if (jobIsOverdue(job, now)) buckets.overdue.push(job);
    else if (STATUS_META[job.status].blocked) buckets.blocked.push(job);
    else buckets.active.push(job);
  }

  return buckets;
}
