"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { EmptyState, Notice, Panel } from "@/components/ui/DesignSystem";
import { JobRowLink, type JobSummary } from "@/components/staff/production/JobBadges";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import {
  PRODUCTION_PRIORITIES,
  PRODUCTION_STATUSES,
  PRIORITY_META,
  STATUS_META,
  bucketJobs,
  isProductionPriority,
  isProductionStatus,
} from "@/lib/production/jobs";

/**
 * The production queue.
 *
 * Filters live in the URL rather than in component state so that every card on
 * the dashboard can link to an exact view — "3 jobs overdue" goes to the list
 * of those three, not to the queue with a filter the operator has to reapply.
 * It also makes a view bookmarkable and shareable between staff.
 */

const primary = "ui-btn ui-btn-primary disabled:opacity-50";
const subtle = "ui-btn ui-btn-ghost text-sm disabled:opacity-50";

type JobRecord = JobSummary & {
  assigned_to: string | null;
  order_id: string | null;
  product_id: string | null;
  updated_at: string;
};

type Payload = {
  jobs: JobRecord[];
  people: Record<string, string>;
  orders: Record<string, { order_number: string | null }>;
  products: Record<string, { name: string }>;
  total: number;
  limit: number;
  offset: number;
  canManage: boolean;
};

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
  const overdue = params.get("overdue") === "true";
  const search = params.get("q") ?? "";

  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchDraft, setSearchDraft] = useState(search);

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
    try {
      const query = new URLSearchParams();
      if (scope) query.set("scope", scope);
      if (status) query.set("status", status);
      if (priority) query.set("priority", priority);
      if (assignedTo) query.set("assignedTo", assignedTo);
      if (overdue) query.set("overdue", "true");
      if (search) query.set("q", search);
      // The shop's own day, so an overdue filter matches what the badges say.
      query.set("today", `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`);

      const response = await fetch(`/api/staff/production/jobs?${query}`, { credentials: "same-origin" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || "Could not load the production queue.");

      lastGood.current = body as Payload;
      setPayload(body as Payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the production queue.");
    } finally {
      setLoading(false);
    }
  }, [scope, status, priority, assignedTo, overdue, search, now]);

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

  if (accessLoading) {
    return (
      <div className="page-container">
        <p className="text-sm text-brand-textMuted" role="status">
          Checking your access…
        </p>
      </div>
    );
  }

  if (!canView) {
    return (
      <AccessDeniedCard
        title="Production is restricted"
        message="You need the production access permission to see the job queue."
      />
    );
  }

  const activeFilters =
    Boolean(status) || Boolean(priority) || Boolean(assignedTo) || overdue || Boolean(search) || scope !== "open";

  const groups: Array<{ key: string; heading: string; hint: string; jobs: JobRecord[] }> = [
    { key: "overdue", heading: "Overdue", hint: "Past the due date and still live.", jobs: buckets.overdue as JobRecord[] },
    { key: "blocked", heading: "Blocked", hint: "Waiting on a customer, on materials, or held.", jobs: buckets.blocked as JobRecord[] },
    { key: "active", heading: "Active", hint: "Moving through the shop.", jobs: buckets.active as JobRecord[] },
    { key: "finished", heading: "Finished", hint: "Completed or cancelled.", jobs: buckets.finished as JobRecord[] },
  ];

  return (
    <div className="page-container space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Production</h1>
          <p className="mt-1 text-sm text-brand-textMuted">
            Work in the shop, ordered by what is late and what is urgent.
          </p>
        </div>
        {canManage ? (
          <Link href="/staff/production/new" className={primary}>
            New job
          </Link>
        ) : null}
      </header>

      <Panel aria-label="Filters" className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {(["open", "all", "finished"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setParam("scope", option === "open" ? null : option)}
              aria-pressed={scope === option}
              className={scope === option ? "ui-btn ui-btn-primary text-sm" : subtle}
            >
              {option === "open" ? "Open" : option === "all" ? "All" : "Finished"}
            </button>
          ))}

          <button
            type="button"
            onClick={() => setParam("overdue", overdue ? null : "true")}
            aria-pressed={overdue}
            className={overdue ? "ui-btn ui-btn-primary text-sm" : subtle}
          >
            Overdue only
          </button>

          {activeFilters ? (
            <Link href="/staff/production" className={subtle}>
              Clear filters
            </Link>
          ) : null}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium">Status</span>
            <select
              className="ui-input min-h-10 text-sm"
              value={isProductionStatus(status) ? status : ""}
              onChange={(event) => setParam("status", event.target.value || null)}
            >
              <option value="">Any status</option>
              {PRODUCTION_STATUSES.map((option) => (
                <option key={option} value={option}>
                  {STATUS_META[option].label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium">Priority</span>
            <select
              className="ui-input min-h-10 text-sm"
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
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium">Assigned</span>
            <select
              className="ui-input min-h-10 text-sm"
              value={assignedTo ?? ""}
              onChange={(event) => setParam("assignedTo", event.target.value || null)}
            >
              <option value="">Anyone</option>
              <option value="unassigned">Unassigned</option>
              {Object.entries(shown?.people ?? {}).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setParam("q", searchDraft.trim() || null);
            }}
          >
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium">Search</span>
              <input
                type="search"
                className="ui-input min-h-10 text-sm"
                placeholder="Job number or title"
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
              />
            </label>
            <button type="submit" className={subtle}>
              Search
            </button>
          </form>
        </div>
      </Panel>

      {error ? (
        <Notice tone="danger" role="alert">
          <p>{error}</p>
          <button type="button" className={`${subtle} mt-2`} onClick={() => void load()}>
            Try again
          </button>
        </Notice>
      ) : null}

      {loading && !shown ? (
        <p className="text-sm text-brand-textMuted" role="status">
          Loading the production queue…
        </p>
      ) : null}

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
              <p className="mt-1 text-sm text-brand-textMuted">
                {activeFilters
                  ? "Clear the filters to see the whole queue."
                  : "Raise a job from an order, or create one directly for stock work."}
              </p>
            </EmptyState>
          ) : (
            <div className="space-y-6">
              {groups.map((group) =>
                group.jobs.length ? (
                  <section key={group.key} aria-labelledby={`queue-${group.key}`}>
                    <div className="mb-2 flex items-baseline gap-2">
                      <h2 id={`queue-${group.key}`} className="text-sm font-semibold uppercase tracking-wide">
                        {group.heading}
                      </h2>
                      <span className="text-xs text-brand-textMuted">
                        {group.jobs.length} · {group.hint}
                      </span>
                    </div>
                    <ul className="space-y-2">
                      {group.jobs.map((job) => (
                        <li key={job.id}>
                          <JobRowLink
                            job={job}
                            now={now}
                            assignee={job.assigned_to ? shown.people[job.assigned_to] : null}
                            trailing={
                              job.order_id && shown.orders[job.order_id] ? (
                                <span className="text-xs text-brand-textMuted">
                                  {shown.orders[job.order_id].order_number ?? "Order"}
                                </span>
                              ) : null
                            }
                          />
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null
              )}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

export default function StaffProductionQueuePage() {
  // useSearchParams needs a Suspense boundary; without one the whole route
  // opts into client-side rendering at build time.
  return (
    <Suspense
      fallback={
        <div className="page-container">
          <p className="text-sm text-brand-textMuted" role="status">
            Loading the production queue…
          </p>
        </div>
      }
    >
      <QueueContent />
    </Suspense>
  );
}
