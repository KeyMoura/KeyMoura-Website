"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { Field, Notice } from "@/components/ui/DesignSystem";
import {
  Card,
  CheckField,
  EmptyState,
  Fact,
  Facts,
  FormGrid,
  LoadingState,
  PageHeader,
  PageTabs,
  Row,
  Rows,
  SaveBar,
  Section,
  StaffPage,
  StatusChip,
  TabPanel,
} from "@/components/staff/StaffPage";
import { useHashTab } from "@/lib/hooks/useHashTab";
import type { StaffTab } from "@/lib/staff/pageFramework";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import {
  AUTOMATION_BOUNDS,
  MAX_PICKUP_REMINDER_DAYS,
  type AutomationSettings,
} from "@/lib/automation/settings";
import { AUTOMATION_JOBS_BY_TYPE, AUTOMATION_STATE_LABELS } from "@/lib/automation/catalogue";
import type { AutomationHealth } from "@/lib/automation/health";

/**
 * Scheduled automation: what the shop reminds people about, and whether the
 * thing that does the reminding is alive.
 *
 * ## Why one page and not five
 *
 * Every timer in this system lives here. The alternative — a pickup threshold on
 * the fulfillment page, a support threshold on the support page, a due-date
 * warning in production settings — is how a shop ends up unable to answer "what
 * automatic messages do we send?" without opening five screens and knowing to
 * look. The reminders are one system with one worker and one failure mode, and
 * they are configured as one.
 *
 * Grouped by the area each affects, because that is how somebody arrives:
 * "customers are complaining about pickup nags" leads to Fulfillment, not to a
 * flat list of eleven numbers.
 *
 * ## What is deliberately absent
 *
 * No cron expression, and no way to type one. An operator configures "3 days".
 * The schedule that wakes the worker is deployment configuration and is shown on
 * Status as a fact, not as a field — it is not something this page can change,
 * and offering an input that silently did nothing would be worse than saying so.
 *
 * There is also no switch for the two quote reminders. They keep an active
 * purchase moving, and a customer must not be left to discover a lapsed quote on
 * their own because somebody turned a toggle off. Their *timing* is configurable;
 * their existence is not.
 */

type Payload = {
  settings: AutomationSettings;
  health: AutomationHealth;
  jobs: JobRow[];
  failures: JobRow[];
  intervalMinutes: number;
  canManage: boolean;
};

type JobRow = {
  id: string;
  job_type: string;
  entity_type: string;
  entity_id: string | null;
  run_at: string;
  state: string;
  attempt_count: number;
  last_attempt_at: string | null;
  failure_category: string | null;
  last_error: string | null;
  cancel_reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

const HEALTH_TONE: Record<AutomationHealth["status"], "success" | "warning" | "danger" | "neutral"> = {
  healthy: "success",
  degraded: "warning",
  stalled: "danger",
  never_run: "neutral",
};

const HEALTH_LABEL: Record<AutomationHealth["status"], string> = {
  healthy: "Running",
  degraded: "Running, with failures",
  stalled: "Not running",
  never_run: "Never run",
};

/** A local time a person can read, or a dash when there is nothing to show. */
function when(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString();
}

function NumberField({
  label,
  help,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  help?: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label} help={help}>
      <input
        type="number"
        className="ui-input w-full"
        inputMode="numeric"
        // Bounds come from `AUTOMATION_BOUNDS`, the same constants the parser
        // clamps with. A form that permits a value the server then silently
        // changes is a form that discards what somebody typed.
        min={min}
        max={max}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(Number(event.target.value) || 0)}
      />
    </Field>
  );
}

/** Written once, so the loading header and the loaded header cannot drift apart. */
const AUTOMATION_DESCRIPTION =
  "The reminders this shop sends on its own, when they go out, and whether the scheduler is running. Nothing takes effect until you press Save.";

