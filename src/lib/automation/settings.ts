/**
 * Automation timing, stated once.
 *
 * Pure and dependency-free, like `commerceSettings.ts` beside it — the staff
 * form, the discovery pass, the worker and the tests all read these numbers from
 * here. A threshold parsed one way by a form and another way by the worker is
 * how a customer gets reminded on day one.
 *
 * ## Why this lives inside `commerce_settings` rather than a table of its own
 *
 * It is configuration, of exactly the kind `site_settings.commerce_settings`
 * already holds, and it is read on every worker invocation alongside the email
 * category switches it has to respect. A separate table would mean a second
 * read, a second cache story and a second migration for something that is four
 * dozen bytes of JSON. The column is `jsonb` with no shape constraint, so adding
 * a key is additive by construction: an install whose settings predate this pass
 * parses to the defaults below rather than to `undefined`.
 *
 * ## What is configurable and what is not
 *
 * Timing is configurable. *Whether a customer is told their quote is about to
 * expire* is not, and neither is the expiry notice itself. Those two keep an
 * active transaction moving — a customer who is midway through buying something
 * cannot be left to discover the lapse on their own because an operator turned a
 * switch off. Every other reminder is optional and can be disabled outright.
 * `AUTOMATION_JOBS[].optional` is the single source of that distinction; this
 * module simply has no `enabled` flag for the two that are not.
 *
 * Every duration here is a plain number of hours or days, applied to UTC
 * instants. No cron expression reaches this file, and none reaches the staff
 * page: an operator configures "3 days", never a five-field schedule string.
 */

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export type AutomationSettings = {
  /**
   * The master switch.
   *
   * Off means the worker still runs, still sweeps expired reservations and
   * still records its health — but sends nothing and schedules nothing. That is
   * deliberately not the same as "unconfigure the cron job": an operator
   * silencing automation for a week should not have to touch deployment
   * settings, and the health page should keep proving the scheduler is alive.
   */
  enabled: boolean;
  orders: {
    /** How long before a quote lapses the customer is warned. */
    quoteExpiryWarningHours: number;
    actionRequiredEnabled: boolean;
    /** First nudge, in days since the order entered a customer-action state. */
    actionRequiredFirstDays: number;
    /** Second and final nudge. Must exceed the first; parsing enforces it. */
    actionRequiredSecondDays: number;
  };
  production: {
    dueSoonEnabled: boolean;
    /** Days before `due_date` the workshop is warned. */
    dueSoonDays: number;
    overdueEnabled: boolean;
    blockedEnabled: boolean;
    /** Hours a job may sit in a blocked state before it is flagged. */
    blockedHours: number;
  };
  fulfillment: {
    pickupRemindersEnabled: boolean;
    /**
     * Which days after `ready_at` a customer is reminded. Ascending, deduped,
     * and capped at three entries — a fourth reminder about the same parcel is
     * not a reminder.
     */
    pickupReminderDays: number[];
    pickupStaleStaffEnabled: boolean;
    /** Days after which staff are told an order is still sitting uncollected. */
    pickupStaleStaffDays: number;
  };
  support: {
    waitingOnStaffEnabled: boolean;
    /** Hours a customer may be left waiting before the desk is alerted. */
    waitingOnStaffHours: number;
    waitingOnCustomerEnabled: boolean;
    /** Days before a customer is reminded that we are waiting on them. */
    waitingOnCustomerDays: number;
  };
};

/**
 * Defaults, chosen to match the brief's suggested cadence.
 *
 * Everything optional defaults **on**. Unlike shipping and pickup — which
 * default off because an unconfigured shop must not invent a delivery price —
 * there is no equivalent hazard here: the worst case of a default-on reminder is
 * that a staff member is told about their own late job. The reminders are also
 * the entire point of the feature, and one that ships switched off is one nobody
 * discovers.
 */
