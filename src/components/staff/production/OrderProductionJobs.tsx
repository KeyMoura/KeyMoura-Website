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
          <Link href={newJobHref} className="ui-btn ui-btn-secondary text-sm">
            Raise a job
          </Link>
        ) : null}
      </div>

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
