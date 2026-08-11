"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { SentryTestPanel } from "@/components/staff/SentryTestPanel";
import { LoadingState, PageHeader, StaffPage } from "@/components/staff/StaffPage";
import { Badge, EmptyState, MetricCard, Notice, Panel } from "@/components/ui/DesignSystem";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { STATUS_LABELS, type IntegrationCheck, type IntegrationStatus } from "@/lib/ops/integrationHealth";

/**
 * Integration health.
 *
 * The whole point of this page is the second column: **verified** versus
 * **assumed**. An environment variable being set proves configuration, not
 * health, and every previous pass in this project has been caught by exactly
 * that gap — grants missing behind correct RLS, a webhook handler deployed but
 * unsubscribed, an analytics script that refuses to run under automation.
 *
 * So nothing here shows a green tick for "the key is present". A check that has
 * not been exercised says so, and says what would exercise it.
 *
 * Nothing on this page writes, charges, refunds or sends. There is no "test
 * connection" button that costs money, and no probe that leaves a mark.
 */

type Summary = {
  failing: number;
  incomplete: number;
  degraded: number;
  notConfigured: number;
  healthy: number;
  verified: number;
  total: number;
};

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; checks: IntegrationCheck[]; summary: Summary };

const TONE: Record<IntegrationStatus, "success" | "warning" | "danger" | "neutral"> = {
  healthy: "success",
  degraded: "warning",
  failing: "danger",
  incomplete: "warning",
  not_configured: "neutral",
};

export default function IntegrationsPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { data: access, isLoading } = useMeAccess();
  const permissions = new Set(access?.permissions ?? []);
  const canView = permissions.has("operations.health.view");
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;
    try {
      const response = await fetch("/api/staff/integrations", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: "no-store",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setState({ kind: "error", message: body.error || "Integration health could not be read." });
        return;
      }
      const payload = (await response.json()) as { checks: IntegrationCheck[]; summary: Summary };
      setState({ kind: "ready", checks: payload.checks, summary: payload.summary });
    } catch {
      setState({ kind: "error", message: "Integration health could not be read. Check the connection and retry." });
    }
  }, [supabase]);

  useEffect(() => {
    if (!canView) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [canView, load]);

  if (isLoading) return <LoadingState>Loading…</LoadingState>;
  if (!canView) {
    return <AccessDeniedCard message="Integration health reports platform configuration, so it needs the View integration health permission." />;
  }

  const ready = state.kind === "ready" ? state : null;

  return (
    <StaffPage>
      <PageHeader
        kind="Administrative tool"
        title="Integration health"
        description="What every external service this shop depends on is doing. No secret value appears here, and nothing on this page makes a call that charges, refunds or emails anybody."
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
        <strong>Verified</strong> means something actually happened — a webhook arrived and its signature
        checked out, an email was accepted, a query returned. <strong>Assumed</strong> means configuration is
        present and nothing has exercised it. An assumed check is not a healthy one, and each says what would
        make it verified.
      </Notice>

      {state.kind === "error" ? (
        <Notice tone="danger" role="alert">
          {state.message}
        </Notice>
      ) : null}

      {ready ? (
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Integration summary">
          <MetricCard
            label="Failing"
            value={String(ready.summary.failing)}
            detail="Broken right now"
            tone={ready.summary.failing ? "danger" : "success"}
          />
          <MetricCard
            label="Incomplete"
            value={String(ready.summary.incomplete)}
            detail="Half configured"
            tone={ready.summary.incomplete ? "warning" : "default"}
          />
          <MetricCard
            label="Degraded"
            value={String(ready.summary.degraded)}
            detail="Working, with a caveat"
            tone={ready.summary.degraded ? "warning" : "default"}
          />
          <MetricCard
            label="Verified"
            value={`${ready.summary.verified} / ${ready.summary.total}`}
            detail="Proven by something that happened"
          />
        </section>
      ) : null}

      {state.kind === "loading" ? <EmptyState>Reading integration state…</EmptyState> : null}

      {ready
        ? ready.checks.map((check) => (
            <Panel key={check.key}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold">{check.label}</h2>
                  <p className="mt-1 text-xs text-brand-textMuted">{check.purpose}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={TONE[check.status]}>{STATUS_LABELS[check.status]}</Badge>
                  <Badge tone={check.confidence === "verified" ? "success" : "neutral"}>
                    {check.confidence === "verified" ? "Verified" : "Assumed"}
                  </Badge>
                </div>
              </div>

              <p className="mt-3 text-sm">{check.summary}</p>

              {check.lastFailure ? (
                <p className="mt-2 text-sm text-brand-textMuted">
                  Last failure {new Date(check.lastFailure.at).toLocaleString()}: {check.lastFailure.summary}
                </p>
              ) : null}

              {check.verificationNote ? (
                <p className="mt-2 rounded-lg border border-zinc-800 bg-black/25 p-3 text-xs text-brand-textMuted">
                  {check.verificationNote}
                </p>
              ) : null}

              <div className="mt-3 flex flex-wrap gap-4 text-xs font-semibold">
                {check.settingsHref ? (
                  <Link href={check.settingsHref} className="inline-flex min-h-11 items-center text-brand-accent hover:underline">
                    {check.settingsLabel} →
                  </Link>
                ) : null}
                {check.recordsHref ? (
                  <Link href={check.recordsHref} className="inline-flex min-h-11 items-center text-brand-accent hover:underline">
                    {check.recordsLabel} →
                  </Link>
                ) : null}
              </div>
            </Panel>
          ))
        : null}

      {/*
        The Sentry connection test, moved here from `/staff/settings`.

        It sat on the settings directory as a ninth block under four headings of
        real configuration — a button that deliberately throws an error, beside
        "Commerce" and "Appearance". Nothing about it is a setting: it changes
        no state, it is run once when somebody is wiring up monitoring, and its
        whole question is "is this integration actually working", which is the
        question this page exists to answer and answers for every other service.

        Its permission is unchanged. It needed `security.view` on the settings
        page and it needs `security.view` here, on top of the
        `operations.health.view` that opens the page at all — so this move gives
        nobody access they did not already have.
      */}
      {permissions.has("security.view") ? <SentryTestPanel /> : null}
    </StaffPage>
  );
}