export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  enabled: true,
  orders: {
    quoteExpiryWarningHours: 24,
    actionRequiredEnabled: true,
    actionRequiredFirstDays: 3,
    actionRequiredSecondDays: 7,
  },
  production: {
    dueSoonEnabled: true,
    dueSoonDays: 1,
    overdueEnabled: true,
    blockedEnabled: true,
    blockedHours: 48,
  },
  fulfillment: {
    pickupRemindersEnabled: true,
    pickupReminderDays: [3, 7],
    pickupStaleStaffEnabled: true,
    pickupStaleStaffDays: 7,
  },
  support: {
    waitingOnStaffEnabled: true,
    waitingOnStaffHours: 8,
    waitingOnCustomerEnabled: true,
    waitingOnCustomerDays: 2,
  },
};

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * The range each field may hold, and the reason for each ceiling.
 *
 * Exported because the staff form renders `min` and `max` from exactly these
 * numbers rather than restating them in JSX — a form that permits a value the
 * parser then clamps is a form that silently discards what somebody typed.
 */
export const AUTOMATION_BOUNDS = {
  // Under an hour is not a warning, it is a notification. A fortnight before
  // expiry is not about expiry at all.
  quoteExpiryWarningHours: { min: 1, max: 336 },
  // A same-day nudge reads as pestering; past a quarter the order is not stalled,
  // it is abandoned, and staff have a queue for that.
  actionRequiredDays: { min: 1, max: 90 },
  // Warning about a job due in a month is not a due-soon warning.
  dueSoonDays: { min: 1, max: 30 },
  // An hour is noise; a month means nobody wanted to know.
  blockedHours: { min: 1, max: 720 },
  pickupReminderDays: { min: 1, max: 180 },
  pickupStaleStaffDays: { min: 1, max: 180 },
  // Under an hour would alert on conversations that arrived during lunch.
  waitingOnStaffHours: { min: 1, max: 336 },
  waitingOnCustomerDays: { min: 1, max: 90 },
} as const;

/** The most pickup reminder days an operator may configure. */
export const MAX_PICKUP_REMINDER_DAYS = 3;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const boundedInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
};

/**
 * Read stored JSON as settings. Total: every field is a number or a boolean
 * afterwards, whatever went in.
 *
 * This is the boundary where "a column with no shape" becomes a type, and it is
 * the only place allowed to assume anything about what a stored row contains.
 */
export function parseAutomationSettings(raw: unknown): AutomationSettings {
  const root = asRecord(raw);
  const orders = asRecord(root.orders);
  const production = asRecord(root.production);
  const fulfillment = asRecord(root.fulfillment);
  const support = asRecord(root.support);
  const d = DEFAULT_AUTOMATION_SETTINGS;

  const first = boundedInt(
    orders.actionRequiredFirstDays,
    d.orders.actionRequiredFirstDays,
    AUTOMATION_BOUNDS.actionRequiredDays.min,
    AUTOMATION_BOUNDS.actionRequiredDays.max
  );
  const second = boundedInt(
    orders.actionRequiredSecondDays,
    d.orders.actionRequiredSecondDays,
    AUTOMATION_BOUNDS.actionRequiredDays.min,
    AUTOMATION_BOUNDS.actionRequiredDays.max
  );

  return {
    enabled: bool(root.enabled, d.enabled),
    orders: {
      quoteExpiryWarningHours: boundedInt(
        orders.quoteExpiryWarningHours,
        d.orders.quoteExpiryWarningHours,
        AUTOMATION_BOUNDS.quoteExpiryWarningHours.min,
        AUTOMATION_BOUNDS.quoteExpiryWarningHours.max
      ),
      actionRequiredEnabled: bool(orders.actionRequiredEnabled, d.orders.actionRequiredEnabled),
      actionRequiredFirstDays: first,
      /**
       * The second nudge must land after the first.
       *
       * A form that lets somebody set 7 then 3 produces two reminders on the
       * same discovery pass, which reads to the customer as a double send. Rather
       * than reject the save — the operator's intent is obvious — the later value
       * is pushed past the earlier one.
       */
      actionRequiredSecondDays: second > first ? second : first + 1,
    },
    production: {
      dueSoonEnabled: bool(production.dueSoonEnabled, d.production.dueSoonEnabled),
      dueSoonDays: boundedInt(
        production.dueSoonDays,
        d.production.dueSoonDays,
        AUTOMATION_BOUNDS.dueSoonDays.min,
        AUTOMATION_BOUNDS.dueSoonDays.max
      ),
      overdueEnabled: bool(production.overdueEnabled, d.production.overdueEnabled),
      blockedEnabled: bool(production.blockedEnabled, d.production.blockedEnabled),
      blockedHours: boundedInt(
        production.blockedHours,
        d.production.blockedHours,
        AUTOMATION_BOUNDS.blockedHours.min,
        AUTOMATION_BOUNDS.blockedHours.max
      ),
    },
    fulfillment: {
      pickupRemindersEnabled: bool(
        fulfillment.pickupRemindersEnabled,
        d.fulfillment.pickupRemindersEnabled
      ),
      pickupReminderDays: parsePickupDays(fulfillment.pickupReminderDays),
      pickupStaleStaffEnabled: bool(
        fulfillment.pickupStaleStaffEnabled,
        d.fulfillment.pickupStaleStaffEnabled
      ),
      pickupStaleStaffDays: boundedInt(
        fulfillment.pickupStaleStaffDays,
        d.fulfillment.pickupStaleStaffDays,
        AUTOMATION_BOUNDS.pickupStaleStaffDays.min,
        AUTOMATION_BOUNDS.pickupStaleStaffDays.max
      ),
    },
    support: {
      waitingOnStaffEnabled: bool(support.waitingOnStaffEnabled, d.support.waitingOnStaffEnabled),
      waitingOnStaffHours: boundedInt(
        support.waitingOnStaffHours,
        d.support.waitingOnStaffHours,
        AUTOMATION_BOUNDS.waitingOnStaffHours.min,
        AUTOMATION_BOUNDS.waitingOnStaffHours.max
      ),
      waitingOnCustomerEnabled: bool(
        support.waitingOnCustomerEnabled,
        d.support.waitingOnCustomerEnabled
      ),
      waitingOnCustomerDays: boundedInt(
        support.waitingOnCustomerDays,
        d.support.waitingOnCustomerDays,
        AUTOMATION_BOUNDS.waitingOnCustomerDays.min,
        AUTOMATION_BOUNDS.waitingOnCustomerDays.max
      ),
    },
  };
}

