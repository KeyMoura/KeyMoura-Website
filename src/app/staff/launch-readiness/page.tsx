"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { LoadingState, PageHeader, StaffPage } from "@/components/staff/StaffPage";
import { ConsequentialAction, resultFromResponse } from "@/components/staff/ConsequentialAction";
import { Badge, EmptyState, MetricCard, Notice, Panel } from "@/components/ui/DesignSystem";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";
import {
  GROUP_LABELS,
  STATE_RANK,
  type CheckState,
  type ReadinessCheck,
  type ReadinessGroup,
} from "@/lib/ops/launchReadiness";

/**
 * Launch readiness.
 *
 * Every issue links to the exact setting or record that fixes it, and every one
 * says *why* it matters — which workflow depends on it — rather than only that
 * it is unset. "Set a return address" is a chore; "approving a return snapshots
 * a blank address and staff type it by hand every time" is a reason.
 *
 * Two things this page refuses to do:
 *
 *   * **Claim compliance.** It does not certify legal, tax, accessibility or
 *     security compliance and says so at the top. A checklist that reports
 *     "compliant" because a policy page exists converts an unanswered question
 *     into a false answer.
 *   * **Let a blocker be acknowledged.** A blocker means a customer trying to
 *     buy right now would fail. Ticking that away would make the one part of
 *     the page that has to be believed the part that can be silenced.
 */

type Check = ReadinessCheck & { acknowledged: boolean; acknowledgementStale: boolean };

type Summary = {
  blockers: number;
  warnings: number;
  acknowledged: number;
  info: number;
  passed: number;
  total: number;
  readyToLaunch: boolean;
};

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; checks: Check[]; summary: Summary; canAcknowledge: boolean; disclaimer: string };

const TONE: Record<CheckState, "success" | "warning" | "danger" | "neutral"> = {
  blocker: "danger",
  warning: "warning",
  info: "neutral",
  passed: "success",
};

const STATE_LABEL: Record<CheckState, string> = {
  blocker: "Blocker",
  warning: "Warning",
  info: "For information",
  passed: "Passed",
};

const GROUP_ORDER: ReadinessGroup[] = ["storefront", "commerce", "payments", "communications", "reliability"];

