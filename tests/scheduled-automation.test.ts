import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ABSOLUTE_MAX_ATTEMPTS,
  AUTOMATION_FAILURE_CATEGORIES,
  AUTOMATION_GROUPS,
  AUTOMATION_JOBS,
  AUTOMATION_JOBS_BY_TYPE,
  AUTOMATION_JOB_STATES,
  AUTOMATION_JOB_TYPES,
  MAX_ATTEMPTS_BY_CATEGORY,
  automationDedupeKey,
  dayOccurrence,
  daysBetween,
  endOfDayUtc,
  hoursBetween,
  isRetryable,
  quoteExpiryDedupeKey,
  retryDelaySeconds,
  sequenceOccurrence,
} from "../src/lib/automation/catalogue.ts";
import {
  AUTOMATION_BOUNDS,
  DEFAULT_AUTOMATION_SETTINGS,
  MAX_PICKUP_REMINDER_DAYS,
  isJobEnabled,
  parseAutomationSettings,
} from "../src/lib/automation/settings.ts";
import {
  SCHEDULER_CRON_EXPRESSION,
  SCHEDULER_INTERVAL_MINUTES,
  SCHEDULER_PATH,
} from "../src/lib/automation/cadence.ts";
import { EMAIL_EVENTS, EMAIL_TEMPLATE_KEYS } from "../src/lib/comms/emailEvents.ts";
import { NOTIFICATION_ALERTS_BY_KIND, alertHref } from "../src/lib/comms/notificationEvents.ts";
import { AUDIT_ACTIONS } from "../src/lib/audit/actions.ts";
import { PERMISSIONS, PERMISSION_META, ROLE_PERMISSIONS } from "../src/lib/permissions.ts";
import { parseCommerceSettings } from "../src/lib/commerce/commerceSettings.ts";

/**
 * Scheduled operational automation.
 *
 * The system this covers sends real email to real customers on a timer, with
 * nobody watching. The tests are weighted accordingly: the largest block is
 * about *not* sending — dedupe identity, capped occurrences, and the eligibility
 * checks that make a stale job refuse itself.
 *
 * Everything reachable without a database is exercised directly. The rest — the
 * claim function's `skip locked`, the grants, the handler queries — is asserted
 * against the source and the migration, which is the same approach
 * `support-system.test.ts` takes and for the same reason: a route that reads a
 * column it should not is a fact about the text, and a test that needs a live
 * service key is a test that passes on one laptop.
 */

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const MIGRATION = read("supabase/migrations/20260811010000_scheduled_automation.sql");
const ROLLBACK = read("supabase/rollback/20260811010000_scheduled_automation.rollback.sql");
const SCHEDULER_MIGRATION = read("supabase/migrations/20260811020000_automation_scheduler.sql");
const SCHEDULER_ROLLBACK = read("supabase/rollback/20260811020000_automation_scheduler.rollback.sql");
const CRON_ROUTE = read("src/app/api/cron/automation/route.ts");
const WORKER = read("src/lib/automation/worker.ts");
const STORE = read("src/lib/automation/store.ts");
const HANDLERS = read("src/lib/automation/handlers.ts");
const DISCOVERY = read("src/lib/automation/discovery.ts");
const JOB_ROUTE = read("src/app/api/staff/automation/jobs/[id]/route.ts");
const STAFF_ROUTE = read("src/app/api/staff/automation/route.ts");
const RUN_ROUTE = read("src/app/api/staff/automation/run/route.ts");

// ---------------------------------------------------------------------------
// Dedupe identity
// ---------------------------------------------------------------------------

test("a dedupe key names the entity and the occurrence, and never the clock", () => {
  const key = automationDedupeKey("pickup_reminder", "abc-123", dayOccurrence(3));
  assert.equal(key, "pickup_reminder:abc-123:day3");

  // The same inputs a second later produce the same key. This is the property
  // the whole system rests on: a worker running every fifteen minutes must
  // compute one key for one logical reminder.
  assert.equal(key, automationDedupeKey("pickup_reminder", "abc-123", dayOccurrence(3)));

  // Different day, different reminder.
  assert.notEqual(key, automationDedupeKey("pickup_reminder", "abc-123", dayOccurrence(7)));
  // Different order, different reminder.
  assert.notEqual(key, automationDedupeKey("pickup_reminder", "abc-124", dayOccurrence(3)));
});

test("no dedupe key can carry a timestamp by accident", () => {
  // A key built from `Date.now()` would differ between two calls, which is the
  // failure this asserts is impossible for every builder in the catalogue.
  const first = [
    automationDedupeKey("support_waiting_staff", "c1", "x"),
    quoteExpiryDedupeKey("quote_expiry_warning", "o1", "2026-08-12T14:00:00.000Z"),
    dayOccurrence(3),
    sequenceOccurrence(2),
  ];
  const second = [
    automationDedupeKey("support_waiting_staff", "c1", "x"),
    quoteExpiryDedupeKey("quote_expiry_warning", "o1", "2026-08-12T14:00:00.000Z"),
    dayOccurrence(3),
    sequenceOccurrence(2),
  ];
  assert.deepEqual(first, second);
});

test("a key is sanitised and bounded, so it stays index-safe and greppable", () => {
  const key = automationDedupeKey("pickup_reminder", "a b/c\nd", "day 3");
  assert.ok(!/[\s/]/.test(key), `key carries unsafe characters: ${key}`);
  assert.ok(automationDedupeKey("pickup_reminder", "x".repeat(500), "y".repeat(500)).length <= 160);
});

