import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCTION_STATUSES,
  PRIORITY_META,
  STATUS_META,
  bucketJobs,
  checklistProgress,
  completionProblem,
  completionWarnings,
  compareQueue,
  daysUntilDue,
  formatMinutes,
  isTerminalStatus,
  jobIsOverdue,
  labourVariance,
  nextStatusOptions,
  parseJobDraft,
  sortQueue,
  statusSideEffects,
  transitionProblem,
  type ProductionJobLike,
  type ProductionStatus,
} from "../src/lib/production/jobs.ts";

const NOW = new Date(2026, 7, 4, 13, 30, 0); // 2026-08-04 local, mid-afternoon

const job = (overrides: Partial<ProductionJobLike> = {}): ProductionJobLike => ({
  status: "in_progress",
  priority: "normal",
  due_date: null,
  created_at: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

test("re-selecting the current status is refused, so a dropdown touch never writes", () => {
  for (const status of PRODUCTION_STATUSES) {
    const problem = transitionProblem(status, status);
    assert.ok(problem, `${status} -> ${status} must be refused`);
    assert.match(problem, /already/i);
  }
});

test("live states move freely between each other", () => {
  // A simple job goes not_started -> in_progress -> completed; a complex one
  // wanders. Neither may be blocked by the other's shape.
  const live = PRODUCTION_STATUSES.filter((status) => !isTerminalStatus(status));
  for (const from of live) {
    for (const to of live) {
      if (from === to) continue;
      const reason = "because the customer asked";
      assert.equal(
        transitionProblem(from, to, { reason }),
        null,
        `${from} -> ${to} should be allowed`
      );
    }
  }
});

test("the simplest possible job is not blocked by the workflow", () => {
  assert.equal(transitionProblem("not_started", "in_progress"), null);
  assert.equal(transitionProblem("in_progress", "completed"), null);
});

test("a terminal state cannot be left without an explicit reopen", () => {
  for (const from of ["completed", "cancelled"] as ProductionStatus[]) {
    const problem = transitionProblem(from, "in_progress");
    assert.ok(problem, `${from} must not silently reopen`);
    assert.match(problem, /final state|reopen/i);

    assert.equal(
      transitionProblem(from, "in_progress", { reopen: true }),
      null,
      `${from} must reopen when asked explicitly`
    );
  }
});

test("reopening cannot jump straight to the other terminal state", () => {
  const problem = transitionProblem("completed", "cancelled", { reopen: true, reason: "scrapped" });
  assert.ok(problem);
  assert.match(problem, /live work/i);
});

test("states that need explaining refuse to be entered silently", () => {
  for (const to of ["on_hold", "rework_required", "cancelled"] as ProductionStatus[]) {
    const missing = transitionProblem("in_progress", to);
    assert.ok(missing, `${to} must demand a reason`);
    assert.match(missing, /say why/i);

    assert.equal(transitionProblem("in_progress", to, { reason: "  " }), missing, "whitespace is not a reason");
    assert.equal(transitionProblem("in_progress", to, { reason: "bore undersize" }), null);
  }
});

test("states that do not need explaining accept a transition without one", () => {
  assert.equal(transitionProblem("in_progress", "quality_check"), null);
  assert.equal(transitionProblem("quality_check", "ready_to_ship"), null);
});

test("nextStatusOptions offers every other live status and nothing from a terminal one", () => {
  const options = nextStatusOptions("in_progress");
  assert.ok(!options.includes("in_progress"), "the current status is not an option");
  assert.equal(options.length, PRODUCTION_STATUSES.length - 1);
  assert.deepEqual(nextStatusOptions("completed"), []);
  assert.deepEqual(nextStatusOptions("cancelled"), []);
});

// ---------------------------------------------------------------------------
// Side effects of a transition
// ---------------------------------------------------------------------------

test("entering work stamps the start, finishing stamps the finish", () => {
  const started = statusSideEffects("not_started", "in_progress", NOW);
  assert.equal(started.status, "in_progress");
  assert.equal(started.started_at, NOW.toISOString());

  const done = statusSideEffects("quality_check", "completed", NOW);
  assert.equal(done.completed_at, NOW.toISOString());
  assert.equal(done.cancelled_at, null);
});

test("both ready states stamp the same readiness time", () => {
  for (const to of ["ready_for_pickup", "ready_to_ship"] as ProductionStatus[]) {
    assert.equal(statusSideEffects("quality_check", to, NOW).ready_at, NOW.toISOString());
  }
});

test("reopening clears the terminal stamps so a job is never both finished and running", () => {
  const reopened = statusSideEffects("completed", "in_progress", NOW);
  assert.equal(reopened.completed_at, null);
  assert.equal(reopened.cancelled_at, null);
  assert.equal(reopened.status, "in_progress");

  const uncancelled = statusSideEffects("cancelled", "planning", NOW);
  assert.equal(uncancelled.cancelled_at, null);
  assert.equal(uncancelled.completed_at, null);
});

test("leaving a hold clears its reason rather than leaving a stale one behind", () => {
  assert.equal(statusSideEffects("on_hold", "in_progress", NOW).hold_reason, null);
  // A transition that has nothing to do with holds must not touch the column.
  assert.ok(!("hold_reason" in statusSideEffects("in_progress", "quality_check", NOW)));
});

test("cancelling stamps the cancellation", () => {
  assert.equal(statusSideEffects("in_progress", "cancelled", NOW).cancelled_at, NOW.toISOString());
});

// ---------------------------------------------------------------------------
// Completion warnings — advisory, never blocking
// ---------------------------------------------------------------------------

test("a job with no checklists raises nothing about checklists", () => {
  const warnings = completionWarnings({ materials_acquired: true, actual_minutes: 60 }, []);
  assert.deepEqual(warnings, [], "simple work must stay simple");
});

test("unticked quality checks are surfaced but do not block", () => {
  const warnings = completionWarnings({ materials_acquired: true, actual_minutes: 60 }, [
    { kind: "quality", is_done: false },
    { kind: "quality", is_done: true },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /1 quality check is still unticked/);
});

test("warning counts are pluralised from the real number", () => {
  const warnings = completionWarnings({ materials_acquired: true, actual_minutes: 1 }, [
    { kind: "quality", is_done: false },
    { kind: "quality", is_done: false },
    { kind: "step", is_done: false },
  ]);
  assert.ok(warnings.some((line) => /2 quality checks are still unticked/.test(line)));
  assert.ok(warnings.some((line) => /1 manufacturing step is not marked done/.test(line)));
});

test("a missing actual labour time is worth mentioning", () => {
  const warnings = completionWarnings({ materials_acquired: true, actual_minutes: null }, []);
  assert.deepEqual(warnings, ["No actual labour time has been recorded."]);
});

test("open manufacturing and QC work blocks the fulfillment handoff", () => {
  assert.match(completionProblem([{ kind: "quality", is_done: false }]) ?? "", /quality check/);
  assert.match(completionProblem([{ kind: "step", is_done: false }]) ?? "", /production task/);
  assert.equal(
    completionProblem([
      { kind: "step", is_done: true },
      { kind: "quality", is_done: true },
    ]),
    null
  );
});

// ---------------------------------------------------------------------------
// Due dates and overdue
// ---------------------------------------------------------------------------

test("a due date is a calendar day, so a job due today is not overdue at any hour", () => {
  const dueToday = job({ due_date: "2026-08-04" });
  assert.equal(jobIsOverdue(dueToday, new Date(2026, 7, 4, 0, 0, 1)), false);
  assert.equal(jobIsOverdue(dueToday, new Date(2026, 7, 4, 23, 59, 59)), false);
  assert.equal(daysUntilDue(dueToday, NOW), 0);
});

test("yesterday is overdue, tomorrow is not", () => {
  assert.equal(jobIsOverdue(job({ due_date: "2026-08-03" }), NOW), true);
  assert.equal(jobIsOverdue(job({ due_date: "2026-08-05" }), NOW), false);
  assert.equal(daysUntilDue(job({ due_date: "2026-08-03" }), NOW), -1);
  assert.equal(daysUntilDue(job({ due_date: "2026-08-05" }), NOW), 1);
});

test("a finished job is never overdue, however far past its date", () => {
  for (const status of ["completed", "cancelled"] as ProductionStatus[]) {
    assert.equal(jobIsOverdue(job({ status, due_date: "2020-01-01" }), NOW), false);
  }
});

test("an undated job is never overdue and has no countdown", () => {
  assert.equal(jobIsOverdue(job({ due_date: null }), NOW), false);
  assert.equal(daysUntilDue(job({ due_date: null }), NOW), null);
});

test("an unparseable date is treated as no date rather than as 1970", () => {
  assert.equal(jobIsOverdue(job({ due_date: "not a date" }), NOW), false);
  assert.equal(jobIsOverdue(job({ due_date: "" }), NOW), false);
  assert.equal(daysUntilDue(job({ due_date: "2026-13-45" }), NOW), null);
});

// ---------------------------------------------------------------------------
// Queue ordering
// ---------------------------------------------------------------------------

test("overdue work outranks priority", () => {
  const overdueLow = job({ priority: "low", due_date: "2026-08-01" });
  const urgentOnTime = job({ priority: "urgent", due_date: "2026-08-30" });
  assert.ok(compareQueue(overdueLow, urgentOnTime, NOW) < 0, "an overdue job comes first");
});

test("priority orders jobs that are equally on time", () => {
  const sorted = sortQueue(
    [job({ priority: "low" }), job({ priority: "urgent" }), job({ priority: "normal" }), job({ priority: "high" })],
    NOW
  );
  assert.deepEqual(sorted.map((entry) => entry.priority), ["urgent", "high", "normal", "low"]);
});

test("at equal priority the nearer due date comes first and undated work sorts last", () => {
  const sorted = sortQueue(
    [
      job({ due_date: null, created_at: "2026-01-01T00:00:00.000Z" }),
      job({ due_date: "2026-08-20" }),
      job({ due_date: "2026-08-06" }),
    ],
    NOW
  );
  assert.deepEqual(sorted.map((entry) => entry.due_date), ["2026-08-06", "2026-08-20", null]);
});

test("sorting does not mutate the array it was given", () => {
  const input = [job({ priority: "low" }), job({ priority: "urgent" })];
  const before = input.map((entry) => entry.priority);
  sortQueue(input, NOW);
  assert.deepEqual(input.map((entry) => entry.priority), before);
});

test("every priority has a distinct weight, so ordering is total", () => {
  const weights = Object.values(PRIORITY_META).map((meta) => meta.weight);
  assert.equal(new Set(weights).size, weights.length);
});

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

test("each job lands in exactly one bucket and the counts add up", () => {
  const jobs = [
    job({ status: "in_progress", due_date: "2026-08-01" }), // overdue
    job({ status: "waiting_on_materials" }), // blocked
    job({ status: "waiting_on_customer" }), // blocked
    job({ status: "in_progress" }), // active
    job({ status: "completed" }), // finished
    job({ status: "cancelled" }), // finished
  ];
  const buckets = bucketJobs(jobs, NOW);

  assert.equal(buckets.overdue.length, 1);
  assert.equal(buckets.blocked.length, 2);
  assert.equal(buckets.active.length, 1);
  assert.equal(buckets.finished.length, 2);
  assert.equal(
    buckets.overdue.length + buckets.blocked.length + buckets.active.length + buckets.finished.length,
    jobs.length
  );
});

test("an overdue blocked job is counted as overdue, not twice", () => {
  const buckets = bucketJobs([job({ status: "waiting_on_materials", due_date: "2026-07-01" })], NOW);
  assert.equal(buckets.overdue.length, 1);
  assert.equal(buckets.blocked.length, 0);
});

test("the blocked statuses are the ones waiting on something outside the shop", () => {
  const blocked = PRODUCTION_STATUSES.filter((status) => STATUS_META[status].blocked);
  assert.deepEqual([...blocked].sort(), ["on_hold", "waiting_on_customer", "waiting_on_materials"]);
});

// ---------------------------------------------------------------------------
// Checklist progress
// ---------------------------------------------------------------------------

test("a list that does not exist reports zero rather than complete", () => {
  const progress = checklistProgress([], "quality");
  assert.deepEqual(progress, { done: 0, total: 0, percent: 0 });
});

test("progress counts only its own kind", () => {
  const tasks = [
    { kind: "quality" as const, is_done: true },
    { kind: "quality" as const, is_done: false },
    { kind: "step" as const, is_done: true },
  ];
  assert.deepEqual(checklistProgress(tasks, "quality"), { done: 1, total: 2, percent: 50 });
  assert.deepEqual(checklistProgress(tasks, "step"), { done: 1, total: 1, percent: 100 });
  assert.deepEqual(checklistProgress(tasks, "completion"), { done: 0, total: 0, percent: 0 });
});

// ---------------------------------------------------------------------------
// Draft validation
// ---------------------------------------------------------------------------

test("a job needs a title", () => {
  const { draft, errors } = parseJobDraft({ title: "   " });
  assert.equal(draft, null);
  assert.ok(errors.includes("Give the job a title."));
});

test("a minimal job gets sane defaults", () => {
  const { draft, errors } = parseJobDraft({ title: "Shift knob batch" });
  assert.deepEqual(errors, []);
  assert.equal(draft?.title, "Shift knob batch");
  assert.equal(draft?.status, "not_started");
  assert.equal(draft?.priority, "normal");
  assert.equal(draft?.quantity, 1);
  assert.equal(draft?.materials_acquired, false);
});

test("labour minutes are refused rather than rounded", () => {
  // Same rule as the discount field: the number saved must be the number typed.
  const { draft, errors } = parseJobDraft({ title: "x", estimatedMinutes: "90.5" });
  assert.equal(draft, null);
  assert.ok(errors.some((line) => /whole number of minutes/.test(line)));
});

test("negative and non-numeric labour is refused with its own sentence", () => {
  assert.ok(parseJobDraft({ title: "x", actualMinutes: "-5" }).errors.some((l) => /cannot be negative/.test(l)));
  assert.ok(parseJobDraft({ title: "x", actualMinutes: "abc" }).errors.some((l) => /number of minutes/.test(l)));
});

test("blank labour is absent, not zero", () => {
  const { draft } = parseJobDraft({ title: "x", estimatedMinutes: "", actualMinutes: null });
  assert.equal(draft?.estimated_minutes, null);
  assert.equal(draft?.actual_minutes, null);
});

test("zero minutes is a real value and survives", () => {
  assert.equal(parseJobDraft({ title: "x", actualMinutes: 0 }).draft?.actual_minutes, 0);
});

test("quantity must be a whole number of at least one", () => {
  for (const bad of ["0", "-2", "1.5"]) {
    const { errors } = parseJobDraft({ title: "x", quantity: bad });
    assert.ok(errors.some((line) => /whole number of at least 1/.test(line)), `${bad} must be refused`);
  }
  assert.equal(parseJobDraft({ title: "x", quantity: "12" }).draft?.quantity, 12);
});

test("a malformed date is refused rather than silently dropped", () => {
  const { draft, errors } = parseJobDraft({ title: "x", dueDate: "next tuesday" });
  assert.equal(draft, null);
  assert.ok(errors.some((line) => /due date has to be a real date/.test(line)));
});

test("every problem is reported at once", () => {
  const { errors } = parseJobDraft({ title: "", quantity: "0", estimatedMinutes: "1.5", dueDate: "nope" });
  assert.ok(errors.length >= 4, `expected several problems, got ${JSON.stringify(errors)}`);
});

test("a non-uuid link is dropped rather than sent to the database", () => {
  // Postgres would reject `"none"` as a uuid with a 500; refusing it here keeps
  // an optional field optional.
  const { draft } = parseJobDraft({ title: "x", orderId: "none", productId: "  ", assignedTo: 42 });
  assert.equal(draft?.order_id, null);
  assert.equal(draft?.product_id, null);
  assert.equal(draft?.assigned_to, null);
});

test("a real uuid link survives", () => {
  const id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  assert.equal(parseJobDraft({ title: "x", orderId: id }).draft?.order_id, id);
});

test("free text is trimmed and capped rather than rejected", () => {
  const { draft } = parseJobDraft({ title: `  ${"a".repeat(500)}  `, internalNotes: "  note  " });
  assert.equal(draft?.title.length, 200);
  assert.equal(draft?.internal_notes, "note");
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test("minutes format as hours and minutes", () => {
  assert.equal(formatMinutes(45), "45 m");
  assert.equal(formatMinutes(60), "1 h");
  assert.equal(formatMinutes(150), "2 h 30 m");
  assert.equal(formatMinutes(0), "0 m");
});

test("absent minutes render as a dash rather than zero", () => {
  assert.equal(formatMinutes(null), "—");
  assert.equal(formatMinutes(undefined), "—");
});

test("variance needs both sides, so a lone estimate is not reported as on target", () => {
  assert.equal(labourVariance(60, null), null);
  assert.equal(labourVariance(null, 60), null);
  assert.deepEqual(labourVariance(60, 90), { deltaMinutes: 30, percent: 50, over: true });
  assert.deepEqual(labourVariance(60, 30), { deltaMinutes: -30, percent: -50, over: false });
});

test("a zero estimate yields no percentage rather than infinity", () => {
  assert.deepEqual(labourVariance(0, 30), { deltaMinutes: 30, percent: null, over: true });
});

// ---------------------------------------------------------------------------
// Metadata completeness — these guard the UI against a status with no wording
// ---------------------------------------------------------------------------

test("every status has staff-facing wording", () => {
  for (const status of PRODUCTION_STATUSES) {
    assert.ok(STATUS_META[status]?.label, `${status} needs a label`);
    assert.ok(STATUS_META[status]?.description, `${status} needs a description`);
  }
});

test("the status list matches the database constraint exactly", () => {
  // If these drift, a status the UI offers is one Postgres will refuse.
  assert.deepEqual([...PRODUCTION_STATUSES].sort(), [
    "cancelled",
    "completed",
    "in_progress",
    "not_started",
    "on_hold",
    "planning",
    "quality_check",
    "ready_for_pickup",
    "ready_to_ship",
    "rework_required",
    "scheduled",
    "waiting_on_customer",
    "waiting_on_materials",
  ]);
});
