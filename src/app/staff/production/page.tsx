"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { Field, Notice } from "@/components/ui/DesignSystem";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Section,
  StaffPage,
} from "@/components/staff/StaffPage";
import { DueDate, PriorityBadge, StatusBadge } from "@/components/staff/production/JobBadges";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import {
  PRODUCTION_PRIORITIES,
  PRODUCTION_STATUSES,
  PRIORITY_META,
  STATUS_META,
  bucketJobs,
  isProductionPriority,
  isProductionStatus,
  type ProductionStatus,
} from "@/lib/production/jobs";

/**
 * The production queue — a manufacturing worklist, not a second order list.
 *
 * ## What this pass changed
 *
 * Two things made this read as "orders again in a different colour". First, the
 * rows carried a job number, a title, two badges and a due date, and the source
 * order appeared only as a bare order number in a trailing slot — so the page
 * looked like an order list whose rows had lost their customer. Second, the
 * page wrapped itself in `page-container`, *inside* the shell's own
 * `page-container-wide`, so it was measurably narrower than every other staff
 * page and its filter panel sat at a different gutter.
 *
 * Now each row says what a shop needs before starting work: **what to make, how
 * many, for which order, by when, what stage it is at, and what is blocking
 * it**. The blocker is stated in words on the row rather than implied by an
 * amber badge — `waiting_on_materials` and `on_hold` both showed as an amber
 * chip, and only one of them means "go and order something".
 *
 * Filters live in the URL rather than in component state so that a dashboard
 * card can link to an exact view — "3 jobs overdue" goes to the list of those
 * three, not to the queue with a filter the operator has to reapply.
 */

type JobRecord = {
  id: string;
  job_number: string;
  title: string;
  status: ProductionStatus;
  priority: "low" | "normal" | "high" | "urgent";
  due_date: string | null;
  promised_date?: string | null;
  created_at?: string;
  quantity: number | null;
  hold_reason: string | null;
  failure_reason: string | null;
  assigned_to: string | null;
  customer_id: string | null;
  order_id: string | null;
  product_id: string | null;
  updated_at: string;
};

type Payload = {
  jobs: JobRecord[];
  people: Record<string, string>;
  orders: Record<string, { order_number: string | null }>;
  products: Record<string, { name: string }>;
  taskProgress: Record<string, { done: number; total: number; qcOpen: number }>;
  total: number;
  limit: number;
  offset: number;
  canManage: boolean;
  currentUserId: string;
};

/**
 * What is stopping this job, in words.
 *
 * `STATUS_META[...].blocked` already knows which states mean "the shop is
 * waiting on somebody"; the reason columns say who. A job that is not blocked
 * returns null and the row shows nothing rather than an empty label.
 */
function blockerText(job: JobRecord): string | null {
  if (job.failure_reason) return `Rework: ${job.failure_reason}`;
  if (job.hold_reason) return `On hold: ${job.hold_reason}`;
  if (!STATUS_META[job.status]?.blocked) return null;
  return STATUS_META[job.status].description;
}