export default function LaunchReadinessPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { data: access, isLoading } = useMeAccess();
  const permissions = new Set(access?.permissions ?? []);
  const canView = permissions.has("launch.readiness.view") || permissions.has("operations.health.view");
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;
    try {
      const response = await fetch("/api/staff/launch-readiness", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: "no-store",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setState({ kind: "error", message: body.error || "Launch readiness could not be computed." });
        return;
      }
      const payload = (await response.json()) as {
        checks: Check[];
        summary: Summary;
        canAcknowledge: boolean;
        disclaimer: string;
      };
      setState({ kind: "ready", ...payload });
    } catch {
      setState({ kind: "error", message: "Launch readiness could not be computed. Check the connection and retry." });
    }
  }, [supabase]);

  useEffect(() => {
    if (!canView) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [canView, load]);

  if (isLoading) return <LoadingState>Loading…</LoadingState>;
  if (!canView) {
    return <AccessDeniedCard message="Launch readiness reads commerce configuration, so it needs the View launch readiness permission." />;
  }

  const ready = state.kind === "ready" ? state : null;

  return (
    <StaffPage>
      <PageHeader
        kind="Administrative tool"
        title="Launch readiness"
        description="What would stop this shop taking a real order today. Every issue links to the exact setting or record that fixes it and says which workflow depends on it."
        actions={
          <button
            type="button"
            onClick={() => void load()}
            disabled={state.kind === "loading"}
            className="ui-btn ui-btn-secondary text-sm disabled:opacity-50"
          >
            {state.kind === "loading" ? "Checking…" : "Check again"}
          </button>
        }
      />

      <Notice tone="info">
        This checklist reports whether the configuration this application reads is complete and coherent. It is
        <strong> not</strong> a legal, tax, accessibility or security compliance assessment and does not
        certify any of those.
      </Notice>

      {state.kind === "error" ? (
        <Notice tone="danger" role="alert">
          {state.message}
        </Notice>
      ) : null}

      {ready ? (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Readiness summary">
            <MetricCard
              label="Blockers"
              value={String(ready.summary.blockers)}
              detail={ready.summary.blockers ? "A customer would fail right now" : "Nothing is broken"}
              tone={ready.summary.blockers ? "danger" : "success"}
            />
            <MetricCard
              label="Warnings"
              value={String(ready.summary.warnings)}
              detail={ready.summary.acknowledged ? `${ready.summary.acknowledged} acknowledged` : "Unaddressed"}
              tone={ready.summary.warnings ? "warning" : "default"}
            />
            <MetricCard label="Passed" value={String(ready.summary.passed)} detail={`of ${ready.summary.total} checks`} />
            <MetricCard
              label="Can take an order"
              value={ready.summary.readyToLaunch ? "Yes" : "No"}
              detail={ready.summary.readyToLaunch ? "No blocking issue" : "Fix the blockers first"}
              tone={ready.summary.readyToLaunch ? "success" : "danger"}
            />
          </section>

          {GROUP_ORDER.map((group) => {
            const checks = ready.checks
              .filter((check) => check.group === group)
              .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.title.localeCompare(b.title));
            if (!checks.length) return null;
            return (
              <Panel key={group}>
                <h2 className="text-lg font-semibold">{GROUP_LABELS[group]}</h2>
                <ul className="mt-4 space-y-3">
                  {checks.map((check) => (
                    <li
                      key={check.id}
                      className="rounded-xl border border-zinc-800 bg-black/25 p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <p className="text-sm font-medium">{check.title}</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={TONE[check.state]}>{STATE_LABEL[check.state]}</Badge>
                          {check.acknowledged ? <Badge tone="neutral">Acknowledged</Badge> : null}
                          {check.acknowledgementStale ? <Badge tone="warning">Changed since accepted</Badge> : null}
                        </div>
                      </div>

                      <p className="mt-2 text-sm text-brand-textMuted">{check.detail}</p>
                      <p className="mt-2 text-sm">
                        <span className="text-brand-textMuted">Why it matters: </span>
                        {check.because}
                      </p>

                      <div className="mt-3 flex flex-wrap items-center gap-4">
                        {check.fixHref ? (
                          <Link
                            href={check.fixHref}
                            className="inline-flex min-h-11 items-center text-xs font-semibold text-brand-accent hover:underline"
                          >
                            {check.fixLabel} →
                          </Link>
                        ) : null}
                        {ready.canAcknowledge && check.acknowledgeable && check.state !== "passed" && check.state !== "blocker" ? (
                          <AcknowledgeControl check={check} onDone={() => void load()} />
                        ) : null}
                        {check.state === "blocker" ? (
                          <span className="text-xs text-brand-textMuted">
                            A blocker cannot be acknowledged — it has to be fixed.
                          </span>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </Panel>
            );
          })}
        </>
      ) : state.kind === "loading" ? (
        <EmptyState>Running the checks…</EmptyState>
      ) : null}
    </StaffPage>
  );
}

function AcknowledgeControl({ check, onDone }: { check: Check; onDone: () => void }) {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const post = useCallback(
    async (body: Record<string, unknown>) => {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;
      const response = await fetch("/api/staff/launch-readiness", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const result = await resultFromResponse(response);
      if (result.ok) onDone();
      return result;
    },
    [supabase, onDone]
  );

  if (check.acknowledged) {
    return (
      <ConsequentialAction
        label="Withdraw acknowledgement"
        title="Withdraw this acknowledgement?"
        confirmLabel="Withdraw it"
        currentState="Acknowledged"
        nextState={STATE_LABEL[check.state]}
        summary={<>“{check.title}” will show as an open {check.state} again.</>}
        effects={{
          customer: null,
          financial: null,
          inventory: null,
          notification: "Recorded in the audit log. No setting, order or amount changes.",
        }}
        onConfirm={() => post({ checkId: check.id, clear: true })}
      />
    );
  }

  return (
    <ConsequentialAction
      label="Acknowledge"
      title="Acknowledge this warning?"
      confirmLabel="Acknowledge it"
      currentState={STATE_LABEL[check.state]}
      nextState="Acknowledged"
      summary={
        <>
          “{check.title}” will be recorded as seen and accepted. It stays visible and comes back on its own if
          the situation changes.
        </>
      }
      effects={{
        customer: null,
        financial: "Nothing. An acknowledgement records a decision and never changes an order, a total or a setting.",
        inventory: null,
        notification: "Recorded in the audit log with who accepted it and when.",
      }}
      internalNote={{
        label: "Why is this acceptable? (internal, optional)",
        placeholder: "Shipping stays off until the courier account is open",
        help: "Recorded on the acknowledgement so the next reader knows the reasoning.",
      }}
      onConfirm={(submission) =>
        post({ checkId: check.id, fingerprint: check.fingerprint, note: submission.internalNote })
      }
    />
  );
}
