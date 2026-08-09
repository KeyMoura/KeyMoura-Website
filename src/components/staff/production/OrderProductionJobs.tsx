"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { EmptyState, Notice, Panel } from "@/components/ui/DesignSystem";
import { DueDate, PriorityBadge, StatusBadge } from "@/components/staff/production/JobBadges";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import type { ProductionStatus } from "@/lib/production/jobs";

/**
 * Shop work raised against one order, shown on the staff order page.
 *
 * Read-only here on purpose. This panel answers "is anything being made for
 * this order, and where has it got to" — editing happens on the job itself,
 * which is where the transition rules, the reason prompts and the history live.
 * Duplicating a status control here would be a second write path to guard.
 */

type Job = {
  id: string;
  job_number: string;
  title: string;
  status: ProductionStatus;
  priority: "low" | "normal" | "high" | "urgent";
  due_date: string | null;
  assigned_to: string | null;
  created_at: string;
  /**
   * Where the job is attached right now.
   *
   * Read from the queue endpoint, which has always returned it — the type
   * simply did not name it, which is why the link picker could not show a
   * candidate's current order and had to restrict itself to unlinked work.
   * It is also what `expectedOrderId` is set from, so the relink's stale check
   * compares against what the reader was actually shown.
   */
  order_id: string | null;
};

type Props = {
  orderId: string;
  /** Prefills the new-job form so staff do not retype what the order already knows. */
  productId?: string | null;
  customerId?: string | null;
  productName?: string | null;
  /** Shown on the panel and carried into the new job, so both surfaces name the same order. */
  orderNumber?: string | null;
  /** Prefills the job quantity. An order for six is six to make, not one. */
  quantity?: number | null;
  /**
   * Reports what was found, so the order header can state the production state
   * without loading the jobs a second time.
   *
   * The order workspace header answers "is this being made" beside payment and
   * fulfillment. Fetching the same list twice to fill in one badge would be two
   * requests that can disagree; this is the panel telling the page what it
   * already knows.
   */
  onSummary?: (summary: { count: number; label: string }) => void;
};

