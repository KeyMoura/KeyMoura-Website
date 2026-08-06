"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { ConsequentialAction, resultFromResponse } from "@/components/staff/ConsequentialAction";
import { Badge, EmptyState, Notice, Panel } from "@/components/ui/DesignSystem";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";

/**
 * Historical payment discrepancy review.
 *
 * Two production orders record money collected with no payment row behind them.
 * They predate the atomic payment accounting, which is what made the order
 * field and the payment rows move together.
 *
 * **This page never repairs anything.** It does not write a payment row, change
 * a total, or contact Stripe. The reason is stated on the page as well as here,
 * because it is the thing somebody reading it will most want to do: a missing
 * payment row is *not* proof that no payment was taken. It is at least as
 * likely that money genuinely changed hands and the record was never written —
 * exactly the bug that was later fixed. Writing a synthetic payment row to make
 * the report go green would put a fabricated financial record in the ledger,
 * indistinguishable from a real one forever after.
 *
 * What is recorded is a conclusion by a person, with the evidence beside it.
 */

type Discrepancy = {
  orderId: string;
  orderNumber: string;
  kind: "payment_total_mismatch" | "refund_total_mismatch";
  recordedCents: number;
  evidenceCents: number;
  reviewed: boolean;
  order: {
    orderNumber: string | null;
    productName: string | null;
    status: string | null;
    paymentStatus: string | null;
    orderKind: string | null;
    agreedPriceCents: number | null;
    amountPaidCents: number | null;
    amountRefundedCents: number | null;
    createdAt: string | null;
    hadStripeSession: boolean;
  };
  evidence: {
    paymentRows: number;
    paymentRowTotalCents: number;
    refundRows: number;
    statusHistory: { from: string | null; to: string; at: string }[];
  };
  review: {
    classification: string;
    status: string;
    explanation: string;
    reviewedAt: string;
    stale: boolean;
  } | null;
};

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; discrepancies: Discrepancy[]; canReview: boolean; note: string };

const money = (cents: number | null | undefined) => `$${((cents ?? 0) / 100).toFixed(2)}`;

const CLASSIFICATIONS = [
  { value: "test", label: "Test order", help: "Created while setting the shop up. No real money was involved." },
  { value: "manual", label: "Paid outside the site", help: "Money changed hands in person, by transfer, or another way this site never saw." },
  { value: "legacy", label: "Legacy accounting", help: "Predates the payment records; the total was written by an earlier code path." },
  { value: "unknown", label: "Still unknown", help: "Nobody has established what this is yet. Record it as unresolved." },
] as const;

