/**
 * How often the worker wakes, stated once.
 *
 * Pure and dependency-free so the health page, the tests and the documentation
 * all read the same number, and so the cron schedule in deployment configuration
 * has exactly one thing to agree with.
 *
 * ## Why fifteen minutes
 *
 * The finest-grained threshold anything in this system uses is hours — support
 * waiting on staff, at a default of eight. Nothing needs minute-level precision,
 * and nothing would be improved by it: a reminder that a customer has not
 * replied for two days does not become more useful for arriving at 14:00 rather
 * than 14:12.
 *
 * So the cadence is set by the *other* consideration — how late a
 * deterministically-scheduled job may fire. A quote expiring at 14:00 has its
 * warning written for 14:00 the previous day, and at this cadence it goes out
 * within fifteen minutes of that. An hourly schedule would make it up to an hour
 * late, which starts to matter for the one reminder whose whole point is that it
 * arrives before a deadline.
 *
 * Against that: 96 invocations a day, ~2,900 a month, each of which is a
 * database round trip and usually nothing else. That is a rounding error on any
 * paid plan, and the discovery queries are all bounded and indexed.
 *
 * ## Why one schedule and not one per reminder
 *
 * Ten cron entries would be ten things to configure, ten things to get wrong,
 * and ten places to look when a reminder does not arrive. One worker reads the
 * job table and does whatever is due, which is the same reason the job table
 * exists at all. The platform also caps how many cron entries a project may
 * have, and spending them on something one loop does is a poor trade.
 */

/** The interval the deployment's cron schedule must match. */
export const SCHEDULER_INTERVAL_MINUTES = 15;

/**
 * The cron expression for that interval.
 *
 * Derived from the interval rather than written twice, so the number the health
 * page shows and the schedule that actually fires cannot disagree in this file.
 *
 * What this does **not** do is verify the deployment. The platform schedule
 * lives in configuration outside the repository, and nothing here can read it —
 * which is exactly why `loadAutomationHealth` reports staleness from observed
 * runs rather than from this constant. If the two ever disagree, the health page
 * says the scheduler is stalled, which is the true statement.
 *
 * Note the deliberate absence of a timezone: platform cron runs on UTC, every
 * threshold in this system is a duration applied to UTC instants, and a schedule
 * pinned to a local zone would shift twice a year for no reason.
 */
export const SCHEDULER_CRON_EXPRESSION = `*/${SCHEDULER_INTERVAL_MINUTES} * * * *`;

/** The path the schedule must call. */
export const SCHEDULER_PATH = "/api/cron/automation";
