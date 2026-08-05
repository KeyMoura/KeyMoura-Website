"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import {
  CANCELLATION_LABELS,
  REFUND_LABELS,
  RETURN_LABELS,
  lifecycleLabel,
  type CancellationEligibility,
  type ReturnEligibility,
  type ReturnableLine,
} from "@/lib/commerce/orderLifecycle";
import { Badge, Notice } from "@/components/ui/DesignSystem";

/**
 * What the customer can do with their order: cancel it, ask to cancel it,
 * withdraw that request, or start a return — and, when they cannot, why not.
 *
 * The eligibility shown here is computed by the server and re-checked by every
 * write path. Hiding a button is a courtesy; the rule lives behind the API.
 *
 * Deliberately absent: internal notes, staff names, Stripe identifiers,
 * production detail, cost data. The endpoint this reads does not return them,
 * which is a stronger guarantee than remembering not to render them.
 */

const money = (cents: number) => `$${(Math.max(0, cents) / 100).toFixed(2)}`;
const field =
  "w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-sm outline-none focus:border-brand-accent";

type ReasonOption = { code: string; label: string };

type CancellationRequestRecord = {
  id: string;
  status: string;
  reason_code: string;
  customer_note: string | null;
  decision_note: string | null;
  created_at: string;
  decided_at: string | null;
  refund_amount_cents: number | null;
};

type ReturnRecord = {
  id: string;
  return_number: string;
  status: string;
  decision_note: string | null;
  return_instructions: string | null;
  return_address: Record<string, string> | null;
  created_at: string;
  order_return_items: { id: string; product_name: string; requested_quantity: number }[];
};

type RefundRecord = {
  id: string;
  status: string;
  amount_cents: number;
  confirmed_amount_cents: number | null;
  requested_amount_cents: number | null;
  customer_note: string | null;
  created_at: string;
};

type LifecyclePayload = {
  headline: string;
  state: {
    status: string;
    payment_status: string;
    fulfillment_status: string;
    cancellation_status: string;
    return_status: string;
    fulfillment_method: string;
  };
  money: {
    amount_paid_cents: number;
    amount_refunded_cents: number;
    pending_refund_cents: number;
  };
  cancellation: {
    eligibility: CancellationEligibility;
    reasons: readonly ReasonOption[];
    requests: CancellationRequestRecord[];
  };
  returns: {
    eligibility: ReturnEligibility;
    reasons: readonly ReasonOption[];
    records: ReturnRecord[];
    policyText: string;
    customerPaysReturnShipping: boolean;
  };
  refunds: RefundRecord[];
};