export default function DiscrepanciesPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { data: access, isLoading } = useMeAccess();
  const permissions = new Set(access?.permissions ?? []);
  const canView = permissions.has("payments.discrepancy.review") || permissions.has("launch.readiness.view");
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;
    try {
      const response = await fetch("/api/staff/launch-readiness/discrepancies", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: "no-store",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setState({ kind: "error", message: body.error || "Discrepancies could not be read." });
        return;
      }
      const payload = (await response.json()) as {
        discrepancies: Discrepancy[];
        canReview: boolean;
        note?: string;
      };
      setState({
        kind: "ready",
        discrepancies: payload.discrepancies,
        canReview: payload.canReview,
        note: payload.note ?? "",
      });
    } catch {
      setState({ kind: "error", message: "Discrepancies could not be read. Check the connection and retry." });
    }
  }, [supabase]);

  useEffect(() => {
    if (!canView) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [canView, load]);

  if (isLoading) return <div className="ui-card text-sm text-brand-textMuted">Loading…</div>;
  if (!canView) {
    return <AccessDeniedCard message="This reads order-level payment records, so it needs the Review payment discrepancies permission." />;
  }

  const ready = state.kind === "ready" ? state : null;

  return (
    <main className="page-stack">
      <div>
        <p className="ui-eyebrow">Business</p>
        <h1 className="mt-1 text-3xl font-semibold">Payment discrepancies</h1>
        <p className="mt-2 max-w-2xl text-sm text-brand-textMuted">
          Orders whose recorded total and payment records disagree. Reviewing one records what you concluded;
          it changes no money.
        </p>
      </div>

      <Notice tone="warning">
        <strong>Nothing here repairs an order.</strong> This page never creates a payment record, changes a
        total, or contacts Stripe. A missing payment row is not proof that no payment was taken — it is at
        least as likely that money changed hands and the record was never written. Inventing one to make this
        page go green would put a fabricated financial record in the ledger.
      </Notice>

      {state.kind === "error" ? (
        <Notice tone="danger" role="alert">
          {state.message}
        </Notice>
      ) : null}

      {state.kind === "loading" ? <EmptyState>Reading order payment records…</EmptyState> : null}

      {ready && ready.discrepancies.length === 0 ? (
        <EmptyState>
          Every order&rsquo;s recorded total matches its payment records. That is a complete answer — the query
          succeeded and found none.
        </EmptyState>
      ) : null}

      {ready?.discrepancies.map((row) => (
        <Panel key={`${row.orderId}-${row.kind}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">
                <Link href={`/staff/orders/${row.orderId}`} className="inline-flex min-h-11 items-center text-brand-accent hover:underline">
                  {row.orderNumber}
                </Link>
                {row.order.productName ? <span className="text-brand-textMuted"> — {row.order.productName}</span> : null}
              </h2>
              <p className="mt-1 text-xs text-brand-textMuted">
                {row.order.orderKind === "direct_purchase" ? "Direct purchase" : "Custom request"}
                {row.order.createdAt ? ` · created ${new Date(row.order.createdAt).toLocaleDateString()}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge tone={row.review ? "success" : "warning"}>{row.review ? "Reviewed" : "Awaiting review"}</Badge>
              {row.review?.stale ? <Badge tone="warning">Numbers changed since</Badge> : null}
            </div>
          </div>

          <dl className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4 text-sm">
            <Fact label="Recorded as collected" value={money(row.recordedCents)} />
            <Fact label="Sum of payment records" value={money(row.evidenceCents)} />
            <Fact label="Payment records" value={String(row.evidence.paymentRows)} />
            <Fact label="Stripe session created" value={row.order.hadStripeSession ? "Yes" : "No"} />
            <Fact label="Agreed price" value={money(row.order.agreedPriceCents)} />
            <Fact label="Recorded refunded" value={money(row.order.amountRefundedCents)} />
            <Fact label="Order status" value={row.order.status ?? "—"} />
            <Fact label="Payment status" value={row.order.paymentStatus ?? "—"} />
          </dl>

          {row.evidence.statusHistory.length ? (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-semibold">
                Order history ({row.evidence.statusHistory.length} entries)
              </summary>
              <ul className="mt-2 space-y-1 text-xs text-brand-textMuted">
                {row.evidence.statusHistory.map((entry, index) => (
                  <li key={index}>
                    {new Date(entry.at).toLocaleString()} — {entry.from ? `${entry.from} → ` : ""}
                    {entry.to}
                  </li>
                ))}
              </ul>
            </details>
          ) : (
            <p className="mt-4 text-xs text-brand-textMuted">No status history was recorded for this order.</p>
          )}

          {row.review ? (
            <div className="mt-4 rounded-xl border border-zinc-800 bg-black/25 p-4">
              <p className="text-sm font-medium">
                Classified as{" "}
                {CLASSIFICATIONS.find((option) => option.value === row.review?.classification)?.label ??
                  row.review.classification}
                {row.review.status === "unresolved" ? " (unresolved)" : ""}
              </p>
              <p className="mt-2 whitespace-pre-line text-sm text-brand-textMuted">{row.review.explanation}</p>
              <p className="mt-2 text-xs text-brand-textMuted">
                Recorded {new Date(row.review.reviewedAt).toLocaleString()}
                {row.review.stale ? " — the amounts have moved since, so this conclusion describes different numbers." : ""}
              </p>
            </div>
          ) : null}

          {ready.canReview ? (
            <div className="mt-4">
              <ReviewControl row={row} onDone={() => void load()} />
            </div>
          ) : (
            <p className="mt-4 text-xs text-brand-textMuted">
              Recording a conclusion needs the Review payment discrepancies permission.
            </p>
          )}
        </Panel>
      ))}
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-brand-textMuted">{label}</dt>
      <dd className="mt-1 font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function ReviewControl({ row, onDone }: { row: Discrepancy; onDone: () => void }) {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [classification, setClassification] = useState<string>(row.review?.classification ?? "");
  const chosen = CLASSIFICATIONS.find((option) => option.value === classification);

  return (
    <div className="rounded-xl border border-zinc-800 bg-black/25 p-4">
      <label className="ui-label" htmlFor={`classification-${row.orderId}`}>
        What is this row?
      </label>
      <select
        id={`classification-${row.orderId}`}
        className="ui-input mt-2 max-w-md"
        value={classification}
        onChange={(event) => setClassification(event.target.value)}
      >
        <option value="">Choose a classification…</option>
        {CLASSIFICATIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {chosen ? <p className="mt-2 text-xs text-brand-textMuted">{chosen.help}</p> : null}

      <div className="mt-4">
        <ConsequentialAction
          label={row.review ? "Replace the recorded conclusion" : "Record a conclusion"}
          title="Record what you concluded?"
          confirmLabel="Record it"
          disabled={!classification}
          disabledReason="Choose a classification first."
          currentState={row.review ? "Reviewed" : "Awaiting review"}
          nextState={chosen?.label ?? "Reviewed"}
          summary={
            <>
              {row.orderNumber} records {money(row.recordedCents)} collected against{" "}
              {money(row.evidenceCents)} of payment records. Your conclusion is stored against those exact
              numbers, so a later reader can tell whether it still describes what they are looking at.
            </>
          }
          effects={{
            customer: null,
            financial:
              "Nothing. No payment record is created, no total is changed, and Stripe is not contacted. This records a conclusion only.",
            inventory: null,
            notification: "Recorded in the audit log with the classification and the amounts, but not your explanation.",
          }}
          reason={{
            label: "What did you conclude, and how do you know?",
            placeholder: "Test order made while setting up Stripe; no real card was charged.",
            required: true,
            minLength: 10,
            help: "Internal. Kept with the review so the next reader does not have to work it out again.",
          }}
          onConfirm={async (submission) => {
            const session = await supabase.auth.getSession();
            const token = session.data.session?.access_token;
            const response = await fetch("/api/staff/launch-readiness/discrepancies", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify({
                orderId: row.orderId,
                kind: row.kind,
                classification,
                explanation: submission.reason,
                unresolved: classification === "unknown",
                expectedRecordedCents: row.recordedCents,
                expectedEvidenceCents: row.evidenceCents,
              }),
            });
            const result = await resultFromResponse(response);
            if (result.ok) onDone();
            return result;
          }}
        />
      </div>
    </div>
  );
}