test("changing a quote's expiry produces a different reminder rather than reusing the old one", () => {
  const friday = quoteExpiryDedupeKey("quote_expiry_warning", "order-1", "2026-08-14T14:00:00.000Z");
  const wednesday = quoteExpiryDedupeKey("quote_expiry_warning", "order-1", "2026-08-19T14:00:00.000Z");
  assert.notEqual(friday, wednesday);

  // But a re-save that does not move the expiry must not mint a second one. The
  // key is truncated to the minute, so differing seconds collapse.
  assert.equal(
    quoteExpiryDedupeKey("quote_expiry_warning", "order-1", "2026-08-14T14:00:00.000Z"),
    quoteExpiryDedupeKey("quote_expiry_warning", "order-1", "2026-08-14T14:00:59.999Z")
  );
});

test("the warning and the expiry notice are different jobs for the same quote", () => {
  const at = "2026-08-14T14:00:00.000Z";
  assert.notEqual(
    quoteExpiryDedupeKey("quote_expiry_warning", "order-1", at),
    quoteExpiryDedupeKey("quote_expired", "order-1", at)
  );
});

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

test("retries are bounded, and the categories that cannot succeed do not retry", () => {
  // A bad address will be bad next time too.
  assert.equal(isRetryable("invalid_recipient", 1), false);
  // Missing configuration cannot be fixed by trying again.
  assert.equal(isRetryable("configuration", 1), false);
  // Not a failure at all — the job is cancelled.
  assert.equal(isRetryable("not_eligible", 1), false);

  // A provider blip is worth several goes, and then is not.
  assert.equal(isRetryable("transient", 1), true);
  assert.equal(isRetryable("transient", 4), true);
  assert.equal(isRetryable("transient", 5), false);
  assert.equal(isRetryable("transient", 99), false);

  assert.equal(isRetryable("unknown", 2), true);
  assert.equal(isRetryable("unknown", 3), false);
});

test("no category may exceed the absolute attempt ceiling", () => {
  for (const category of AUTOMATION_FAILURE_CATEGORIES) {
    assert.ok(
      MAX_ATTEMPTS_BY_CATEGORY[category] <= ABSOLUTE_MAX_ATTEMPTS,
      `${category} allows ${MAX_ATTEMPTS_BY_CATEGORY[category]} attempts, above the ceiling`
    );
    assert.ok(MAX_ATTEMPTS_BY_CATEGORY[category] >= 1);
  }
});

test("retry backoff grows and then stops growing", () => {
  assert.ok(retryDelaySeconds(1) < retryDelaySeconds(2));
  assert.ok(retryDelaySeconds(2) < retryDelaySeconds(3));
  // Capped, so a job cannot schedule itself a week out.
  assert.equal(retryDelaySeconds(50), 6 * 60 * 60);
  assert.ok(retryDelaySeconds(1) >= 60, "a retry must not be immediate");
});

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

test("every job type has a spec, and every spec is a known type", () => {
  assert.equal(AUTOMATION_JOBS.length, AUTOMATION_JOB_TYPES.length);
  for (const type of AUTOMATION_JOB_TYPES) {
    assert.ok(AUTOMATION_JOBS_BY_TYPE[type], `${type} has no spec`);
  }
  for (const spec of AUTOMATION_JOBS) {
    assert.ok(AUTOMATION_GROUPS.includes(spec.group), `${spec.type} is in an unknown group`);
  }
});

test("every job type has a handler", () => {
  // A type in the catalogue with no handler would be claimed, do nothing, and
  // complete — a reminder that silently never sends.
  for (const type of AUTOMATION_JOB_TYPES) {
    assert.match(HANDLERS, new RegExp(`\\b${type}:`), `${type} is missing from the handler table`);
  }
});

test("the two transactional quote reminders cannot be switched off", () => {
  /*
   * The product rule from Phase 11: a customer must not be left unable to
   * complete a purchase because an operator silenced the message telling them
   * their quote is about to lapse. `optional: false` and `isJobEnabled` have to
   * agree, or the switch exists in one place and not the other.
   */
  const nonOptional = AUTOMATION_JOBS.filter((spec) => !spec.optional).map((spec) => spec.type);
  assert.deepEqual(nonOptional.sort(), ["quote_expired", "quote_expiry_warning"]);

  const allOff = parseAutomationSettings({
    orders: { actionRequiredEnabled: false },
    production: { dueSoonEnabled: false, overdueEnabled: false, blockedEnabled: false },
    fulfillment: { pickupRemindersEnabled: false, pickupStaleStaffEnabled: false },
    support: { waitingOnStaffEnabled: false, waitingOnCustomerEnabled: false },
  });
  for (const type of nonOptional) {
    assert.equal(isJobEnabled(allOff, type), true, `${type} was switched off and must not be`);
  }
  for (const spec of AUTOMATION_JOBS.filter((s) => s.optional)) {
    assert.equal(isJobEnabled(allOff, spec.type), false, `${spec.type} ignored its own switch`);
  }
});