export default function AutomationSettingsPage() {
  const { data: access, isLoading: accessLoading } = useMeAccess();
  const permissions = useMemo(() => new Set(access?.permissions ?? []), [access?.permissions]);
  const canView = permissions.has("automation.view") || permissions.has("automation.manage");
  const canManage = permissions.has("automation.manage");

  const [settings, setSettings] = useState<AutomationSettings | null>(null);
  const [health, setHealth] = useState<AutomationHealth | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [failures, setFailures] = useState<JobRow[]>([]);
  const [interval, setIntervalMinutes] = useState(15);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const tabs = useMemo<StaffTab[]>(
    () => [
      { id: "status", label: "Status" },
      { id: "orders", label: "Orders & quotes" },
      { id: "production", label: "Production" },
      { id: "fulfillment", label: "Fulfillment" },
      { id: "support", label: "Support" },
      { id: "jobs", label: "Jobs" },
    ],
    []
  );
  const [tab, setTab] = useHashTab(tabs);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/staff/automation", { credentials: "same-origin" });
      const payload = (await response.json()) as Payload & { error?: string };
      if (!response.ok) {
        setError(payload.error || "Could not load automation settings.");
        return;
      }
      setSettings(payload.settings);
      setHealth(payload.health);
      setJobs(payload.jobs ?? []);
      setFailures(payload.failures ?? []);
      setIntervalMinutes(payload.intervalMinutes ?? 15);
    } catch {
      setError("Could not load automation settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (accessLoading || !canView) return;
    void load();
  }, [accessLoading, canView, load]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const patch = useCallback((next: Partial<AutomationSettings>) => {
    setDirty(true);
    setSaved("");
    setSettings((current) => (current ? { ...current, ...next } : current));
  }, []);

  async function save() {
    if (!settings) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/staff/automation", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error ?? "Could not save.");
        return;
      }
      setSettings(payload.settings);
      setDirty(false);
      setSaved(
        payload.changedSections?.length
          ? `Saved: ${payload.changedSections.join(", ")}.`
          : "Saved. Nothing had changed."
      );
    } catch {
      setError("Could not save. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function act(jobId: string, action: "retry" | "cancel") {
    setBusyJob(jobId);
    setError("");
    try {
      const response = await fetch(`/api/staff/automation/jobs/${jobId}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error ?? "Could not update that job.");
        return;
      }
      await load();
    } catch {
      setError("Could not update that job.");
    } finally {
      setBusyJob(null);
    }
  }

  async function runNow() {
    setRunning(true);
    setError("");
    try {
      const response = await fetch("/api/staff/automation/run", {
        method: "POST",
        credentials: "same-origin",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error ?? "Could not run the scheduler.");
        return;
      }
      await load();
      setSaved(
        `Ran now: ${payload.summary.completed} completed, ${payload.summary.cancelled} no longer needed, ${payload.summary.failed} failed.`
      );
    } catch {
      setError("Could not run the scheduler.");
    } finally {
      setRunning(false);
    }
  }

  // Access first, then a titled loading state — see the note on the same split
  // in `settings/commerce`. The header must not be drawn before the check.
  if (accessLoading) return <LoadingState>Loading automation…</LoadingState>;
  if (!canView) {
    return <AccessDeniedCard message="You need the automation.view permission to see this page." />;
  }
  if (loading) {
    return (
      <StaffPage>
        <PageHeader title="Automation" description={AUTOMATION_DESCRIPTION} />
        <LoadingState>Loading automation…</LoadingState>
      </StaffPage>
    );
  }
  if (error && !settings) {
    return (
      <Notice tone="danger" role="alert">
        {error}
      </Notice>
    );
  }
  if (!settings || !health) return null;

  const disabled = !canManage || saving;

  function jobRow(job: JobRow) {
    const spec = AUTOMATION_JOBS_BY_TYPE[job.job_type as keyof typeof AUTOMATION_JOBS_BY_TYPE];
    const title = spec?.label ?? job.job_type;
    return (
      <Row
        key={job.id}
        title={title}
        detail={
          job.state === "failed"
            ? job.last_error || "It failed, with no further detail recorded."
            : job.state === "cancelled"
              ? job.cancel_reason || "No longer needed."
              : `Due ${when(job.run_at)}`
        }
        meta={
          <>
            {job.attempt_count > 0 ? `${job.attempt_count} attempt${job.attempt_count === 1 ? "" : "s"} · ` : ""}
            {job.failure_category ? `${job.failure_category.replace(/_/g, " ")} · ` : ""}
            {job.entity_id ? `${job.entity_type.replace(/_/g, " ")}` : "no entity"}
          </>
        }
        severity={job.state === "failed" ? "critical" : undefined}
        aside={
          <div className="flex items-center gap-2">
            <StatusChip
              value={job.state}
              label={AUTOMATION_STATE_LABELS[job.state as keyof typeof AUTOMATION_STATE_LABELS] ?? job.state}
            />
            {canManage && job.state === "failed" ? (
              <button
                type="button"
                className="ui-btn ui-btn-secondary text-sm disabled:opacity-50"
                disabled={busyJob === job.id}
                onClick={() => void act(job.id, "retry")}
              >
                {busyJob === job.id ? "…" : "Retry"}
              </button>
            ) : null}
            {canManage && (job.state === "pending" || job.state === "failed") ? (
              <button
                type="button"
                className="ui-btn ui-btn-secondary text-sm disabled:opacity-50"
                disabled={busyJob === job.id}
                onClick={() => void act(job.id, "cancel")}
              >
                Cancel
              </button>
            ) : null}
          </div>
        }
      />
    );
  }

  return (
    <StaffPage>
      <PageHeader title="Automation" description={AUTOMATION_DESCRIPTION} />

      {!canManage ? (
        <Notice tone="warning">
          You can read these settings but not change them. That needs the automation.manage permission.
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}

      <PageTabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="Automation sections" />

      {/* ---------------- Status ---------------- */}
      <TabPanel id="status" value={tab}>
        <Section
          title="Scheduler"
          description="Something outside this application wakes the worker on a schedule. This is what it has actually been doing."
        >
          <Card>
            <div className="mb-4 flex items-center gap-3">
              <StatusChip value={health.status} label={HEALTH_LABEL[health.status]} tone={HEALTH_TONE[health.status]} />
              {canManage ? (
                <button type="button" className="ui-btn ui-btn-secondary text-sm disabled:opacity-50" disabled={running} onClick={() => void runNow()}>
                  {running ? "Running…" : "Run now"}
                </button>
              ) : null}
            </div>

            {health.status === "never_run" ? (
              <Notice tone="warning">
                The scheduler has never run. Until it does, no reminder will be sent. If this shop was only just
                deployed, wait {interval} minutes and check again.
              </Notice>
            ) : null}
            {health.status === "stalled" ? (
              <Notice tone="danger" role="alert">
                The last run was more than two intervals ago. Reminders are not going out.
              </Notice>
            ) : null}
            {!settings.enabled ? (
              <Notice tone="warning">
                Automation is switched off below. The worker still runs and still tidies up, but no reminder will be
                scheduled or sent.
              </Notice>
            ) : null}

            <Facts>
              <Fact label="Last run">{when(health.lastRun?.started_at)}</Fact>
              <Fact label="Last successful run">{when(health.lastSuccessAt)}</Fact>
              <Fact label="Next expected">{when(health.nextExpectedAt)}</Fact>
              <Fact label="Runs every">{interval} minutes</Fact>
              <Fact label="Waiting">{health.counts.pending}</Fact>
              <Fact label="Due now">{health.dueNow}</Fact>
              <Fact label="Failed">{health.counts.failed}</Fact>
              <Fact label="Sent so far">{health.counts.completed}</Fact>
              <Fact label="No longer needed">{health.counts.cancelled}</Fact>
            </Facts>
          </Card>
        </Section>

        <Section
          title="Recent failures"
          description="A reminder that should have gone out and did not. These do not clear on their own."
        >
          {failures.length ? <Rows>{failures.map(jobRow)}</Rows> : <EmptyState>Nothing has failed.</EmptyState>}
        </Section>

        <Section title="Last few runs">
          {health.recentRuns.length ? (
            <Rows>
              {health.recentRuns.map((run) => (
                <Row
                  key={run.id}
                  title={when(run.started_at)}
                  detail={
                    run.error
                      ? run.error
                      : `${run.discovered} found · ${run.completed} sent · ${run.cancelled} no longer needed · ${run.failed} failed`
                  }
                  meta={`${run.trigger === "manual" ? "Run by hand" : "Scheduled"}${
                    run.duration_ms ? ` · ${(run.duration_ms / 1000).toFixed(1)}s` : ""
                  }`}
                  aside={<StatusChip value={run.outcome} />}
                  severity={run.outcome === "failed" ? "critical" : undefined}
                />
              ))}
            </Rows>
          ) : (
            <EmptyState>No runs recorded yet.</EmptyState>
          )}
        </Section>

        <Section title="Everything on or off">
          <Card>
            <CheckField
              label="Send scheduled reminders"
              help="Off stops every reminder being scheduled or sent. The worker keeps running and keeps tidying up expired stock holds, so this page will still show it is alive."
              checked={settings.enabled}
              disabled={disabled}
              onChange={(value) => patch({ enabled: value })}
            />
          </Card>
        </Section>
      </TabPanel>

      {/* ---------------- Orders ---------------- */}
      <TabPanel id="orders" value={tab}>
        <Section
          title="Quote expiry"
          description="A customer with a live quote is told before it runs out, and again once it has. These cannot be turned off — a quote lapsing without warning is a purchase somebody was in the middle of."
        >
          <Card>
            <FormGrid>
              <NumberField
                label="Warn this many hours before it expires"
                help="24 means the warning goes out a day before the deadline."
                value={settings.orders.quoteExpiryWarningHours}
                min={AUTOMATION_BOUNDS.quoteExpiryWarningHours.min}
                max={AUTOMATION_BOUNDS.quoteExpiryWarningHours.max}
                disabled={disabled}
                onChange={(value) =>
                  patch({ orders: { ...settings.orders, quoteExpiryWarningHours: value } })
                }
              />
            </FormGrid>
          </Card>
        </Section>

        <Section
          title="Waiting on the customer"
          description="Follows up when an order needs information, needs paying, or is waiting to be approved. Two reminders at most, then it stops."
        >
          <Card>
            <CheckField
              label="Follow up on orders waiting for the customer"
              checked={settings.orders.actionRequiredEnabled}
              disabled={disabled}
              onChange={(value) => patch({ orders: { ...settings.orders, actionRequiredEnabled: value } })}
            />
            <div className="mt-4">
              <FormGrid>
                <NumberField
                  label="First reminder after (days)"
                  value={settings.orders.actionRequiredFirstDays}
                  min={AUTOMATION_BOUNDS.actionRequiredDays.min}
                  max={AUTOMATION_BOUNDS.actionRequiredDays.max}
                  disabled={disabled || !settings.orders.actionRequiredEnabled}
                  onChange={(value) => patch({ orders: { ...settings.orders, actionRequiredFirstDays: value } })}
                />
                <NumberField
                  label="Second and final reminder after (days)"
                  help="Must be later than the first. A smaller value is pushed past it when saved."
                  value={settings.orders.actionRequiredSecondDays}
                  min={AUTOMATION_BOUNDS.actionRequiredDays.min}
                  max={AUTOMATION_BOUNDS.actionRequiredDays.max}
                  disabled={disabled || !settings.orders.actionRequiredEnabled}
                  onChange={(value) => patch({ orders: { ...settings.orders, actionRequiredSecondDays: value } })}
                />
              </FormGrid>
            </div>
          </Card>
        </Section>
      </TabPanel>

      {/* ---------------- Production ---------------- */}
      <TabPanel id="production" value={tab}>
        <Section
          title="Due dates"
          description="Alerts the workshop, in the bell. No customer is told a job is running late — that is a decision somebody makes, not one this page makes for them."
        >
          <Card>
            <CheckField
              label="Warn before a job is due"
              checked={settings.production.dueSoonEnabled}
              disabled={disabled}
              onChange={(value) => patch({ production: { ...settings.production, dueSoonEnabled: value } })}
            />
            <div className="mt-4">
              <FormGrid>
                <NumberField
                  label="Warn this many days ahead"
                  value={settings.production.dueSoonDays}
                  min={AUTOMATION_BOUNDS.dueSoonDays.min}
                  max={AUTOMATION_BOUNDS.dueSoonDays.max}
                  disabled={disabled || !settings.production.dueSoonEnabled}
                  onChange={(value) => patch({ production: { ...settings.production, dueSoonDays: value } })}
                />
              </FormGrid>
            </div>
            <div className="mt-4">
              <CheckField
                label="Alert when a job passes its due date"
                checked={settings.production.overdueEnabled}
                disabled={disabled}
                onChange={(value) => patch({ production: { ...settings.production, overdueEnabled: value } })}
              />
            </div>
          </Card>
        </Section>

        <Section
          title="Blocked work"
          description="Jobs waiting on a customer, waiting on materials, or deliberately on hold."
        >
          <Card>
            <CheckField
              label="Alert when a job has been blocked too long"
              checked={settings.production.blockedEnabled}
              disabled={disabled}
              onChange={(value) => patch({ production: { ...settings.production, blockedEnabled: value } })}
            />
            <div className="mt-4">
              <FormGrid>
                <NumberField
                  label="Blocked for this many hours"
                  help="48 means two days of no movement before anybody is told."
                  value={settings.production.blockedHours}
                  min={AUTOMATION_BOUNDS.blockedHours.min}
                  max={AUTOMATION_BOUNDS.blockedHours.max}
                  disabled={disabled || !settings.production.blockedEnabled}
                  onChange={(value) => patch({ production: { ...settings.production, blockedHours: value } })}
                />
              </FormGrid>
            </div>
          </Card>
        </Section>
      </TabPanel>

      {/* ---------------- Fulfillment ---------------- */}
      <TabPanel id="fulfillment" value={tab}>
        <Section
          title="Uncollected pickups"
          description="Only collection. Nothing chases a customer about a parcel that is already with a carrier — the tracking updates already sent are the authority on that."
        >
          <Card>
            <CheckField
              label="Remind customers their order is waiting to be collected"
              checked={settings.fulfillment.pickupRemindersEnabled}
              disabled={disabled}
              onChange={(value) =>
                patch({ fulfillment: { ...settings.fulfillment, pickupRemindersEnabled: value } })
              }
            />
            <div className="mt-4">
              <FormGrid>
                {Array.from({ length: MAX_PICKUP_REMINDER_DAYS }).map((_, index) => (
                  <NumberField
                    key={index}
                    label={`Reminder ${index + 1} after (days)`}
                    help={index === 0 ? "Counted from when the order was marked ready." : "Leave at 0 for none."}
                    value={settings.fulfillment.pickupReminderDays[index] ?? 0}
                    min={0}
                    max={AUTOMATION_BOUNDS.pickupReminderDays.max}
                    disabled={disabled || !settings.fulfillment.pickupRemindersEnabled}
                    onChange={(value) => {
                      // Zero removes a slot. The parser sorts, dedupes and drops
                      // anything out of range, so a jumbled set of boxes still
                      // saves as a sensible ascending cadence.
                      const days = [...settings.fulfillment.pickupReminderDays];
                      days[index] = value;
                      patch({
                        fulfillment: {
                          ...settings.fulfillment,
                          pickupReminderDays: days.filter((day) => day > 0),
                        },
                      });
                    }}
                  />
                ))}
              </FormGrid>
            </div>
          </Card>
        </Section>

        <Section title="Telling staff" description="An alert in the bell when something has sat on the shelf too long.">
          <Card>
            <CheckField
              label="Flag orders that have been ready a long time"
              checked={settings.fulfillment.pickupStaleStaffEnabled}
              disabled={disabled}
              onChange={(value) =>
                patch({ fulfillment: { ...settings.fulfillment, pickupStaleStaffEnabled: value } })
              }
            />
            <div className="mt-4">
              <FormGrid>
                <NumberField
                  label="Flag after (days)"
                  value={settings.fulfillment.pickupStaleStaffDays}
                  min={AUTOMATION_BOUNDS.pickupStaleStaffDays.min}
                  max={AUTOMATION_BOUNDS.pickupStaleStaffDays.max}
                  disabled={disabled || !settings.fulfillment.pickupStaleStaffEnabled}
                  onChange={(value) =>
                    patch({ fulfillment: { ...settings.fulfillment, pickupStaleStaffDays: value } })
                  }
                />
              </FormGrid>
            </div>
          </Card>
        </Section>
      </TabPanel>

      {/* ---------------- Support ---------------- */}
      <TabPanel id="support" value={tab}>
        <Section
          title="Waiting on us"
          description="An alert to everybody who can read support when a customer has been left waiting. Sent to the bell, not by email."
        >
          <Card>
            <CheckField
              label="Alert staff when a customer is waiting for a reply"
              checked={settings.support.waitingOnStaffEnabled}
              disabled={disabled}
              onChange={(value) => patch({ support: { ...settings.support, waitingOnStaffEnabled: value } })}
            />
            <div className="mt-4">
              <FormGrid>
                <NumberField
                  label="Alert after (hours)"
                  help="Measured from the customer's last message, so a new message restarts the clock."
                  value={settings.support.waitingOnStaffHours}
                  min={AUTOMATION_BOUNDS.waitingOnStaffHours.min}
                  max={AUTOMATION_BOUNDS.waitingOnStaffHours.max}
                  disabled={disabled || !settings.support.waitingOnStaffEnabled}
                  onChange={(value) => patch({ support: { ...settings.support, waitingOnStaffHours: value } })}
                />
              </FormGrid>
            </div>
          </Card>
        </Section>

        <Section
          title="Waiting on them"
          description="One email, and only one. A conversation the customer has stopped replying to gets a single nudge, never a series."
        >
          <Card>
            <CheckField
              label="Remind a customer when we are waiting on their reply"
              checked={settings.support.waitingOnCustomerEnabled}
              disabled={disabled}
              onChange={(value) => patch({ support: { ...settings.support, waitingOnCustomerEnabled: value } })}
            />
            <div className="mt-4">
              <FormGrid>
                <NumberField
                  label="Remind after (days)"
                  value={settings.support.waitingOnCustomerDays}
                  min={AUTOMATION_BOUNDS.waitingOnCustomerDays.min}
                  max={AUTOMATION_BOUNDS.waitingOnCustomerDays.max}
                  disabled={disabled || !settings.support.waitingOnCustomerEnabled}
                  onChange={(value) => patch({ support: { ...settings.support, waitingOnCustomerDays: value } })}
                />
              </FormGrid>
            </div>
          </Card>
        </Section>
      </TabPanel>

      {/* ---------------- Jobs ---------------- */}
      <TabPanel id="jobs" value={tab}>
        <Section
          title="Queued and recent"
          description="What the scheduler is about to do, and what it has done. A job that says “no longer needed” was cancelled because the thing it was about got resolved — that is the system working, not a fault."
        >
          {jobs.length ? <Rows>{jobs.map(jobRow)}</Rows> : <EmptyState>Nothing scheduled.</EmptyState>}
        </Section>
      </TabPanel>

      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} disabled={!canManage} message={saved} />
    </StaffPage>
  );
}