export function OrderProductionJobs({
  orderId,
  productId,
  customerId,
  productName,
  orderNumber,
  quantity,
  onSummary,
}: Props) {
  const { data: access } = useMeAccess();
  const permissions = useMemo(() => new Set(access?.permissions ?? []), [access]);
  const canView = permissions.has("production.view") || permissions.has("production.manage");
  const canManage = permissions.has("production.manage");

  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [people, setPeople] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [now] = useState(() => new Date());

  // Same rule as the `canView` gate below: a refusal hides the section rather
  // than turning it red. An order page should not grow a permission error for
  // a panel its reader was never meant to see.
  const [denied, setDenied] = useState(false);

  /*
   * Linking existing work.
   *
   * `candidates === null` means "not fetched yet", which is a different thing
   * from "fetched and there are none" — the two render different sentences, and
   * collapsing them is how an empty list reads as a loading state that never
   * finishes.
   *
   * The search covers **every** open job, not only unlinked ones. The previous
   * version offered `orderId=none` on the reasoning that this made it impossible
   * to steal a job from another order by accident. It also made moving work
   * between orders impossible from the place you notice it is on the wrong one,
   * and "impossible" is not the same as "deliberate". A job that already belongs
   * somewhere now shows where, and takes a second, explicit confirmation naming
   * both orders before it moves.
   */
  const [linking, setLinking] = useState(false);
  const [candidates, setCandidates] = useState<Job[] | null>(null);
  const [orderNumbers, setOrderNumbers] = useState<Record<string, { order_number: string | null }>>({});
  const [term, setTerm] = useState("");
  const [confirming, setConfirming] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkError, setLinkError] = useState("");

  const loadCandidates = useCallback(
    async (search: string) => {
      setLinkError("");
      try {
        const query = new URLSearchParams({ scope: "open", limit: "25" });
        if (search.trim()) query.set("q", search.trim());
        const response = await fetch(`/api/staff/production/jobs?${query}`, { credentials: "same-origin" });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error || "Could not load jobs.");
        // Jobs already on this order are not candidates for linking to it.
        setCandidates((body.jobs ?? []).filter((job: Job) => job.order_id !== orderId));
        setOrderNumbers(body.orders ?? {});
      } catch (cause) {
        setCandidates([]);
        setLinkError(cause instanceof Error ? cause.message : "Could not load jobs.");
      }
    },
    [orderId]
  );

  // The search box writes on a pause rather than per keystroke: each one is a
  // round trip to a staff endpoint, and the list is short enough that a 300ms
  // wait costs nothing.
  useEffect(() => {
    if (!linking) return;
    const timer = window.setTimeout(() => void loadCandidates(term), 300);
    return () => window.clearTimeout(timer);
  }, [linking, term, loadCandidates]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setDenied(false);
    try {
      const response = await fetch(
        `/api/staff/production/jobs?scope=all&orderId=${encodeURIComponent(orderId)}`,
        { credentials: "same-origin" }
      );
      const body = await response.json().catch(() => null);
      if (response.status === 403) {
        setDenied(true);
        return;
      }
      if (!response.ok) throw new Error(body?.error || "Could not load production jobs.");
      setJobs(body.jobs ?? []);
      setPeople(body.people ?? {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load production jobs.");
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  // Declared after `load` because it calls it: a `useCallback` naming `load` in
  // its dependency array before the `const` exists is a temporal-dead-zone
  // error at render, not a lint nit.
  const linkJob = useCallback(
    async (job: Job) => {
      setBusy(true);
      setLinkError("");
      try {
        const response = await fetch(`/api/staff/production/jobs/${job.id}/link`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          /*
           * `expectedOrderId` is where the browser believes the job currently
           * is — null for unattached work, the other order's id for a move. The
           * server compares it to the stored value *and* re-asserts it in the
           * WHERE clause, so if somebody linked this job while the picker was
           * open the request matches zero rows and comes back 409 naming the
           * conflict, instead of overwriting a decision that landed first.
           */
          body: JSON.stringify({ orderId, expectedOrderId: job.order_id ?? null }),
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error || "Could not link that job.");
        setConfirming(null);
        setLinking(false);
        setCandidates(null);
        setTerm("");
        await load();
      } catch (cause) {
        setLinkError(cause instanceof Error ? cause.message : "Could not link that job.");
      } finally {
        setBusy(false);
      }
    },
    [orderId, load]
  );

  useEffect(() => {
    if (canView) void load();
  }, [canView, load]);

  /*
   * Report the summary upward once the jobs are known.
   *
   * In an effect keyed on `jobs` rather than inside `load`, so a parent that
   * re-renders in response cannot re-enter the fetch. The label is the least
   * finished status present — an order with one job done and one queued is not
   * "done", and reporting the newest job's status would say so on half the
   * loads depending on insertion order.
   */
  useEffect(() => {
    if (!jobs || !onSummary) return;
    const RANK: Record<string, number> = { blocked: 0, on_hold: 1, queued: 2, in_progress: 3, done: 4 };
    const least = jobs.reduce<string | null>(
      (worst, job) => (worst === null || (RANK[job.status] ?? 9) < (RANK[worst] ?? 9) ? job.status : worst),
      null
    );
    onSummary({
      count: jobs.length,
      label: least ? least.replaceAll("_", " ") : "none",
    });
  }, [jobs, onSummary]);

  // Silent for staff without production access — an order page should not grow
  // a permission error for a section they were never meant to see.
  if (!canView || denied) return null;

  /*
   * Everything the order already knows, handed to the new-job form.
   *
   * The point is that raising a job from an order should require typing
   * nothing. The order number travels too — not to be stored, but so the form
   * can *say* which order it is about; "This job will be linked to the order it
   * was raised from" named no order at all, which is the sentence you write when
   * you have not decided whether the reader can trust it.
   */
  const newJobHref = (() => {
    const params = new URLSearchParams({ orderId });
    if (productId) params.set("productId", productId);
    if (customerId) params.set("customerId", customerId);
    if (productName) params.set("title", productName);
    if (orderNumber) params.set("orderNumber", orderNumber);
    if (quantity && quantity > 0) params.set("quantity", String(quantity));
    return `/staff/production/new?${params}`;
  })();

  /** Open work already on this order. A second job is allowed — it just should not be an accident. */
  const openJobs = (jobs ?? []).filter((job) => !["completed", "cancelled"].includes(job.status));

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Shop work</h2>
          <p className="mt-1 text-xs text-brand-textMuted">
            Production jobs raised against this order. Internal — never shown to the customer.
          </p>
        </div>
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="ui-btn ui-btn-ghost text-sm"
              aria-expanded={linking}
              onClick={() => {
                setLinking((open) => !open);
                setLinkError("");
                setConfirming(null);
              }}
            >
              Link existing job
            </button>
            {/* Primary, because raising the work is the common act and linking
                existing work is the exception. */}
            <Link href={newJobHref} className="ui-btn ui-btn-primary text-sm">
              Create production job
            </Link>
          </div>
        ) : null}
      </div>

      {/*
        Linking existing work.

        Every open job is searchable, and each row states where it currently
        lives. A job that already belongs to another order can be moved — that is
        the case the previous version made impossible rather than deliberate —
        but only through a confirmation that names both orders.
      */}
      {canManage && linking ? (
        <div className="ui-card mt-4 p-3">
          <label htmlFor="link-existing-job" className="block text-xs font-medium text-brand-textMuted">
            Search production jobs by number or title
          </label>
          <input
            id="link-existing-job"
            type="search"
            className="ui-input mt-1 w-full text-sm"
            value={term}
            disabled={busy}
            placeholder="KM-JOB-12, or “shift knob”…"
            onChange={(event) => setTerm(event.target.value)}
          />

          {confirming ? (
            /*
              A relink is a second decision, not a second click in the same
              gesture. Both order numbers are named because "move this job" is
              only checkable if you can see what it is moving *from*.
            */
            <Notice tone="warning" className="mt-3">
              <p className="font-medium">
                {confirming.order_id
                  ? `Move ${confirming.job_number} off order ${
                      orderNumbers[confirming.order_id]?.order_number ?? "it is currently on"
                    }?`
                  : `Link ${confirming.job_number} to this order?`}
              </p>
              <p className="mt-1 text-sm">
                {confirming.title}
                {confirming.order_id
                  ? ` — it will be attached to ${orderNumber ? `order ${orderNumber}` : "this order"} instead, and its order item is cleared.`
                  : ""}
              </p>
              <div className="ui-action-row mt-3">
                <button
                  type="button"
                  className="ui-btn ui-btn-primary text-sm"
                  disabled={busy}
                  onClick={() => void linkJob(confirming)}
                >
                  {busy ? "Linking…" : confirming.order_id ? "Move it here" : "Link it"}
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost text-sm"
                  disabled={busy}
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </button>
              </div>
            </Notice>
          ) : candidates === null ? (
            <p className="mt-2 text-sm text-brand-textMuted" role="status">
              Loading jobs…
            </p>
          ) : candidates.length === 0 ? (
            <p className="mt-2 text-sm text-brand-textMuted">
              {term.trim()
                ? `No open job matches “${term.trim()}”.`
                : "There is no other open shop work. Create a production job instead."}
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {candidates.map((job) => (
                <li key={job.id}>
                  <button
                    type="button"
                    className="ui-card ui-card-hover flex w-full flex-wrap items-center gap-x-3 gap-y-1 p-2 text-left"
                    disabled={busy}
                    onClick={() => setConfirming(job)}
                  >
                    <span className="font-mono text-xs text-brand-textMuted">{job.job_number}</span>
                    <span className="min-w-0 flex-1 basis-40 truncate text-sm font-medium">{job.title}</span>
                    <StatusBadge status={job.status} />
                    {/* Where it is now, stated on every row — including "not
                        linked", because silence there reads as a failed lookup. */}
                    <span className="text-xs text-brand-textMuted">
                      {job.order_id
                        ? `On order ${orderNumbers[job.order_id]?.order_number ?? "—"}`
                        : "Not linked"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {linkError ? (
            <Notice tone="danger" role="alert" className="mt-3">
              <p>{linkError}</p>
            </Notice>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <Notice tone="danger" role="alert" className="mt-4">
          <p>{error}</p>
          <button type="button" className="ui-btn ui-btn-ghost mt-2 text-sm" onClick={() => void load()}>
            Try again
          </button>
        </Notice>
      ) : null}

      {loading && !jobs ? (
        <p className="mt-4 text-sm text-brand-textMuted" role="status">
          Loading production jobs…
        </p>
      ) : null}

      {jobs && !jobs.length ? (
        <EmptyState className="mt-4">
          <p className="font-medium">No production job for this order yet.</p>
          {canManage ? (
            <p className="mt-1">
              <strong>Create production job</strong> starts one with this order, its customer and its
              quantity already filled in. Use <strong>Link existing job</strong> if the work is already
              on the board.
            </p>
          ) : null}
        </EmptyState>
      ) : null}

      {/*
        The duplicate guard.

        A second job on one order is legitimate — two parts, or a remake — so it
        is not refused. It is *named*, before the button that would create a
        third, because the accident this prevents is raising the same job twice
        after a page reload and then machining it twice.
      */}
      {canManage && openJobs.length > 0 ? (
        <Notice tone="info" className="mt-4">
          <p>
            This order already has {openJobs.length} open production{" "}
            {openJobs.length === 1 ? "job" : "jobs"} ({openJobs.map((job) => job.job_number).join(", ")}).
            Create another only if it is genuinely separate work.
          </p>
        </Notice>
      ) : null}

      {jobs?.length ? (
        <ul className="mt-4 space-y-2">
          {jobs.map((job) => (
            <li key={job.id}>
              <Link
                href={`/staff/production/${job.id}`}
                className="ui-card ui-card-hover flex flex-wrap items-center gap-x-3 gap-y-2 p-3"
              >
                <span className="font-mono text-xs text-brand-textMuted">{job.job_number}</span>
                <span className="min-w-0 flex-1 basis-40 truncate text-sm font-medium">{job.title}</span>
                <StatusBadge status={job.status} />
                <PriorityBadge priority={job.priority} />
                <span className="text-xs">
                  <DueDate job={job} now={now} />
                </span>
                {job.assigned_to ? (
                  <span className="text-xs text-brand-textMuted">{people[job.assigned_to] ?? "Assigned"}</span>
                ) : (
                  <span className="text-xs text-amber-200">Unassigned</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}