/**
 * The pickup cadence: ascending, unique, bounded, and never empty.
 *
 * An empty list would mean "reminders are on but there are no days", which is a
 * state that looks enabled and does nothing. If everything an operator sent is
 * unusable the defaults come back; turning pickup reminders *off* is what the
 * switch beside it is for.
 */
function parsePickupDays(raw: unknown): number[] {
  const source = Array.isArray(raw) ? raw : [];
  const days = source
    .map((value) => (typeof value === "number" ? value : Number(value)))
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.trunc(value))
    .filter(
      (value) =>
        value >= AUTOMATION_BOUNDS.pickupReminderDays.min &&
        value <= AUTOMATION_BOUNDS.pickupReminderDays.max
    );

  const unique = [...new Set(days)].sort((a, b) => a - b).slice(0, MAX_PICKUP_REMINDER_DAYS);
  return unique.length ? unique : [...DEFAULT_AUTOMATION_SETTINGS.fulfillment.pickupReminderDays];
}

/**
 * Whether an optional job type is switched on.
 *
 * One function rather than a conditional at each call site, so the master
 * switch cannot be honoured by three of four discovery passes. The two
 * non-optional quote jobs are not represented here and are never asked about —
 * `AUTOMATION_JOBS[].optional` decides that, and the tests assert the two agree.
 */
export function isJobEnabled(settings: AutomationSettings, type: string): boolean {
  if (!settings.enabled) return false;
  switch (type) {
    case "quote_expiry_warning":
    case "quote_expired":
      return true;
    case "order_action_required":
      return settings.orders.actionRequiredEnabled;
    case "pickup_reminder":
      return settings.fulfillment.pickupRemindersEnabled;
    case "pickup_stale_staff":
      return settings.fulfillment.pickupStaleStaffEnabled;
    case "support_waiting_customer":
      return settings.support.waitingOnCustomerEnabled;
    case "support_waiting_staff":
      return settings.support.waitingOnStaffEnabled;
    case "production_due_soon":
      return settings.production.dueSoonEnabled;
    case "production_overdue":
      return settings.production.overdueEnabled;
    case "production_blocked":
      return settings.production.blockedEnabled;
    default:
      return false;
  }
}
