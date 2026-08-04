"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { EmptyState, Notice, Panel } from "@/components/ui/DesignSystem";

/**
 * Production cards for the staff dashboard.
 *
 * Each card is an action-required state, not a statistic, and each links to the
 * exact filtered queue that holds those jobs — "3 overdue" opens those three,
 * with the filter already applied. A card that only reports a number leaves the
 * operator to reconstruct the query by hand, which is where a dashboard stops
 * being used.
 *
 * Counts come from a server-side aggregation endpoint, so they are true totals
 * and cost no row transfer.
 */

type Summary = {
  open: number;
  overdue: number;
  blocked: number;
  unassigned: number;
  inQualityCheck: number;
  rework: number;
  ready: number;
  dueThisWeek: number;
};

type Card = {
  key: keyof Summary;
  label: string;
  href: string;
  tone: "danger" | "warning" | "info";
  hint: string;
};

const CARDS: Card[] = [
  {
    key: "overdue",
    label: "Overdue",
    href: "/staff/production?overdue=true",
    tone: "danger",
    hint: "Past the due date and still live",
  },
  {
    key: "rework",
    label: "Rework required",
    href: "/staff/production?status=rework_required",
    tone: "danger",
    hint: "Failed inspection",
  },
  {
    key: "blocked",
    label: "Blocked",
    href: "/staff/production?scope=all&status=waiting_on_materials",
    tone: "warning",
    hint: "Waiting on a customer, materials, or held",
  },
  {
    key: "unassigned",
    label: "Unassigned",
    href: "/staff/production?assignedTo=unassigned",
    tone: "warning",
    hint: "Open work with nobody on it",
  },
  {
    key: "inQualityCheck",
    label: "In quality check",
    href: "/staff/production?status=quality_check",
    tone: "info",
    hint: "Made, awaiting inspection",
  },
  {
    key: "ready",
    label: "Ready to hand over",
    href: "/staff/production?status=ready_to_ship",
    tone: "info",
    hint: "Finished, awaiting pickup or shipping",
  },
];

const TONE_CLASS: Record<Card["tone"], string> = {
  danger: "text-rose-200",
  warning: "text-amber-200",
  info: "text-brand-textMuted",
};

export function ProductionDashboardPanel() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Refused, rather than broken. The dashboard already gates this panel on the
  // permission, so reaching here means the two disagreed — which is worth
  // saying plainly and quietly, not worth a red alert with a retry button.
  const [denied, setDenied] = useState(false);

  // Held across a refetch so the numbers on screen never blink to zero.
  const lastGood = useRef<Summary | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setDenied(false);
    try {
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const response = await fetch(`/api/staff/production/summary?today=${today}`, {
        credentials: "same-origin",
      });
      const body = await response.json().catch(() => null);
      if (response.status === 403) {
        setDenied(true);
        return;
      }
      if (!response.ok) throw new Error(body?.error || "Could not load production counts.");
      lastGood.current = body as Summary;
      setSummary(body as Summary);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load production counts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = summary ?? lastGood.current;

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Production</h2>
          <p className="mt-1 text-xs text-brand-textMuted">
            {shown ? `${shown.open} open job${shown.open === 1 ? "" : "s"}` : "Work in the shop"}
            {shown && shown.dueThisWeek ? ` · ${shown.dueThisWeek} due within 7 days` : ""}
            {loading && shown ? " · refreshing…" : ""}
          </p>
        </div>
        <Link href="/staff/production" className="text-xs font-medium text-brand-accent hover:underline">
          Open the queue
        </Link>
      </div>

      {denied ? (
        <EmptyState className="mt-5">
          <p className="font-medium">You do not have production access.</p>
          <p className="mt-1">Ask an administrator for the production.view permission.</p>
        </EmptyState>
      ) : null}

      {error ? (
        <Notice tone="danger" role="alert" className="mt-4">
          <p>{error}</p>
          <button
            type="button"
            className="ui-btn ui-btn-ghost mt-2 text-sm"
            onClick={() => void load()}
          >
            Try again
          </button>
        </Notice>
      ) : null}

      {!shown && loading && !denied ? (
        <EmptyState className="mt-5">Loading production counts…</EmptyState>
      ) : null}

      {shown ? (
        shown.open === 0 && shown.blocked === 0 ? (
          <EmptyState className="mt-5">
            <p className="font-medium">No production work open.</p>
            <p className="mt-1">Raise a job from an order, or create one for stock work.</p>
          </EmptyState>
        ) : (
          <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {CARDS.map((card) => {
              const value = shown[card.key];
              return (
                <li key={card.key}>
                  <Link
                    href={card.href}
                    className="ui-card ui-card-hover flex h-full flex-col justify-between gap-1 p-3"
                    // Zero is kept rather than hidden: a card that disappears
                    // when it reaches zero makes the grid jump every refresh,
                    // and "0 overdue" is information worth seeing.
                    aria-label={`${value} ${card.label.toLowerCase()} — ${card.hint}`}
                  >
                    <span className="text-xs text-brand-textMuted">{card.label}</span>
                    <span className={`text-2xl font-semibold tabular-nums ${value ? TONE_CLASS[card.tone] : ""}`}>
                      {value}
                    </span>
                    <span className="text-[11px] text-brand-textMuted">{card.hint}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </Panel>
  );
}