function QueueContent() {
  const router = useRouter();
  const params = useSearchParams();
  const { data: access, isLoading: accessLoading } = useMeAccess();

  const permissions = useMemo(() => new Set(access?.permissions ?? []), [access]);
  const canView = permissions.has("production.view") || permissions.has("production.manage");
  const canManage = permissions.has("production.manage");

  const scope = params.get("scope") ?? "open";
  const status = params.get("status");
  const priority = params.get("priority");
  const assignedTo = params.get("assignedTo");
  const attention = params.get("attention");
  const overdue = params.get("overdue") === "true";
  const search = params.get("q") ?? "";
  const view = params.get("view") === "list" ? "list" : "board";

  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchDraft, setSearchDraft] = useState(search);
  const [filtersOpen, setFiltersOpen] = useState(
    () => Boolean(status) || Boolean(priority) || Boolean(assignedTo)
  );

  // Tracked separately from `error` because a refusal is not a failure. The
  // permission check below and the route's own check can disagree — a
  // permission revoked mid-session, or a stale access payload — and when they
  // do, staff must be told what they lack rather than shown a red "could not
  // load" box with a Try again button that will never succeed.
  const [denied, setDenied] = useState(false);

  // `now` is captured once per mount. Reading `new Date()` inside the render
  // would make "due today" recompute on every keystroke and could flip a badge
  // mid-session at midnight; more importantly it would differ between the
  // server and the first client render.
  const [now] = useState(() => new Date());

  // The previous payload is held while a refetch is in flight so the counts on
  // screen never blink to zero and back. A filter change should look like a
  // filter change, not like the queue emptying.
  const lastGood = useRef<Payload | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setDenied(false);
    try {
      const query = new URLSearchParams();
      if (scope) query.set("scope", scope);
      if (status) query.set("status", status);
      if (priority) query.set("priority", priority);
      if (assignedTo) query.set("assignedTo", assignedTo);
      if (attention) query.set("attention", attention);
      if (overdue) query.set("overdue", "true");
      if (search) query.set("q", search);
      // The shop's own day, so an overdue filter matches what the badges say.
      query.set("today", `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`);

      const response = await fetch(`/api/staff/production/jobs?${query}`, { credentials: "same-origin" });
      const body = await response.json().catch(() => null);

      if (response.status === 403) {
        setDenied(true);
        return;
      }
      if (!response.ok) throw new Error(body?.error || "Could not load the production queue.");

      lastGood.current = body as Payload;
      setPayload(body as Payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the production queue.");
    } finally {
      setLoading(false);
    }
  }, [scope, status, priority, assignedTo, attention, overdue, search, now]);

  useEffect(() => {
    if (canView) void load();
  }, [canView, load]);

  useEffect(() => setSearchDraft(search), [search]);

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      router.replace(`/staff/production${next.toString() ? `?${next}` : ""}`, { scroll: false });
    },
    [params, router]
  );

  const shown = payload ?? lastGood.current;
  // Memoized rather than written inline: `shown?.jobs ?? []` builds a fresh
  // array on every render, which would make the bucketing below recompute on
  // every keystroke in the search box.
  const jobs = useMemo(() => shown?.jobs ?? [], [shown]);
  const buckets = useMemo(() => bucketJobs(jobs, now), [jobs, now]);

  if (accessLoading) return <LoadingState>Checking your access…</LoadingState>;

  if (!canView || denied) {
    return (
      <AccessDeniedCard
        title="Production is restricted"
        message="You need the production.view permission to see the job queue. Ask an administrator to grant it to your role."
      />
    );
  }

  const activeFilters =
    Boolean(status) || Boolean(priority) || Boolean(assignedTo) || Boolean(attention) || overdue || Boolean(search) || scope !== "open";
  const panelFilterCount = [status, priority, assignedTo, attention].filter(Boolean).length;

  const groups: Array<{ key: string; heading: string; hint: string; jobs: JobRecord[] }> = [
    { key: "overdue", heading: "Overdue", hint: "Past the due date and still live.", jobs: buckets.overdue as JobRecord[] },
    { key: "blocked", heading: "Blocked", hint: "Waiting on a customer, on materials, or held.", jobs: buckets.blocked as JobRecord[] },
    { key: "active", heading: "Active", hint: "Moving through the shop.", jobs: buckets.active as JobRecord[] },
    { key: "finished", heading: "Finished", hint: "Completed or cancelled.", jobs: buckets.finished as JobRecord[] },
  ];

  return (
    <StaffPage>
      <PageHeader
        title="Production"
        description="Work in the shop, ordered by what is late and what is urgent. Each job says what to make, for which order, and what is holding it up."
        actions={
          canManage ? (
            <Link href="/staff/production/new" className="ui-btn ui-btn-primary text-sm">
              New job
            </Link>
          ) : null
        }
      />

      {/* The three scopes staff actually switch between, then everything else
          behind Filters — the same toolbar shape the order queue uses. */}
      <nav aria-label="Production queues" className="staff-views">
        {(["open", "all", "finished"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setParam("scope", option === "open" ? null : option)}
            aria-pressed={scope === option}
            className="staff-view"
          >
            {option === "open" ? "Open" : option === "all" ? "All" : "Finished"}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setParam("overdue", overdue ? null : "true")}
          aria-pressed={overdue}
          className="staff-view"
        >
          Overdue only
        </button>
      </nav>

      <nav aria-label="Production layout" className="staff-views">
        <button type="button" className="staff-view" aria-pressed={view === "board"} onClick={() => setParam("view", null)}>
          Board
        </button>
        <button type="button" className="staff-view" aria-pressed={view === "list"} onClick={() => setParam("view", "list")}>
          List
        </button>
      </nav>

      <form
        className="staff-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          setParam("q", searchDraft.trim() || null);
        }}
      >
        <label className="staff-toolbar-search">
          <span className="sr-only">Search production jobs</span>
          <input
            type="search"
            className="ui-input w-full"
            placeholder="Job number or title…"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
          />
        </label>
        <button type="submit" className="ui-btn ui-btn-secondary text-sm">
          Search
        </button>
        <button
          type="button"
          onClick={() => setFiltersOpen((open) => !open)}
          aria-expanded={filtersOpen}
          aria-controls="staff-production-filters"
          className="ui-btn ui-btn-ghost text-sm"
        >
          Filters
          {panelFilterCount ? <span className="ml-1.5 tabular-nums">({panelFilterCount})</span> : null}
        </button>
        {activeFilters ? (
          <Link href="/staff/production" className="ui-btn ui-btn-ghost text-sm">
            Clear filters
          </Link>
        ) : null}
      </form>

      {filtersOpen ? (
        <div id="staff-production-filters" className="staff-filter-panel">
          <Field label="Stage">
            <select
              className="ui-input w-full"
              value={isProductionStatus(status) ? status : ""}
              onChange={(event) => setParam("status", event.target.value || null)}
            >
              <option value="">Any stage</option>
              {PRODUCTION_STATUSES.map((option) => (
                <option key={option} value={option}>
                  {STATUS_META[option].label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select
              className="ui-input w-full"
              value={isProductionPriority(priority) ? priority : ""}
              onChange={(event) => setParam("priority", event.target.value || null)}
            >
              <option value="">Any priority</option>
              {PRODUCTION_PRIORITIES.map((option) => (
                <option key={option} value={option}>
                  {PRIORITY_META[option].label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Assigned to">
            <select
              className="ui-input w-full"
              value={assignedTo ?? ""}
              onChange={(event) => setParam("assignedTo", event.target.value || null)}
            >
              <option value="">Anyone</option>
              <option value={shown?.currentUserId ?? ""}>Assigned to me</option>
              <option value="unassigned">Unassigned</option>
              {Object.entries(shown?.people ?? {}).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Attention">
            <select className="ui-input w-full" value={attention ?? ""} onChange={(event) => setParam("attention", event.target.value || null)}>
              <option value="">Any state</option>
              <option value="blocked">Blocked</option>
              <option value="qc">QC needed</option>
            </select>
          </Field>
        </div>
      ) : null}

      {error ? <ErrorState onRetry={() => void load()}>{error}</ErrorState> : null}

      {loading && !shown ? <LoadingState>Loading the production queue…</LoadingState> : null}

      {shown ? (
        <>
          <p className="text-xs text-brand-textMuted" aria-live="polite">
            {shown.total} job{shown.total === 1 ? "" : "s"}
            {shown.total > jobs.length ? ` (showing ${jobs.length})` : ""}
            {loading ? " · refreshing…" : ""}
          </p>

          {!jobs.length ? (
            <EmptyState>
              <p className="font-medium">
                {activeFilters ? "No jobs match these filters." : "No production jobs yet."}
              </p>
              <p className="mt-1">
                {activeFilters
                  ? "Clear the filters to see the whole queue."
                  : "Raise a job from an order, or create one directly for stock work."}
              </p>
            </EmptyState>
          ) : view === "list" ? (
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full min-w-[940px] text-left text-sm">
                <thead className="bg-white/5 text-xs uppercase tracking-wide text-brand-textMuted">
                  <tr>
                    {["Job", "Order", "Item", "Status", "Priority", "Assignee", "Machine", "Due", "Progress", "Updated"].map((heading) => (
                      <th key={heading} className="px-3 py-2 font-medium">{heading}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {jobs.map((job) => {
                    const progress = shown.taskProgress[job.id] ?? { done: 0, total: 0, qcOpen: 0 };
                    return (
                      <tr key={job.id} className="hover:bg-white/[.03]">
                        <td className="px-3 py-3"><Link className="font-mono text-brand-accent hover:underline" href={`/staff/production/${job.id}`}>{job.job_number}</Link></td>
                        <td className="px-3 py-3">{job.order_id ? shown.orders[job.order_id]?.order_number ?? '—' : 'Stock'}</td>
                        <td className="max-w-64 truncate px-3 py-3" title={job.title}>{shown.products[job.product_id ?? '']?.name ?? job.title}</td>
                        <td className="px-3 py-3"><StatusBadge status={job.status} /></td>
                        <td className="px-3 py-3"><PriorityBadge priority={job.priority} /></td>
                        <td className="px-3 py-3">{job.assigned_to ? shown.people[job.assigned_to] ?? 'Unknown' : 'Unassigned'}</td>
                        <td className="px-3 py-3 text-brand-textMuted">Not assigned</td>
                        <td className="px-3 py-3"><DueDate job={job} now={now} /></td>
                        <td className="px-3 py-3 tabular-nums">{progress.done} / {progress.total}{progress.qcOpen ? <span className="ml-1 text-amber-200">· QC</span> : null}</td>
                        <td className="px-3 py-3 whitespace-nowrap text-brand-textMuted">{new Date(job.updated_at).toLocaleDateString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            groups.map((group) =>
              group.jobs.length ? (
                <Section
                  key={group.key}
                  title={`${group.heading} (${group.jobs.length})`}
                  description={group.hint}
                >
                  <div className="staff-rows">
                    {group.jobs.map((job) => {
                      const blocker = blockerText(job);
                      const order = job.order_id ? shown.orders[job.order_id] : null;
                      return (
                        <Link key={job.id} href={`/staff/production/${job.id}`} className="staff-row">
                          <div className="staff-row-main">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-xs text-brand-textMuted">{job.job_number}</span>
                              <span className="staff-row-title">{job.title}</span>
                              {job.quantity && job.quantity > 1 ? (
                                <span className="staff-row-meta">× {job.quantity}</span>
                              ) : null}
                            </div>
                            {/* The source order, stated as a fact rather than
                                hidden in a trailing slot. "No source order" is
                                a real and common answer for stock work, and it
                                is said out loud so an unlinked job is not
                                mistaken for one whose link failed to load. */}
                            <div className="staff-row-detail">
                              {order ? (
                                <span className="text-brand-accent">
                                  Order {order.order_number ?? "—"}
                                </span>
                              ) : (
                                <span>No source order</span>
                              )}
                              {job.assigned_to && shown.people[job.assigned_to]
                                ? ` · ${shown.people[job.assigned_to]}`
                                : " · Unassigned"}
                            </div>
                            {blocker ? <div className="staff-row-meta mt-1 text-amber-200">{blocker}</div> : null}
                            {job.customer_id && shown.people[job.customer_id] ? (
                              <div className="staff-row-meta mt-1">Customer: {shown.people[job.customer_id]}</div>
                            ) : null}
                          </div>
                          <div className="staff-row-aside flex-col !items-start gap-1 sm:!items-end">
                            <span className="flex flex-wrap gap-1.5">
                              <StatusBadge status={job.status} />
                              <PriorityBadge priority={job.priority} />
                            </span>
                            <span className="text-xs">
                              <DueDate job={job} now={now} />
                            </span>
                            <span className="text-xs tabular-nums text-brand-textMuted">
                              {(shown.taskProgress[job.id]?.done ?? 0)} / {(shown.taskProgress[job.id]?.total ?? 0)} tasks
                              {(shown.taskProgress[job.id]?.qcOpen ?? 0) > 0 ? " · QC waiting" : ""}
                            </span>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                </Section>
              ) : null
            )
          )}
        </>
      ) : null}

      {shown && !shown.canManage ? (
        <Notice tone="info">
          You can read the queue but not change a job. That needs the production.manage permission.
        </Notice>
      ) : null}
    </StaffPage>
  );
}

export default function StaffProductionQueuePage() {
  // useSearchParams needs a Suspense boundary; without one the whole route
  // opts into client-side rendering at build time.
  return (
    <Suspense fallback={<LoadingState>Loading the production queue…</LoadingState>}>
      <QueueContent />
    </Suspense>
  );
}
