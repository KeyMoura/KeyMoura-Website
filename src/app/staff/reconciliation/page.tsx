"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { Badge, EmptyState, MetricCard, Notice, Panel } from "@/components/ui/DesignSystem";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";
import type { CheckResult, Severity } from "@/lib/staff/reconciliation";

/**
 * Reconciliation and health.
 *
 * Six checks over money, stock and delivery, each stating the question it asks
 * so a clean pass means something. Every finding names the fix and links to the
 * page where it is made.
 *
 * **Nothing on this page changes anything.** The report is evidence; the repair
 * is the ordinary staff action the finding points at. That is deliberate — the
 * refund settlement and inventory commit paths are idempotent and guarded, and
 * a repair button here would be a third writer without either property.
 */

type Report = {
  generatedAt: string;
  checks: CheckResult[];
  counts: Record<Severity, number>;
  scope: { orders: number; orderLimit: number; truncated: boolean };
};

const SEVERITY_TONE: Record<Severity, "danger" | "warning" | "neutral"> = {
  critical: "danger",
  warning: "warning",
  info: "neutral",
};

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Needs attention now",
  warning: "Worth a look",
  info: "For information",
};

export default function StaffReconciliationPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { data: access, isLoading } = useMeAccess();
  const permissions = new Set(access?.permissions ?? []);
  const canView = permissions.has("orders.view") || permissions.has("orders.manage");

  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;
    const response = await fetch("/api/staff/reconciliation", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: "no-store",
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setError(payload.error || "Could not build the reconciliation report.");
      setLoading(false);
      return;
    }
    setReport((await response.json()) as Report);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    if (!canView) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [canView, load]);

  if (isLoading) return <div className="ui-card text-sm text-brand-textMuted">Loading…</div>;
  if (!canView) {
    return <AccessDeniedCard message="Reconciliation reads order-level money, so it needs the order access permission." />;
  }

  const total = report ? report.counts.critical + report.counts.warning + report.counts.info : 0;

  return (
    <main className="page-stack">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="ui-eyebrow">Business</p>
          <h1 className="mt-1 text-3xl font-semibold">Reconciliation</h1>
          <p className="mt-2 max-w-2xl text-sm text-brand-textMuted">
            Payments, refunds, stock holds and delivery, checked against each other. This page reads; it never
            writes. Each finding names the page where the fix is made.
          </p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="ui-btn ui-btn-secondary disabled:opacity-50">
          {loading ? "Checking…" : "Run the checks again"}
        </button>
      </div>

      {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}

      {report ? (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Reconciliation summary">
            <MetricCard
              label="Needs attention now"
              value={String(report.counts.critical)}
              detail="Money or stock that does not add up"
              tone={report.counts.critical ? "danger" : "success"}
            />
            <MetricCard
              label="Worth a look"
              value={String(report.counts.warning)}
              detail="Stalled, stuck, or drifted from its history"
              tone={report.counts.warning ? "warning" : "default"}
            />
            <MetricCard label="For information" value={String(report.counts.info)} detail="Normal housekeeping" />
            <MetricCard
              label="Orders checked"
              value={String(report.scope.orders)}
              detail={report.scope.truncated ? `Capped at ${report.scope.orderLimit} — older orders were not read` : "Every order"}
              tone={report.scope.truncated ? "warning" : "default"}
            />
          </section>

          <p className="text-xs text-brand-textMuted">
            Generated {new Date(report.generatedAt).toLocaleString()}
            {total === 0 ? " · everything reconciles" : ""}
          </p>

          {report.checks.map((check) => (
            <Panel key={check.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{check.title}</h2>
                  <p className="mt-1 text-xs text-brand-textMuted">{check.question}</p>
                </div>
                <Badge tone={check.findings.length ? "warning" : "success"}>
                  {check.findings.length ? `${check.findings.length} finding${check.findings.length === 1 ? "" : "s"}` : "Clean"}
                </Badge>
              </div>

              {check.findings.length ? (
                <ul className="mt-4 space-y-3">
                  {check.findings.map((finding, index) => (
                    <li key={`${finding.code}-${index}`} className="rounded-xl border border-zinc-800 bg-black/25 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <p className="text-sm font-medium">{finding.title}</p>
                        <Badge tone={SEVERITY_TONE[finding.severity]}>{SEVERITY_LABEL[finding.severity]}</Badge>
                      </div>
                      <p className="mt-2 text-sm text-brand-textMuted">{finding.detail}</p>
                      <p className="mt-2 text-sm">
                        <span className="text-brand-textMuted">What to do: </span>
                        {finding.remedy}
                      </p>
                      {finding.href ? (
                        <Link href={finding.href} className="mt-3 inline-block text-xs font-semibold text-brand-accent hover:underline">
                          Open the record →
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-4 text-sm text-brand-textMuted">
                  {check.checked} record{check.checked === 1 ? "" : "s"} checked, nothing out of place.
                </p>
              )}
            </Panel>
          ))}
        </>
      ) : loading ? (
        <EmptyState>Running the checks…</EmptyState>
      ) : null}
    </main>
  );
}