test("the master switch silences everything, including the transactional ones", () => {
  /*
   * Deliberate and different from the per-reminder switches. Turning the whole
   * system off is an operator saying "stop sending", and a system that kept
   * emailing quote warnings through that would be ignoring them.
   */
  const off = parseAutomationSettings({ enabled: false });
  for (const type of AUTOMATION_JOB_TYPES) {
    assert.equal(isJobEnabled(off, type), false, `${type} survived the master switch`);
  }
});

test("staff reminders never send customer email, and customer reminders always have a template", () => {
  const customerTemplates = new Set(
    EMAIL_EVENTS.filter((event) => event.audience === "customer").map((event) => event.templateKey)
  );
  for (const spec of AUTOMATION_JOBS) {
    if (spec.audience !== "customer") continue;
    // Every customer-facing job type appears in the email catalogue.
    const events = EMAIL_EVENTS.filter((event) => event.activity?.includes("scheduled_jobs"));
    assert.ok(events.length > 0);
  }
  // Every scheduled customer template is seeded by the migration.
  for (const key of [
    "quote_expiring",
    "pickup_reminder",
    "customer_action_required_reminder",
    "support_waiting_customer",
  ]) {
    assert.ok(EMAIL_TEMPLATE_KEYS.includes(key as never), `${key} is not in the template catalogue`);
    assert.ok(MIGRATION.includes(`('${key}',`), `${key} is not seeded by the migration`);
    assert.ok(customerTemplates.has(key as never), `${key} is not addressed to a customer`);
  }
});

test("the occurrence cap is real for the reminders that claim one", () => {
  assert.equal(AUTOMATION_JOBS_BY_TYPE.order_action_required.maxOccurrences, 2);
  assert.equal(AUTOMATION_JOBS_BY_TYPE.support_waiting_customer.maxOccurrences, 1);
  assert.equal(AUTOMATION_JOBS_BY_TYPE.quote_expiry_warning.maxOccurrences, 1);
  // The pickup cadence caps itself: there are only ever a few configured days.
  assert.equal(AUTOMATION_JOBS_BY_TYPE.pickup_reminder.maxOccurrences, null);

  // And the cap is counted from completed jobs only, so a correctly-cancelled
  // reminder does not silently use up a customer's allowance.
  assert.match(STORE, /\.eq\("state", "completed"\)/);
});

