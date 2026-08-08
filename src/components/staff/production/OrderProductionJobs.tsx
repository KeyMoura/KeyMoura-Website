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
};

type Props = {
  orderId: string;
  /** Prefills the new-job form so staff do not retype what the order already knows. */
  productId?: string | null;
  customerId?: string | null;
  productName?: string | null;
};

export function OrderProductionJobs({ orderId, productId, customerId, productName }: Props) {
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

  // Linking existing work. `standalone === null` means "not fetched yet", which
  // is a different thing from "fetched and there are none" — the two render
  // different sentences, and collapsing them is how an empty list reads as a
  // loading state that never finishes.
  const [linking, setLinking] = useState(false);
  const [standalone, setStandalone] = useState<Job[] | null>(null);
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  const [linkError, setLinkError] = useState("");

  const loadStandalone = useCallback(async () => {
    setLinkError("");
    try {
      const response = await fetch("/api/staff/production/jobs?scope=open&orderId=none&limit=50", {
        credentials: "same-origin",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || "Could not load unlinked jobs.");
      setStandalone(body.jobs ?? []);
    } catch (cause) {
      setStandalone([]);
      setLinkError(cause instanceof Error ? cause.message : "Could not load unlinked jobs.");
    }
  }, []);

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
  const linkChosen = useCallback(async () => {
    if (!chosen) return;
    setBusy(true);
    setLinkError("");
    try {
      const response = await fetch(`/api/staff/production/jobs/${chosen}/link`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        // The job is being taken from "no order", and the server re-checks that
        // before writing. A job linked elsewhere in the meantime gets a 409
        // rather than being quietly moved.
        body: JSON.stringify({ orderId, expectedOrderId: null }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || "Could not link that job.");
      setChosen("");
      setLinking(false);
      setStandalone(null);
      await load();
    } catch (cause) {
      setLinkError(cause instanceof Error ? cause.message : "Could not link that job.");
    } finally {
      setBusy(false);
    }
  }, [chosen, orderId, load]);

  useEffect(() => {
    if (canView) void load();
  }, [canView, load]);

  // Silent for staff without production access — an order page should not grow
  // a permission error for a section they were never meant to see.
  if (!canView || denied) return null;

  const newJobHref = (() => {
    const params = new URLSearchParams({ orderId });
    if (productId) params.set("productId", productId);
    if (customerId) params.set("customerId", customerId);
    if (productName) params.set("title", productName);
    return `/staff/production/new?${params}`;
  })();

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
                if (!linking && standalone === null) void loadStandalone();
              }}
            >
              Link existing work
            </button>
            <Link href={newJobHref} className="ui-btn ui-btn-secondary text-sm">
              Raise a job
            </Link>
          </div>
        ) : null}
      </div>

      {/* Linking existing work.
          The choice is limited to jobs that belong to no order, so this control
          cannot take a job away from another order by accident — moving work
          between orders is a deliberate act, and it happens on the job itself
          where the previous link is visible. */}
      {canManage && linking ? (
        <div className="ui-card mt-4 p-3">
          <label htmlFor="link-existing-job" className="block text-xs font-medium text-brand-textMuted">
            Unlinked production jobs
          </label>

          {standalone === null ? (
            <p className="mt-2 text-sm text-brand-textMuted" role="status">
              Loading jobs…
            </p>
          ) : standalone.length === 0 ? (
            <p className="mt-2 text-sm text-brand-textMuted">
              There is no unlinked shop work to attach. Raise a job instead.
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select
                id="link-existing-job"
                className="ui-input min-w-0 flex-1 basis-56 text-sm"
                value={chosen}
                onChange={(event) => setChosen(event.target.value)}
                disabled={busy}
              >
                <option value="">Choose a job…</option>
                {standalone.map((job) => (
                  <option key={job.id} value={job.id}>
                    {job.job_number} — {job.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ui-btn ui-btn-primary text-sm"
                disabled={!chosen || busy}
                onClick={() => void linkChosen()}
              >
                {busy ? "Linking…" : "Link to this order"}
              </button>
            </div>
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
            <p className="mt-1">Raise one when the work is ready to be scheduled.</p>
          ) : null}
        </EmptyState>
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