export function OrderLifecycleActions({ orderId, onChanged }: { orderId: string; onChanged?: () => void }) {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [data, setData] = useState<LifecyclePayload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [panel, setPanel] = useState<"none" | "cancel" | "return">("none");

  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  const authHeaders = useCallback(async () => {
    const { data: session } = await supabase.auth.getSession();
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.session?.access_token ?? ""}`,
    };
  }, [supabase]);

  const load = useCallback(async () => {
    const response = await fetch(`/api/orders/${orderId}/lifecycle`, { headers: await authHeaders() });
    if (!response.ok) return;
    setData((await response.json()) as LifecyclePayload);
  }, [orderId, authHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return null;

  const cancellation = data.cancellation.eligibility;
  const returns = data.returns.eligibility;
  const openRequest = data.cancellation.requests.find((request) => request.status === "pending") ?? null;
  const latestDecided = data.cancellation.requests.find((request) => ["denied", "withdrawn"].includes(request.status));

  const submitCancellation = async () => {
    if (!reason) {
      setError("Choose a reason.");
      return;
    }
    const immediate = cancellation.kind === "immediate";
    const message = immediate
      ? "Cancel this order?\n\nNothing has been charged, so there is nothing to refund. This cannot be undone."
      : "Send this cancellation request?\n\nThe team will review it. Approving a cancellation is not automatic, and any refund is decided as part of that review.";
    if (!window.confirm(message)) return;

    setBusy("cancel");
    setError("");
    try {
      const response = await fetch(`/api/orders/${orderId}/cancellation`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ reason_code: reason, note: note.trim(), confirm: true }),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(result.error || "That could not be submitted.");
      } else {
        setPanel("none");
        setReason("");
        setNote("");
        onChanged?.();
      }
      await load();
    } finally {
      setBusy("");
    }
  };

  const withdraw = async () => {
    if (!window.confirm("Withdraw your cancellation request?\n\nThe order will carry on as normal.")) return;
    setBusy("withdraw");
    setError("");
    try {
      const response = await fetch(`/api/orders/${orderId}/cancellation`, {
        method: "DELETE",
        headers: await authHeaders(),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) setError(result.error || "That could not be withdrawn.");
      else onChanged?.();
      await load();
    } finally {
      setBusy("");
    }
  };

  const submitReturn = async () => {
    if (returns.kind !== "eligible") return;
    if (!reason) {
      setError("Choose a reason.");
      return;
    }
    const items = returns.lines
      .map((line) => ({ order_item_id: line.order_item_id, quantity: quantities[line.order_item_id] ?? 0 }))
      .filter((entry) => entry.quantity > 0);
    if (!items.length) {
      setError("Choose at least one item to return.");
      return;
    }
    if (
      !window.confirm(
        "Send this return request?\n\nThe team will review it and send instructions if it is approved. Please keep the item until you hear back — requesting a return does not guarantee one."
      )
    )
      return;

    setBusy("return");
    setError("");
    try {
      const response = await fetch(`/api/orders/${orderId}/returns`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ reason_code: reason, note: note.trim(), items, confirm: true }),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(result.error || "That could not be submitted.");
      } else {
        setPanel("none");
        setReason("");
        setNote("");
        setQuantities({});
        onChanged?.();
      }
      await load();
    } finally {
      setBusy("");
    }
  };

  const activeReturn = data.returns.records.find(
    (record) => !["denied", "closed", "completed"].includes(record.status)
  );

  return (
    <section className="ui-card mt-6" aria-labelledby="lifecycle-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="ui-eyebrow">Order actions</p>
          <h2 id="lifecycle-heading" className="mt-1 text-xl font-semibold">
            Cancel or return
          </h2>
        </div>
        {data.state.cancellation_status !== "none" ? (
          <Badge tone="warning">{lifecycleLabel(CANCELLATION_LABELS, data.state.cancellation_status)}</Badge>
        ) : null}
        {data.state.return_status !== "none" ? (
          <Badge tone="warning">{lifecycleLabel(RETURN_LABELS, data.state.return_status)}</Badge>
        ) : null}
      </div>

      {error ? (
        <Notice tone="danger" role="alert" className="mt-4">
          {error}
        </Notice>
      ) : null}

      {/* ---- Refund progress -------------------------------------------- */}
      {data.money.amount_refunded_cents > 0 || data.money.pending_refund_cents > 0 ? (
        <div className="mt-4 rounded-xl border border-zinc-800 bg-black/30 p-4 text-sm">
          <h3 className="font-medium">Refunds</h3>
          <ul className="mt-2 space-y-2">
            {data.refunds.map((refund) => (
              <li key={refund.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {money(refund.confirmed_amount_cents ?? refund.requested_amount_cents ?? refund.amount_cents)}
                  <time className="ml-2 text-xs text-brand-textMuted">
                    {new Date(refund.created_at).toLocaleDateString()}
                  </time>
                </span>
                <Badge tone={refund.status === "succeeded" ? "success" : refund.status === "pending" ? "warning" : "danger"}>
                  {lifecycleLabel(REFUND_LABELS, refund.status)}
                </Badge>
              </li>
            ))}
          </ul>
          {data.money.pending_refund_cents > 0 ? (
            <p className="mt-3 text-xs text-brand-textMuted">
              A refund in progress has been sent to your bank. Banks usually take a few business days to post it.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ---- Open cancellation request ---------------------------------- */}
      {openRequest ? (
        <div className="mt-4 rounded-xl border border-amber-500/50 bg-amber-500/10 p-4">
          <h3 className="font-medium">Cancellation requested</h3>
          <p className="mt-1 text-sm text-brand-textMuted">
            Sent {new Date(openRequest.created_at).toLocaleString()}. The team will review it and email you the outcome.
          </p>
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void withdraw()}
            className="ui-btn ui-btn-secondary mt-3 disabled:opacity-40"
          >
            {busy === "withdraw" ? "Withdrawing…" : "Withdraw request"}
          </button>
        </div>
      ) : null}

      {latestDecided?.status === "denied" && latestDecided.decision_note ? (
        <div className="mt-4 rounded-xl border border-zinc-700 bg-black/30 p-4">
          <h3 className="font-medium">Cancellation declined</h3>
          <p className="mt-1 whitespace-pre-wrap text-sm text-brand-textMuted">{latestDecided.decision_note}</p>
        </div>
      ) : null}

      {/* ---- Active return ---------------------------------------------- */}
      {activeReturn ? (
        <div className="mt-4 rounded-xl border border-sky-500/40 bg-sky-500/10 p-4">
          <h3 className="font-medium">
            Return {activeReturn.return_number} — {lifecycleLabel(RETURN_LABELS, activeReturn.status)}
          </h3>
          <ul className="mt-2 text-sm text-brand-textMuted">
            {activeReturn.order_return_items.map((item) => (
              <li key={item.id}>
                {item.requested_quantity} × {item.product_name}
              </li>
            ))}
          </ul>
          {activeReturn.decision_note ? (
            <p className="mt-3 whitespace-pre-wrap text-sm">{activeReturn.decision_note}</p>
          ) : null}
          {activeReturn.return_instructions ? (
            <div className="mt-3 rounded-lg border border-zinc-700 bg-black/30 p-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-brand-textMuted">
                Return instructions
              </h4>
              <p className="mt-1 whitespace-pre-wrap text-sm">{activeReturn.return_instructions}</p>
              {activeReturn.return_address ? (
                <address className="mt-2 not-italic text-sm">
                  {Object.values(activeReturn.return_address).map((line, index) => (
                    <span key={index} className="block">
                      {line}
                    </span>
                  ))}
                </address>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ---- Cancel ------------------------------------------------------ */}
      {!openRequest && (cancellation.kind === "immediate" || cancellation.kind === "request") ? (
        panel === "cancel" ? (
          <div className="mt-4 rounded-xl border border-zinc-700 bg-black/30 p-4">
            <h3 className="font-medium">
              {cancellation.kind === "immediate" ? "Cancel this order" : "Request a cancellation"}
            </h3>
            {cancellation.kind === "request" ? (
              <p className="mt-1 text-sm text-brand-textMuted">{cancellation.note}</p>
            ) : null}
            <label className="mt-3 block text-sm">
              Why are you cancelling?
              <select value={reason} onChange={(event) => setReason(event.target.value)} className={`${field} mt-1`}>
                <option value="">Choose a reason…</option>
                {data.cancellation.reasons.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-3 block text-sm">
              Anything else? <span className="text-brand-textMuted">(optional)</span>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={2000}
                className={`${field} mt-1 min-h-20`}
              />
            </label>
            <div className="ui-action-row mt-4">
              <button type="button" onClick={() => setPanel("none")} className="ui-btn ui-btn-secondary">
                Keep my order
              </button>
              <button
                type="button"
                disabled={Boolean(busy) || !reason}
                onClick={() => void submitCancellation()}
                className="ui-btn ui-btn-danger disabled:opacity-40"
              >
                {busy === "cancel"
                  ? "Submitting…"
                  : cancellation.kind === "immediate"
                    ? "Cancel order"
                    : "Send request"}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setPanel("cancel");
              setReason("");
              setNote("");
            }}
            className="ui-btn ui-btn-secondary mt-4"
          >
            {cancellation.kind === "immediate" ? "Cancel order" : "Request cancellation"}
          </button>
        )
      ) : null}

      {cancellation.kind === "unavailable" && !activeReturn && data.state.status !== "cancelled" ? (
        <p className="mt-4 text-sm text-brand-textMuted">{cancellation.reason}</p>
      ) : null}

      {/* ---- Return ------------------------------------------------------ */}
      {returns.kind === "eligible" ? (
        panel === "return" ? (
          <div className="mt-4 rounded-xl border border-zinc-700 bg-black/30 p-4">
            <h3 className="font-medium">Start a return</h3>
            <p className="mt-1 text-sm text-brand-textMuted">
              Choose what you want to send back. Requesting a return is not the same as it being approved — we will
              review it and email you either way.
              {data.returns.customerPaysReturnShipping ? " Return postage is the customer's responsibility." : ""}
            </p>
            <fieldset className="mt-3">
              <legend className="text-sm font-medium">Items</legend>
              <ul className="mt-2 space-y-2">
                {returns.lines.map((line: ReturnableLine) => (
                  <li key={line.order_item_id} className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-sm">
                      {line.product_name}
                      <span className="ml-2 text-xs text-brand-textMuted">
                        up to {line.quantity} · {money(line.unit_price_cents)} each
                      </span>
                    </span>
                    <label className="text-xs">
                      <span className="sr-only">Quantity of {line.product_name} to return</span>
                      <input
                        type="number"
                        min={0}
                        max={line.quantity}
                        value={quantities[line.order_item_id] ?? 0}
                        onChange={(event) =>
                          setQuantities((current) => ({
                            ...current,
                            [line.order_item_id]: Math.max(
                              0,
                              Math.min(line.quantity, Number(event.target.value) || 0)
                            ),
                          }))
                        }
                        className={`${field} w-20`}
                      />
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
            <label className="mt-3 block text-sm">
              What is the problem?
              <select value={reason} onChange={(event) => setReason(event.target.value)} className={`${field} mt-1`}>
                <option value="">Choose a reason…</option>
                {data.returns.reasons.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-3 block text-sm">
              Tell us more <span className="text-brand-textMuted">(optional)</span>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={2000}
                className={`${field} mt-1 min-h-20`}
              />
            </label>
            <div className="ui-action-row mt-4">
              <button type="button" onClick={() => setPanel("none")} className="ui-btn ui-btn-secondary">
                Never mind
              </button>
              <button
                type="button"
                disabled={Boolean(busy) || !reason}
                onClick={() => void submitReturn()}
                className="ui-btn ui-btn-primary disabled:opacity-40"
              >
                {busy === "return" ? "Submitting…" : "Send return request"}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setPanel("return");
              setReason("");
              setNote("");
              setQuantities(
                Object.fromEntries(returns.lines.map((line) => [line.order_item_id, line.quantity]))
              );
            }}
            className="ui-btn ui-btn-secondary mt-4"
          >
            Start a return
          </button>
        )
      ) : null}

      {returns.kind === "unavailable" && !activeReturn && data.state.fulfillment_status === "delivered" ? (
        <p className="mt-4 text-sm text-brand-textMuted">{returns.reason}</p>
      ) : null}

      {data.returns.policyText ? (
        <p className="mt-4 whitespace-pre-wrap text-xs text-brand-textMuted">{data.returns.policyText}</p>
      ) : null}
    </section>
  );
}