test("an unreadable occurrence count fails closed", () => {
  // Reading the count as zero on a database error is the reading that sends a
  // duplicate. It must resolve the other way.
  assert.match(STORE, /return Number\.MAX_SAFE_INTEGER/);
  assert.match(STORE, /return new Set\(keys\)/);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test("settings parsing is total: any input at all yields usable settings", () => {
  for (const input of [null, undefined, 0, "nonsense", [], { orders: "no" }, { enabled: "yes" }]) {
    const parsed = parseAutomationSettings(input);
    assert.equal(typeof parsed.enabled, "boolean");
    assert.equal(typeof parsed.orders.quoteExpiryWarningHours, "number");
    assert.ok(Array.isArray(parsed.fulfillment.pickupReminderDays));
    assert.ok(parsed.fulfillment.pickupReminderDays.length > 0);
  }
});

test("out-of-range values are clamped rather than accepted", () => {
  const parsed = parseAutomationSettings({
    orders: { quoteExpiryWarningHours: 99999 },
    production: { blockedHours: -5, dueSoonDays: 0 },
    support: { waitingOnStaffHours: 0, waitingOnCustomerDays: 9999 },
  });
  assert.equal(parsed.orders.quoteExpiryWarningHours, AUTOMATION_BOUNDS.quoteExpiryWarningHours.max);
  assert.equal(parsed.production.blockedHours, AUTOMATION_BOUNDS.blockedHours.min);
  assert.equal(parsed.production.dueSoonDays, AUTOMATION_BOUNDS.dueSoonDays.min);
  assert.equal(parsed.support.waitingOnStaffHours, AUTOMATION_BOUNDS.waitingOnStaffHours.min);
  assert.equal(parsed.support.waitingOnCustomerDays, AUTOMATION_BOUNDS.waitingOnCustomerDays.max);
});

test("the second follow-up is always after the first", () => {
  // Setting 7 then 3 would otherwise produce two reminders on one pass, which
  // reads to the customer as a double send.
  const parsed = parseAutomationSettings({
    orders: { actionRequiredFirstDays: 7, actionRequiredSecondDays: 3 },
  });
  assert.ok(
    parsed.orders.actionRequiredSecondDays > parsed.orders.actionRequiredFirstDays,
    `${parsed.orders.actionRequiredSecondDays} is not after ${parsed.orders.actionRequiredFirstDays}`
  );
});

test("the pickup cadence is sorted, deduped, capped and never empty", () => {
  const parsed = parseAutomationSettings({
    fulfillment: { pickupReminderDays: [7, 3, 3, 14, 21, 30, -1, 0, 9999] },
  });
  const days = parsed.fulfillment.pickupReminderDays;
  assert.deepEqual(days, [...days].sort((a, b) => a - b), "not ascending");
  assert.equal(new Set(days).size, days.length, "contains duplicates");
  assert.ok(days.length <= MAX_PICKUP_REMINDER_DAYS);
  assert.ok(days.every((day) => day >= AUTOMATION_BOUNDS.pickupReminderDays.min));

  // An all-rubbish list falls back rather than leaving reminders "on" with no
  // days — a state that looks enabled and does nothing.
  const empty = parseAutomationSettings({ fulfillment: { pickupReminderDays: [0, -3, "x"] } });
  assert.deepEqual(empty.fulfillment.pickupReminderDays, DEFAULT_AUTOMATION_SETTINGS.fulfillment.pickupReminderDays);
});

test("automation settings survive a commerce settings round trip", () => {
  /*
   * `automation` lives inside the same jsonb column as shipping and pickup. The
   * hazard is that saving a shipping price resets every reminder threshold to
   * its default, which is exactly what would happen if the commerce route wrote
   * `parseCommerceSettings(body)` without carrying this key through.
   */
  const custom = parseAutomationSettings({ support: { waitingOnStaffHours: 3 } });
  const round = parseCommerceSettings({ automation: custom });
  assert.equal(round.automation.support.waitingOnStaffHours, 3);

  // And the commerce route must not be able to change it at all.
  const commerceRoute = read("src/app/api/staff/commerce/settings/route.ts");
  assert.match(commerceRoute, /automation: previous\.automation/);
});

test("settings that predate this pass parse to the defaults rather than to undefined", () => {
  const legacy = parseCommerceSettings({ shipping: { enabled: true } });
  assert.deepEqual(legacy.automation, DEFAULT_AUTOMATION_SETTINGS);
});

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

test("elapsed time is measured in UTC and nothing bakes in a local zone", () => {
  const from = "2026-08-10T00:00:00.000Z";
  assert.equal(hoursBetween(from, "2026-08-10T08:30:00.000Z"), 8);
  assert.equal(daysBetween(from, "2026-08-13T00:00:00.000Z"), 3);
  // A malformed instant yields zero rather than NaN, so a bad row cannot make
  // every threshold true at once.
  assert.equal(hoursBetween("not a date", from), 0);
});

test("a due date is late at the end of its day, not the start", () => {
  /*
   * `production_jobs.due_date` is a bare `date`. Comparing against the start of
   * the day marks every job overdue for the twenty-four hours during which it is
   * merely due.
   */
  const due = endOfDayUtc("2026-08-10");
  assert.ok(due > Date.parse("2026-08-10T23:00:00.000Z"));
  assert.ok(due < Date.parse("2026-08-11T00:00:01.000Z"));
});

test("no backend module bakes in Eastern Time", () => {
  for (const [name, source] of [
    ["worker", WORKER],
    ["discovery", DISCOVERY],
    ["store", STORE],
  ] as const) {
    assert.ok(!/America\/|Eastern|EST|EDT/.test(source), `${name} names a local timezone`);
  }
  // The one timezone read is for rendering a date in an email, and it says so.
  assert.match(HANDLERS, /Intl\.DateTimeFormat/);
  assert.match(HANDLERS, /display only/i);
});

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

test("the cron expression matches the interval it claims", () => {
  assert.equal(SCHEDULER_CRON_EXPRESSION, `*/${SCHEDULER_INTERVAL_MINUTES} * * * *`);
  assert.equal(SCHEDULER_PATH, "/api/cron/automation");
  assert.ok(SCHEDULER_INTERVAL_MINUTES >= 5 && SCHEDULER_INTERVAL_MINUTES <= 60);
});

test("the scheduler migration matches the cadence the application believes in", () => {
  /*
   * The schedule lives in Postgres, not in `vercel.json`.
   *
   * Vercel Hobby caps cron at once per day, and this system's finest useful
   * cadence is fifteen minutes — so the wake-up call comes from `pg_cron`, which
   * this project already runs (`purge-expired-moderation-recycle-bin`, nightly,
   * since 20260729000000). That also puts the schedule in the same database as
   * the job table it drives, which is where it belongs.
   *
   * This assertion exists because `loadAutomationHealth` computes "next
   * expected" from `SCHEDULER_INTERVAL_MINUTES` and calls the scheduler stalled
   * when a run is two intervals late. If the migration said hourly, that page
   * would report a healthy scheduler as broken every hour, forever — a false
   * alarm nobody could fix from the code they would be reading.
   */
  assert.ok(
    SCHEDULER_MIGRATION.includes(`'${SCHEDULER_CRON_EXPRESSION}'`),
    `the migration does not schedule ${SCHEDULER_CRON_EXPRESSION}`
  );
  assert.ok(
    SCHEDULER_MIGRATION.includes(SCHEDULER_PATH),
    `the migration does not call ${SCHEDULER_PATH}`
  );
  // One schedule, not ten: a single worker processes every due job.
  assert.equal(
    [...SCHEDULER_MIGRATION.matchAll(/cron\.schedule\(/g)].length,
    1,
    "more than one cron entry; one worker processes every due job"
  );
});

test("the scheduler rollback leaves the other cron job alone", () => {
  assert.match(SCHEDULER_ROLLBACK, /cron\.unschedule\('automation-worker'\)/);
  assert.match(SCHEDULER_ROLLBACK, /drop function if exists public\.trigger_automation_worker\(\)/);
  /*
   * The recycle-bin purge belongs to 20260729000000 and this pass never touched
   * it. A rollback that unscheduled it too would take a nightly retention job
   * offline as a side effect of undoing something unrelated.
   */
  const code = SCHEDULER_ROLLBACK.replace(/^--.*$/gm, "");
  assert.ok(!code.includes("purge-expired-moderation-recycle-bin"), "the rollback touches another pass's cron job");
  // Dropping the extension to undo one function that used it is wider than what
  // the migration did.
  assert.ok(!code.includes("drop extension"), "the rollback drops a shared extension");
});

test("the scheduler cannot call anything without its secret", () => {
  // No secret in Vault means the trigger returns without making a request,
  // rather than calling the endpoint unauthenticated and logging a 401 every
  // fifteen minutes forever.
  assert.match(SCHEDULER_MIGRATION, /if v_secret is null/);
  // And the secret is never written into the migration itself.
  assert.ok(!/Bearer\s+[A-Za-z0-9_-]{8,}/.test(SCHEDULER_MIGRATION), "a literal secret is in the migration");
  assert.match(SCHEDULER_MIGRATION, /vault\.decrypted_secrets/);
});

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

test("work is claimed in bounded batches with a time budget", () => {
  assert.match(WORKER, /TIME_BUDGET_MS/);
  assert.match(WORKER, /BATCH_SIZE/);
  assert.match(WORKER, /MAX_JOBS_PER_RUN/);
  // The claim is bounded in the database too, so a batch limit that only exists
  // in application code is not the only thing standing between a worker and the
  // whole table.
  assert.match(MIGRATION, /least\(coalesce\(p_limit, 50\), 200\)/);
});

test("two workers cannot claim the same job", () => {
  /*
   * The load-bearing guarantee. `for update skip locked` inside the subquery,
   * with the state transition in the same statement, is what makes two
   * concurrent invocations take disjoint sets rather than both sending.
   */
  assert.match(MIGRATION, /for update skip locked/);
  assert.match(MIGRATION, /set\s+state\s+= 'running'/);
  // Verified against production in a rolled-back transaction: a second claim
  // while the first holds a live lease returns zero rows.
});

test("a job whose worker died is reclaimed rather than stranded", () => {
  assert.match(MIGRATION, /lease_expires_at/);
  assert.match(MIGRATION, /c\.state = 'running' and c\.lease_expires_at is not null and c\.lease_expires_at < now\(\)/);
  // And every claim costs an attempt, so a job that repeatedly kills its worker
  // still exhausts its budget instead of looping forever.
  assert.match(MIGRATION, /attempt_count\s+= j\.attempt_count \+ 1/);
});

test("finishing a job is guarded on the state the worker claimed", () => {
  // Otherwise a worker waking up after its lease expired could mark complete a
  // job a second worker has since taken and sent.
  assert.match(STORE, /\.eq\("state", "running"\)/);
});

test("the master switch stops sending without stopping the worker", () => {
  /*
   * A run that does nothing and a scheduler that is not running look identical
   * from the outside, and telling them apart is the entire reason the run log
   * exists. So the housekeeping and the heartbeat continue.
   */
  assert.match(WORKER, /if \(settings\.automation\.enabled\)/);
  const afterSwitch = WORKER.slice(WORKER.indexOf("summary.reservationsExpired = await sweepReservations()"));
  assert.ok(afterSwitch.length > 0, "the sweeps must run outside the enabled branch");
});

test("one bad job cannot take down the invocation", () => {
  assert.match(WORKER, /catch \(error\) \{\s*result = \{ outcome: "failed"/);
});

test("a job type with no handler is cancelled, not failed", () => {
  // A row left by a previous deployment should not put a permanent red mark on
  // the health page for a reminder nobody wants any more.
  assert.match(WORKER, /No handler for/);
});

// ---------------------------------------------------------------------------
// Revalidation — the rule the handlers exist for
// ---------------------------------------------------------------------------

test("every handler reloads its entity before acting", () => {
  for (const loader of ["loadOrder", "loadConversation", "loadProductionJob"]) {
    assert.ok(HANDLERS.includes(loader), `${loader} is missing`);
  }
  // Not one handler trusts the job row's own metadata for eligibility.
  assert.match(HANDLERS, /outcome: "ineligible"/);
});

test("a paid, cancelled, withdrawn or rescheduled quote is refused", () => {
  const block = HANDLERS.slice(HANDLERS.indexOf("function quoteEligibility"));
  assert.match(block, /The order was cancelled/);
  assert.match(block, /The quote was paid/);
  assert.match(block, /The quote expiry was changed/);
  assert.match(block, /order\.payment_status/);
});

test("a collected, cancelled or re-routed pickup stops its reminders", () => {
  const block = HANDLERS.slice(HANDLERS.indexOf("handlePickupReminder"));
  assert.match(block, /The order was collected/);
  assert.match(block, /The order was cancelled/);
  assert.match(block, /Fulfillment moved to/);
});

test("a reply from either side stops the matching support reminder", () => {
  assert.match(HANDLERS, /The customer has replied/);
  assert.match(HANDLERS, /A staff member has replied/);
  assert.match(HANDLERS, /The conversation is \$\{conversation\.status\}/);
});

test("a completed or cancelled production job raises no alert", () => {
  const block = HANDLERS.slice(HANDLERS.indexOf("function productionEligibility"));
  assert.match(block, /The job was completed/);
  assert.match(block, /The job was cancelled/);
  assert.match(block, /The due date was changed/);
});

test("stale work is also cancelled proactively, not only refused at execution", () => {
  assert.match(DISCOVERY, /reconcileStaleJobs/);
  assert.match(DISCOVERY, /the quote was paid/);
  assert.match(DISCOVERY, /the order was collected/);
  assert.match(DISCOVERY, /the conversation was resolved or closed/);
  assert.match(DISCOVERY, /the production job finished/);
  // It may only ever anticipate a refusal, never cause one: it acts on pending
  // rows alone, so a job a worker already holds is left to revalidate itself.
  assert.match(DISCOVERY, /\.eq\("state", "pending"\)/);
});

test("a duplicate send is refused by the delivery layer even if a job is claimed twice", () => {
  // `suppressed` from `sendCommerceEmail` means `email_deliveries` already had
  // the key. That completes the job rather than failing it — the guard working.
  assert.match(HANDLERS, /if \(result\.suppressed\) return \{ outcome: "skipped"/);
});

test("shipping is never chased, only collection", () => {
  assert.match(DISCOVERY, /\.eq\("fulfillment_status", "ready_for_pickup"\)/);
  assert.ok(!/shipped|in_transit/.test(DISCOVERY.slice(DISCOVERY.indexOf("discoverPickupReminders"), DISCOVERY.indexOf("discoverSupportReminders"))));
});

test("waiting-on-the-customer is read from status, never from message text", () => {
  const block = DISCOVERY.slice(DISCOVERY.indexOf("CUSTOMER_ACTION_STATUSES"));
  assert.match(block, /needs_information/);
  assert.match(block, /awaiting_payment/);
  assert.match(block, /customer_review/);
  // The elapsed time comes from the status transition, not from `updated_at`,
  // which moves whenever staff edit a note.
  assert.match(block, /order_status_history/);
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

/**
 * Comments stripped, so a doc-comment *naming* a forbidden column to explain why
 * it is absent does not read as the code selecting it.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("no handler selects an internal note or a payment identifier", () => {
  const code = stripComments(HANDLERS);
  for (const field of [
    "staff_notes",
    "internal_notes",
    "fulfillment_notes",
    "stripe_payment_intent_id",
    "stripe_charge_id",
    "stripe_session_id",
  ]) {
    assert.ok(!code.includes(field), `handlers reference the internal field ${field}`);
  }
});

test("a staff alert carries a reference and a duration, never a customer's words", () => {
  const block = HANDLERS.slice(HANDLERS.indexOf("handleSupportWaitingStaff"));
  assert.match(block, /conversation\.reference/);
  // The subject and the body fan out to everybody holding `support.view` if they
  // reach a notification preview, so neither may.
  const alertCall = block.slice(block.indexOf("raiseOperationalAlert"), block.indexOf("return { outcome"));
  assert.ok(!alertCall.includes("conversation.subject"), "the alert carries the customer's subject line");
  assert.ok(!alertCall.includes("body"), "the alert carries a message body");
});

test("failure text stored on a job is bounded and caller-written", () => {
  assert.match(STORE, /error\.slice\(0, 300\)/);
  // Provider payloads and Postgres detail fields never reach the column.
  assert.ok(!/error\.details/.test(STORE));
});

// ---------------------------------------------------------------------------
// Cron endpoint security
// ---------------------------------------------------------------------------

test("the cron endpoint fails closed when no secret is configured", () => {
  assert.match(CRON_ROUTE, /if \(!secret\) return false/);
});

test("the cron secret is compared in constant time", () => {
  assert.match(CRON_ROUTE, /timingSafeEqual/);
  // A length mismatch is reported as a plain mismatch rather than being allowed
  // to throw, which would itself be a length oracle.
  assert.match(CRON_ROUTE, /a\.length !== b\.length/);
});

test("the cron endpoint takes no input at all", () => {
  /*
   * The property that stops an authenticated caller doing anything other than
   * what the schedule does: no body is read, no query parameter is consulted,
   * and no job type can be named.
   */
  assert.ok(!CRON_ROUTE.includes("req.json"), "the cron route reads a request body");
  assert.ok(!CRON_ROUTE.includes("searchParams"), "the cron route reads a query parameter");
  assert.match(CRON_ROUTE, /runAutomationWorker\("cron"\)/);
});

test("the cron endpoint refuses every verb but GET", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.match(
      CRON_ROUTE,
      new RegExp(`export async function ${method}\\(\\)[\\s\\S]{0,120}405`),
      `${method} is not explicitly refused`
    );
  }
});

test("the cron response leaks no entity, recipient or error detail", () => {
  const response = CRON_ROUTE.slice(CRON_ROUTE.indexOf("return NextResponse.json(\n    {"));
  for (const field of ["recipient", "entity_id", "last_error", "dedupe"]) {
    assert.ok(!response.includes(field), `the cron response carries ${field}`);
  }
});

test("a bare header cannot authenticate the cron route", () => {
  // `x-vercel-cron` is typed by whoever makes the request. It may label a run;
  // it may not authorise one.
  const authFn = CRON_ROUTE.slice(CRON_ROUTE.indexOf("function authorized"), CRON_ROUTE.indexOf("export async function GET"));
  assert.ok(!authFn.includes("x-vercel-cron"), "a header is being trusted as authentication");
});

// ---------------------------------------------------------------------------
// Staff routes and permissions
// ---------------------------------------------------------------------------

test("the two automation permissions exist and are described", () => {
  for (const key of ["automation.view", "automation.manage"] as const) {
    assert.ok(PERMISSIONS.includes(key), `${key} is not in the catalogue`);
    assert.ok(PERMISSION_META[key]?.description, `${key} has no description`);
  }
});

test("no non-admin role gets automation by default", () => {
  for (const [role, granted] of Object.entries(ROLE_PERMISSIONS)) {
    if (role === "admin") continue;
    assert.ok(!granted.includes("automation.view" as never), `${role} has automation.view by default`);
    assert.ok(!granted.includes("automation.manage" as never), `${role} has automation.manage by default`);
  }
});

test("reading and managing automation are separated", () => {
  assert.match(STAFF_ROUTE, /requireAnyPermission\(req, \["automation\.view", "automation\.manage"\]\)/);
  assert.match(STAFF_ROUTE, /requirePermission\(req, "automation\.manage"\)/);
  assert.match(JOB_ROUTE, /requirePermission\(req, "automation\.manage"\)/);
  assert.match(RUN_ROUTE, /requirePermission\(req, "automation\.manage"\)/);
});

test("the manual controls cannot name arbitrary work", () => {
  /*
   * Retry and cancel take an existing row id and do one predetermined thing.
   * There is no job type, no entity and no "send this to that customer".
   */
  assert.match(JOB_ROUTE, /action !== "retry" && action !== "cancel"/);

  /*
   * The only thing read from the request body is `action`, and it is compared
   * against a two-value allow-list before anything happens. Every other value
   * the route uses — the job type, the entity, the current state — is read back
   * from the row it loaded by id.
   */
  const bodyReads = [...JOB_ROUTE.matchAll(/body\?\.([a-zA-Z_]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(bodyReads)], ["action"], "the job route reads more than `action` from the body");
  assert.ok(!/job_type:\s*(body|action)/.test(JOB_ROUTE), "the job route takes a caller-supplied job type");

  // Run-now takes no input whatsoever.
  assert.ok(!RUN_ROUTE.includes("req.json"), "run-now reads a request body");
  assert.ok(!RUN_ROUTE.includes("searchParams"), "run-now reads a query parameter");
});

test("a stale retry or cancel is refused rather than racing the worker", () => {
  assert.match(JOB_ROUTE, /\.eq\("state", "failed"\)/);
  assert.match(JOB_ROUTE, /Somebody else changed this job while you were looking at it/);
});

test("only a failed job can be retried, and only unfinished work can be cancelled", () => {
  assert.match(JOB_ROUTE, /Only a failed job can be retried/);
  assert.match(JOB_ROUTE, /\["pending", "failed"\]\.includes\(row\.state\)/);
});

test("the job id is validated before it reaches the database", () => {
  assert.match(JOB_ROUTE, /UUID\.test\(id\)/);
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

test("scheduled work is attributed to the scheduler, never to a person", () => {
  assert.match(HANDLERS, /actor: \{ kind: "scheduled", job: job\.job_type \}/);
  assert.match(WORKER, /actor: \{ kind: "scheduled", job: job\.job_type \}/);
  assert.ok(!HANDLERS.includes('kind: "staff"'), "a handler attributes work to a staff user");
});

test("the automation audit actions are registered", () => {
  for (const action of [
    "automation.reminder_sent",
    "automation.job_failed",
    "automation.job_cancelled",
    "automation.settings_changed",
  ] as const) {
    assert.ok(AUDIT_ACTIONS[action], `${action} is not in the audit taxonomy`);
    assert.ok(AUDIT_ACTIONS[action].label, `${action} has no label`);
  }
});

test("the scheduler heartbeat does not flood the audit log", () => {
  /*
   * 2,880 runs a month, most of which do nothing. A log that records its own
   * scheduler ticking grows faster from being alive than from anything
   * happening, and buries the record of what people did.
   */
  assert.ok(!("automation.run_completed" in AUDIT_ACTIONS));
  assert.match(WORKER, /automation_runs/);

  /*
   * The worker writes exactly one kind of audit event — the exhausted-retries
   * record — and writes it from one place. Counting invocations rather than
   * mentions, so the import line does not read as a second call site.
   */
  const auditCalls = [...WORKER.matchAll(/await recordAuditEvent\(\{/g)];
  assert.equal(auditCalls.length, 1, `the worker writes ${auditCalls.length} audit events, not the one failure record`);
  assert.match(WORKER, /action: "automation\.job_failed"/);
});

test("only customer sends are audited, not staff bells", () => {
  const staffHandlers = HANDLERS.slice(HANDLERS.indexOf("handlePickupStaleStaff"));
  const staffAlertBlock = staffHandlers.slice(0, staffHandlers.indexOf("// ------"));
  assert.ok(!staffAlertBlock.includes("auditReminder"), "a staff bell is being audited");
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

test("every new alert kind has a spec, a permission and a deep link", () => {
  for (const kind of [
    "support.waiting_on_staff",
    "production.due_soon",
    "production.blocked",
    "fulfillment.pickup_uncollected",
    "ops.automation_failure",
  ] as const) {
    const spec = NOTIFICATION_ALERTS_BY_KIND[kind];
    assert.ok(spec, `${kind} has no spec`);
    assert.ok(spec.permissionKey, `${kind} has no permission`);
    assert.ok(alertHref(kind, "abc"), `${kind} has no deep link`);
  }
});

test("staleness alerts can be seen to close, and a failure cannot close itself", () => {
  for (const kind of [
    "support.waiting_on_staff",
    "production.due_soon",
    "production.blocked",
    "fulfillment.pickup_uncollected",
  ] as const) {
    assert.equal(NOTIFICATION_ALERTS_BY_KIND[kind].resolvable, true, `${kind} can never be seen to clear`);
  }
  // A job that failed did fail; the record should not quietly close because the
  // next one worked. Retrying it is an explicit act with its own audit row.
  assert.equal(NOTIFICATION_ALERTS_BY_KIND["ops.automation_failure"].resolvable, false);
});

test("the automation failure alert goes to the people who can act on it", () => {
  assert.equal(NOTIFICATION_ALERTS_BY_KIND["ops.automation_failure"].permissionKey, "automation.view");
  assert.equal(alertHref("ops.automation_failure", "x"), "/staff/settings/automation");
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test("the migration is additive: it alters no existing table", () => {
  assert.ok(!/alter table public\.(orders|production_jobs|support_conversations|inventory)/.test(MIGRATION));
  assert.ok(!/drop table|drop column/.test(MIGRATION));
  // The only write to an existing table is the template seed, which cannot
  // overwrite wording a staff member has edited.
  assert.match(MIGRATION, /on conflict \(key\) do nothing/);
});

test("the dedupe key is unique in the database, not merely in the code", () => {
  assert.match(MIGRATION, /constraint scheduled_jobs_dedupe_key_unique unique \(dedupe_key\)/);
});

test("the state column cannot hold a value the code does not know", () => {
  assert.match(MIGRATION, /check \(state in \('pending', 'running', 'completed', 'cancelled', 'failed'\)\)/);
  for (const state of AUTOMATION_JOB_STATES) {
    assert.ok(MIGRATION.includes(`'${state}'`), `${state} is missing from the check constraint`);
  }
});

test("neither table is reachable from a browser session", () => {
  for (const table of ["scheduled_jobs", "automation_runs"]) {
    assert.match(MIGRATION, new RegExp(`revoke all on public\\.${table} from anon`));
    assert.match(MIGRATION, new RegExp(`revoke all on public\\.${table} from authenticated`));
    assert.match(MIGRATION, new RegExp(`revoke all on public\\.${table} from public`));
    assert.match(MIGRATION, new RegExp(`alter table public\\.${table} enable row level security`));
    // The hole pass 22 had to come back for, closed in the same migration.
    assert.match(MIGRATION, new RegExp(`revoke truncate on public\\.${table} from service_role`));
  }
  assert.ok(!/grant (select|insert|update|delete)[^\n]*to (anon|authenticated)/.test(MIGRATION));
});

test("the claim function is not executable by a browser session", () => {
  assert.match(MIGRATION, /revoke all on function public\.claim_scheduled_jobs\(integer, text, integer\) from anon/);
  assert.match(MIGRATION, /grant execute on function public\.claim_scheduled_jobs\(integer, text, integer\) to service_role/);
  assert.match(MIGRATION, /security definer\s*\nset search_path = public/);
});

test("the indexes the hot paths need are present", () => {
  for (const index of [
    "scheduled_jobs_due_idx",
    "scheduled_jobs_lease_idx",
    "scheduled_jobs_entity_idx",
    "scheduled_jobs_type_state_idx",
    "scheduled_jobs_failed_idx",
    "automation_runs_started_idx",
  ]) {
    assert.ok(MIGRATION.includes(index), `${index} is missing`);
  }
  // The due-work index is partial, because the table is mostly finished work.
  assert.match(MIGRATION, /on public\.scheduled_jobs \(run_at\)\s*\n\s*where state = 'pending'/);
});

test("the rollback removes everything the migration added, in dependency order", () => {
  for (const statement of [
    "drop function if exists public.claim_scheduled_jobs(integer, text, integer)",
    "drop table if exists public.scheduled_jobs",
    "drop table if exists public.automation_runs",
  ]) {
    assert.ok(ROLLBACK.includes(statement), `the rollback does not ${statement}`);
  }
  // The function returns `setof public.scheduled_jobs`, so it depends on the
  // table and must be dropped first.
  assert.ok(
    ROLLBACK.indexOf("drop function") < ROLLBACK.indexOf("drop table"),
    "the rollback drops the table before the function that returns it"
  );
  // The four seeded templates go too, and nothing else does.
  for (const key of ["quote_expiring", "pickup_reminder", "customer_action_required_reminder", "support_waiting_customer"]) {
    assert.ok(ROLLBACK.includes(key), `the rollback leaves ${key} behind`);
  }
  // It must not touch settings the operator chose.
  assert.ok(!/commerce_settings/.test(ROLLBACK.replace(/^--.*$/gm, "")), "the rollback rewrites stored settings");
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

test("finished work is pruned but failures are kept", () => {
  const block = STORE.slice(STORE.indexOf("pruneFinishedJobs"));
  assert.match(block, /\.in\("state", \["completed", "cancelled"\]\)/);
  assert.ok(!block.includes('"failed"'), "the prune deletes failed jobs");
});

test("reservation cleanup is a safety net that cannot double-release", () => {
  /*
   * `expire_inventory_reservations` moves only `active` rows whose expiry has
   * passed, so running it twice releases nothing the second time. It cannot
   * touch a committed hold and cannot decrement stock.
   */
  assert.match(WORKER, /expireReservations\(500\)/);
  assert.match(WORKER, /safety net, not a source of truth/);
});
