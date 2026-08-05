"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import {
  CANCELLATION_LABELS,
  FULFILLMENT_LABELS,
  PAYMENT_LABELS,
  REFUND_LABELS,
  RETURN_LABELS,
  lifecycleLabel,
  returnRefundCents,
} from "@/lib/commerce/orderLifecycle";
import { Badge, EmptyState, Notice, cx } from "@/components/ui/DesignSystem";

/**
 * Every consequential lifecycle action for one order, in one place.
 *
 * The brief is explicit that these must not be scattered across unrelated
 * pages, and there is a practical reason: refunding sensibly means seeing the
 * production state, the fulfillment state and the remaining refundable amount
 * at the same moment. Splitting them across screens is how a full refund gets
 * issued on an order that already shipped.
 *
 * Three rules run through all of it:
 *
 * 1. **Nothing happens on selection.** Choosing a refund mode or typing an
 *    amount changes no state; an explicit, named button does.
 * 2. **Money is confirmed with its consequence spelled out**, including the
 *    exact figure and what the customer will be told.
 * 3. **Every submit disables its own control**, so a double click cannot send a
 *    second request. The server is idempotent as well — this is the courtesy,
 *    not the guarantee.
 */

const money = (cents: number) => `$${(Math.max(0, cents) / 100).toFixed(2)}`;
const input =
  "rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-sm outline-none focus:border-brand-accent";

type LifecycleLine = {
  order_item_id: string;
  product_name: string;
  unit_price_cents: number;
  quantity: number;
  returned_quantity: number;
  is_custom?: boolean;
};

type CancellationRequest = {
  id: string;
  status: string;
  reason_code: string;
  customer_note: string | null;
  decision_note: string | null;
  internal_note: string | null;
  refund_mode: string;
  refund_amount_cents: number | null;
  created_at: string;
  decided_at: string | null;
};

type ReturnItem = {
  id: string;
  product_name: string;
  unit_price_cents: number;
  requested_quantity: number;
  approved_quantity: number | null;
  received_quantity: number | null;
  restocked_quantity: number;
};

type ReturnRecord = {
  id: string;
  return_number: string;
  status: string;
  reason_code: string;
  customer_note: string | null;
  decision_note: string | null;
  internal_note: string | null;
  return_instructions: string | null;
  inspection_outcome: string | null;
  restock_decision: string;
  refund_decision: string;
  refund_amount_cents: number | null;
  created_at: string;
  order_return_items: ReturnItem[];
};

type RefundRecord = {
  id: string;
  status: string;
  amount_cents: number;
  requested_amount_cents: number | null;
  confirmed_amount_cents: number | null;
  reason: string;
  kind: string;
  source: string;
  failure_message: string | null;
  created_at: string;
  confirmed_at: string | null;
};

type InventoryAdjustment = {
  id: string;
  delta: number;
  quantity_before: number;
  quantity_after: number;
  reason: string;
  created_at: string;
};

type LifecyclePayload = {
  order: {
    id: string;
    status: string;
    payment_status: string;
    fulfillment_status: string;
    cancellation_status: string;
    return_status: string;
    fulfillment_method: string;
    amount_paid_cents: number;
    amount_refunded_cents: number;
    inventory_committed_at: string | null;
  };
  refundableCents: number;
  pendingRefundCents: number;
  productionStatus: string | null;
  lines: LifecycleLine[];
  cancellationRequests: CancellationRequest[];
  returns: ReturnRecord[];
  refunds: RefundRecord[];
  inventoryAdjustments: InventoryAdjustment[] | null;
  permissions: {
    canReviewCancellations: boolean;
    canReviewReturns: boolean;
    canIssueRefunds: boolean;
    canViewInventory: boolean;
  };
};

export function OrderLifecyclePanel({ orderId, productName }: { orderId: string; productName: string }) {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [data, setData] = useState<LifecyclePayload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);

  // Cancellation decision form
  const [decisionNote, setDecisionNote] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [refundMode, setRefundMode] = useState<"none" | "full" | "partial">("none");
  const [partialAmount, setPartialAmount] = useState("");
  const [restock, setRestock] = useState(true);
  const [restoreDiscount, setRestoreDiscount] = useState(true);

  // Manual refund form
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");

  const authHeaders = useCallback(async () => {
    const { data: session } = await supabase.auth.getSession();
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.session?.access_token ?? ""}`,
    };
  }, [supabase]);

  const load = useCallback(async () => {
    const response = await fetch(`/api/staff/orders/${orderId}/lifecycle`, { headers: await authHeaders() });
    if (response.status === 403) {
      setData(null);
      setError("");
      setLoading(false);
      return;
    }
    if (!response.ok) {
      setError("Could not load the order lifecycle.");
      setLoading(false);
      return;
    }
    setData((await response.json()) as LifecyclePayload);
    setLoading(false);
  }, [orderId, authHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = useCallback(
    async (url: string, body: Record<string, unknown>, key: string) => {
      setBusy(key);
      setError("");
      try {
        const response = await fetch(url, { method: "POST", headers: await authHeaders(), body: JSON.stringify(body) });
        const result = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          setError(result.error || "That action could not be completed.");
          await load();
          return false;
        }
        await load();
        return true;
      } finally {
        setBusy("");
      }
    },
    [authHeaders, load]
  );

  if (loading) return null;
  if (!data) return null;

  const { order, permissions } = data;
  const openRequest = data.cancellationRequests.find((request) => request.status === "pending") ?? null;
  const openReturn =
    data.returns.find((record) => !["denied", "closed", "completed"].includes(record.status)) ?? null;

  const partialCents = Math.round(Number(partialAmount || 0) * 100);
  const plannedRefund =
    refundMode === "full" ? data.refundableCents : refundMode === "partial" ? Math.max(0, partialCents) : 0;

  const decideCancellation = async (decision: "approve" | "deny") => {
    if (!openRequest) return;
    if (decision === "deny" && decisionNote.trim().length < 5) {
      setError("Give the customer a reason. They will see exactly what you write.");
      return;
    }
    if (decision === "approve" && plannedRefund > data.refundableCents) {
      setError(`Only ${money(data.refundableCents)} is left to refund on this order.`);
      return;
    }

    const consequence =
      decision === "deny"
        ? `Decline this cancellation?\n\nThe customer will be emailed and will see your reason:\n\n"${decisionNote.trim()}"\n\nThe order continues as normal.`
        : `Approve this cancellation?\n\n• The order becomes Cancelled and cannot be un-cancelled.\n• Refund: ${plannedRefund > 0 ? `${money(plannedRefund)} sent to the customer's card` : "none"}\n• Stock: ${restock ? "returned to inventory" : "left as-is"}\n• Discount code: ${restoreDiscount ? "released back to the customer" : "kept as used"}\n\nThe customer will be emailed.`;
    if (!window.confirm(consequence)) return;

    const ok = await post(
      `/api/staff/orders/${orderId}/cancellation`,
      {
        request_id: openRequest.id,
        decision,
        decision_note: decisionNote.trim(),
        internal_note: internalNote.trim(),
        refund_mode: decision === "approve" ? refundMode : "none",
        refund_amount_cents: refundMode === "partial" ? partialCents : undefined,
        restock_inventory: restock,
        restore_discount: restoreDiscount,
      },
      `cancel-${decision}`
    );
    if (ok) {
      setDecisionNote("");
      setInternalNote("");
      setRefundMode("none");
      setPartialAmount("");
    }
  };

  const issueRefund = async () => {
    const cents = Math.round(Number(refundAmount || 0) * 100);
    if (!Number.isInteger(cents) || cents < 1) {
      setError("Enter a refund amount.");
      return;
    }
    if (refundReason.trim().length < 3) {
      setError("Give the refund a reason.");
      return;
    }
    if (cents > data.refundableCents) {
      setError(`Only ${money(data.refundableCents)} is left to refund on this order.`);
      return;
    }
    if (
      !window.confirm(
        `Send ${money(cents)} back to the customer through Stripe?\n\n` +
          `• Remaining refundable after this: ${money(data.refundableCents - cents)}\n` +
          `• The customer will be emailed once Stripe confirms it.\n` +
          `• A refund cannot be taken back.`
      )
    )
      return;

    const ok = await post(
      `/api/staff/orders/${orderId}/refund`,
      {
        amount_cents: cents,
        reason: refundReason.trim(),
        // Ties every retry of this click to one refund. A new refund needs a
        // new amount or a fresh page, both of which change the key.
        idempotency_key: `${cents}-${data.order.amount_refunded_cents}-${data.pendingRefundCents}`,
      },
      "refund"
    );
    if (ok) {
      setRefundAmount("");
      setRefundReason("");
    }
  };

  const returnAction = async (record: ReturnRecord, action: string, body: Record<string, unknown> = {}) => {
    await post(`/api/staff/orders/${orderId}/returns/${record.id}`, { action, ...body }, `return-${action}`);
  };

  return (
    <section id="lifecycle" className="ui-card scroll-mt-5 lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="ui-eyebrow">Order lifecycle</p>
          <h2 className="mt-1 text-xl font-semibold">Cancellation, returns and refunds</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge>{lifecycleLabel(PAYMENT_LABELS, order.payment_status)}</Badge>
          <Badge>{lifecycleLabel(FULFILLMENT_LABELS, order.fulfillment_status)}</Badge>
          {order.cancellation_status !== "none" ? (
            <Badge tone="warning">{lifecycleLabel(CANCELLATION_LABELS, order.cancellation_status)}</Badge>
          ) : null}
          {order.return_status !== "none" ? (
            <Badge tone="warning">{lifecycleLabel(RETURN_LABELS, order.return_status)}</Badge>
          ) : null}
        </div>
      </div>

      {error ? (
        <Notice tone="danger" role="alert" className="mt-4">
          {error}
        </Notice>
      ) : null}

      {/* Financial position, stated before any button that changes it. */}
      <dl className="mt-4 grid gap-3 sm:grid-cols-4">
        <div className="ui-card !p-3">
          <dt className="text-[10px] uppercase tracking-wider text-brand-textMuted">Collected</dt>
          <dd className="mt-1 text-sm font-semibold">{money(order.amount_paid_cents)}</dd>
        </div>
        <div className="ui-card !p-3">
          <dt className="text-[10px] uppercase tracking-wider text-brand-textMuted">Refunded</dt>
          <dd className="mt-1 text-sm font-semibold text-rose-300">{money(order.amount_refunded_cents)}</dd>
        </div>
        <div className="ui-card !p-3">
          <dt className="text-[10px] uppercase tracking-wider text-brand-textMuted">In progress</dt>
          <dd className="mt-1 text-sm font-semibold text-amber-300">{money(data.pendingRefundCents)}</dd>
          <p className="text-[10px] text-brand-textMuted">Sent to Stripe, not yet confirmed</p>
        </div>
        <div className="ui-card !p-3">
          <dt className="text-[10px] uppercase tracking-wider text-brand-textMuted">Refundable now</dt>
          <dd className="mt-1 text-sm font-semibold text-emerald-300">{money(data.refundableCents)}</dd>
        </div>
      </dl>

      {/* ---- Cancellation ---------------------------------------------- */}
      {openRequest ? (
        <div className="mt-6 rounded-2xl border border-amber-500/50 bg-amber-500/10 p-5">
          <h3 className="font-semibold">Cancellation request awaiting your decision</h3>
          <p className="mt-1 text-sm text-brand-textMuted">
            Reason: {openRequest.reason_code.replaceAll("_", " ")} · requested{" "}
            {new Date(openRequest.created_at).toLocaleString()}
          </p>
          {openRequest.customer_note ? (
            <p className="mt-3 whitespace-pre-wrap rounded-xl border border-zinc-700 bg-black/30 p-3 text-sm">
              {openRequest.customer_note}
            </p>
          ) : null}

          <p className="mt-3 text-xs text-brand-textMuted">
            Production is <strong>{data.productionStatus ? data.productionStatus.replaceAll("_", " ") : "not started"}</strong> and
            fulfillment is <strong>{lifecycleLabel(FULFILLMENT_LABELS, order.fulfillment_status)}</strong>. Check both before approving.
          </p>

          {!permissions.canReviewCancellations ? (
            <Notice tone="warning" className="mt-4">
              Deciding this needs the <code>cancellations.review</code> permission.
            </Notice>
          ) : (
            <>
              <div className="mt-4 grid gap-3">
                <label className="text-sm">
                  Reason for the customer
                  <textarea
                    value={decisionNote}
                    onChange={(event) => setDecisionNote(event.target.value)}
                    maxLength={2000}
                    className={`${input} mt-1 min-h-20 w-full`}
                    placeholder="The customer sees this exactly as written. Required to decline."
                  />
                </label>
                <label className="text-sm">
                  Internal note
                  <textarea
                    value={internalNote}
                    onChange={(event) => setInternalNote(event.target.value)}
                    maxLength={2000}
                    className={`${input} mt-1 min-h-16 w-full`}
                    placeholder="Never shown to the customer."
                  />
                </label>
              </div>

              <fieldset className="mt-4">
                <legend className="text-sm font-medium">Refund</legend>
                <div className="mt-2 flex flex-wrap gap-4">
                  {(["none", "full", "partial"] as const).map((mode) => (
                    <label key={mode} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="cancellation-refund-mode"
                        value={mode}
                        checked={refundMode === mode}
                        onChange={() => setRefundMode(mode)}
                      />
                      {mode === "none" ? "No refund" : mode === "full" ? `Full (${money(data.refundableCents)})` : "Partial"}
                    </label>
                  ))}
                </div>
                {refundMode === "partial" ? (
                  <label className="mt-3 block text-sm">
                    Partial amount ($)
                    <input
                      type="number"
                      min="0.01"
                      step=".01"
                      max={data.refundableCents / 100}
                      value={partialAmount}
                      onChange={(event) => setPartialAmount(event.target.value)}
                      className={`${input} mt-1 w-40`}
                    />
                  </label>
                ) : null}
                {refundMode !== "none" && !permissions.canIssueRefunds ? (
                  <Notice tone="warning" className="mt-3">
                    Approving with a refund needs the <code>refunds.issue</code> permission.
                  </Notice>
                ) : null}
              </fieldset>

              <div className="mt-4 flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={restock} onChange={(event) => setRestock(event.target.checked)} />
                  Return stock to inventory
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={restoreDiscount}
                    onChange={(event) => setRestoreDiscount(event.target.checked)}
                  />
                  Release the discount code back to the customer
                </label>
              </div>

              {/* The financial effect, stated before the button that causes it. */}
              <p className="mt-4 rounded-xl border border-zinc-700 bg-black/30 p-3 text-xs">
                Approving will refund <strong>{money(plannedRefund)}</strong>, leaving{" "}
                <strong>{money(Math.max(0, data.refundableCents - plannedRefund))}</strong> refundable. The order becomes
                Cancelled and the customer is emailed.
              </p>

              <div className="ui-action-row mt-4">
                <button
                  type="button"
                  disabled={Boolean(busy) || decisionNote.trim().length < 5}
                  onClick={() => void decideCancellation("deny")}
                  className="ui-btn ui-btn-secondary disabled:opacity-40"
                >
                  {busy === "cancel-deny" ? "Declining…" : "Decline request"}
                </button>
                <button
                  type="button"
                  disabled={Boolean(busy) || (refundMode !== "none" && !permissions.canIssueRefunds)}
                  onClick={() => void decideCancellation("approve")}
                  className="ui-btn ui-btn-danger disabled:opacity-40"
                >
                  {busy === "cancel-approve" ? "Approving…" : "Approve cancellation"}
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* ---- Returns ---------------------------------------------------- */}
      {openReturn ? (
        <ReturnWorkflow
          record={openReturn}
          busy={busy}
          canReview={permissions.canReviewReturns}
          canRefund={permissions.canIssueRefunds}
          refundableCents={data.refundableCents}
          onAction={returnAction}
        />
      ) : null}

      {/* ---- Manual refund ---------------------------------------------- */}
      {permissions.canIssueRefunds && data.refundableCents > 0 ? (
        <div className="mt-6 rounded-2xl border border-rose-500/40 bg-rose-500/5 p-5">
          <h3 className="font-semibold">Issue a refund</h3>
          <p className="mt-1 text-xs text-brand-textMuted">
            Sends money back through Stripe. The refund is only marked complete when Stripe confirms it, which can take a
            moment — until then it shows as in progress and the amount is held back from what is refundable.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-[160px_1fr_auto]">
            <label className="text-sm">
              Amount ($)
              <input
                className={`${input} mt-1 w-full`}
                type="number"
                min="0.01"
                max={data.refundableCents / 100}
                step=".01"
                value={refundAmount}
                onChange={(event) => setRefundAmount(event.target.value)}
              />
            </label>
            <label className="text-sm">
              Reason
              <input
                className={`${input} mt-1 w-full`}
                value={refundReason}
                onChange={(event) => setRefundReason(event.target.value)}
                placeholder="Why is this refund being issued?"
              />
            </label>
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void issueRefund()}
              className="ui-btn ui-btn-danger self-end disabled:opacity-40"
            >
              {busy === "refund" ? "Sending…" : "Review & refund"}
            </button>
          </div>
        </div>
      ) : null}

      {/* ---- History ---------------------------------------------------- */}
      {data.refunds.length ? (
        <div className="mt-6">
          <h3 className="text-sm font-semibold">Refunds</h3>
          <ul className="mt-2 divide-y divide-white/10">
            {data.refunds.map((refund) => (
              <li key={refund.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                <span>
                  {money(refund.confirmed_amount_cents ?? refund.requested_amount_cents ?? refund.amount_cents)}{" "}
                  <span className="text-xs text-brand-textMuted">
                    · {refund.kind}
                    {refund.source === "stripe_dashboard" ? " · created in Stripe" : ""} ·{" "}
                    {new Date(refund.created_at).toLocaleString()}
                  </span>
                </span>
                <Badge
                  tone={
                    refund.status === "succeeded"
                      ? "success"
                      : refund.status === "pending"
                        ? "warning"
                        : "danger"
                  }
                >
                  {lifecycleLabel(REFUND_LABELS, refund.status)}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {data.inventoryAdjustments && data.inventoryAdjustments.length ? (
        <div className="mt-6">
          <h3 className="text-sm font-semibold">Inventory impact</h3>
          <ul className="mt-2 divide-y divide-white/10">
            {data.inventoryAdjustments.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-xs">
                <span>
                  {row.delta > 0 ? `+${row.delta}` : row.delta} · {row.reason.replaceAll("_", " ")} ·{" "}
                  {row.quantity_before} → {row.quantity_after}
                </span>
                <time className="text-brand-textMuted">{new Date(row.created_at).toLocaleString()}</time>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!openRequest && !openReturn && !data.refunds.length ? (
        <EmptyState className="mt-6">
          No cancellation, return or refund activity on {productName}.
        </EmptyState>
      ) : null}
    </section>
  );
}

/**
 * The return's own stage machine, rendered as one action at a time.
 *
 * A dropdown of every state would let a return jump from "requested" straight
 * to "inspected", skipping the receipt that proves the parcel actually
 * arrived. Showing only the next legal move makes that unreachable from the UI
 * as well as from the API.
 */
function ReturnWorkflow({
  record,
  busy,
  canReview,
  canRefund,
  refundableCents,
  onAction,
}: {
  record: ReturnRecord;
  busy: string;
  canReview: boolean;
  canRefund: boolean;
  refundableCents: number;
  onAction: (record: ReturnRecord, action: string, body?: Record<string, unknown>) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [instructions, setInstructions] = useState("");
  const [outcome, setOutcome] = useState("as_described");
  const [restock, setRestock] = useState(false);
  const [refundMode, setRefundMode] = useState<"none" | "full" | "partial">("none");
  const [partial, setPartial] = useState("");

  const receivedValue = returnRefundCents(
    record.order_return_items.map((item) => ({
      unit_price_cents: item.unit_price_cents,
      quantity: item.received_quantity ?? item.approved_quantity ?? item.requested_quantity,
    }))
  );
  const plannedRefund =
    refundMode === "full"
      ? Math.min(receivedValue, refundableCents)
      : refundMode === "partial"
        ? Math.round(Number(partial || 0) * 100)
        : 0;

  return (
    <div className="mt-6 rounded-2xl border border-sky-500/40 bg-sky-500/5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">
          Return {record.return_number}{" "}
          <span className="text-sm font-normal text-brand-textMuted">
            · {record.reason_code.replaceAll("_", " ")}
          </span>
        </h3>
        <Badge tone="warning">{lifecycleLabel(RETURN_LABELS, record.status)}</Badge>
      </div>

      {record.customer_note ? (
        <p className="mt-3 whitespace-pre-wrap rounded-xl border border-zinc-700 bg-black/30 p-3 text-sm">
          {record.customer_note}
        </p>
      ) : null}

      <ul className="mt-3 divide-y divide-white/10 text-sm">
        {record.order_return_items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>{item.product_name}</span>
            <span className="text-xs text-brand-textMuted">
              requested {item.requested_quantity}
              {item.approved_quantity != null ? ` · approved ${item.approved_quantity}` : ""}
              {item.received_quantity != null ? ` · received ${item.received_quantity}` : ""}
              {item.restocked_quantity > 0 ? ` · restocked ${item.restocked_quantity}` : ""} ·{" "}
              {money(item.unit_price_cents)} each
            </span>
          </li>
        ))}
      </ul>

      {!canReview ? (
        <Notice tone="warning" className="mt-4">
          Acting on this return needs the <code>returns.review</code> permission.
        </Notice>
      ) : (
        <>
          {["requested", "under_review"].includes(record.status) ? (
            <div className="mt-4 grid gap-3">
              <label className="text-sm">
                Reason for the customer
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={2000}
                  className={`${input} mt-1 min-h-16 w-full`}
                  placeholder="Required to decline. The customer sees this exactly as written."
                />
              </label>
              <label className="text-sm">
                Return instructions
                <textarea
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  maxLength={4000}
                  className={`${input} mt-1 min-h-16 w-full`}
                  placeholder="Where to send it and how to pack it. Leave blank to use the shop default."
                />
              </label>
              <div className="ui-action-row">
                <button
                  type="button"
                  disabled={Boolean(busy) || note.trim().length < 5}
                  onClick={() => {
                    if (!window.confirm("Decline this return? The customer will be emailed your reason.")) return;
                    void onAction(record, "deny", { decision_note: note.trim() });
                  }}
                  className="ui-btn ui-btn-secondary disabled:opacity-40"
                >
                  Decline return
                </button>
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    if (!window.confirm("Approve this return?\n\nThe customer will be emailed the return instructions. No refund is issued yet — that happens after inspection."))
                      return;
                    void onAction(record, "approve", { decision_note: note.trim(), instructions: instructions.trim() });
                  }}
                  className="ui-btn ui-btn-primary disabled:opacity-40"
                >
                  Approve return
                </button>
              </div>
            </div>
          ) : null}

          {["approved", "awaiting_shipment", "in_transit"].includes(record.status) ? (
            <div className="ui-action-row mt-4">
              {record.status === "approved" ? (
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void onAction(record, "await_shipment")}
                  className="ui-btn ui-btn-secondary disabled:opacity-40"
                >
                  Waiting for the parcel
                </button>
              ) : null}
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void onAction(record, "receive")}
                className="ui-btn ui-btn-primary disabled:opacity-40"
              >
                Mark received
              </button>
            </div>
          ) : null}

          {record.status === "received" ? (
            <div className="mt-4 grid gap-3">
              <label className="text-sm">
                Inspection outcome
                <select
                  value={outcome}
                  onChange={(event) => setOutcome(event.target.value)}
                  className={`${input} mt-1 w-full`}
                >
                  <option value="as_described">As described</option>
                  <option value="minor_damage">Minor damage</option>
                  <option value="major_damage">Major damage</option>
                  <option value="not_as_described">Not as described</option>
                  <option value="missing_parts">Missing parts</option>
                  <option value="wrong_item_returned">Wrong item returned</option>
                </select>
              </label>
              <label className="text-sm">
                Inspection note
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={2000}
                  className={`${input} mt-1 min-h-16 w-full`}
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={restock} onChange={(event) => setRestock(event.target.checked)} />
                Return these units to sellable stock
              </label>
              <fieldset>
                <legend className="text-sm font-medium">Refund</legend>
                <div className="mt-2 flex flex-wrap gap-4">
                  {(["none", "full", "partial"] as const).map((mode) => (
                    <label key={mode} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name={`return-refund-${record.id}`}
                        checked={refundMode === mode}
                        onChange={() => setRefundMode(mode)}
                      />
                      {mode === "none"
                        ? "No refund"
                        : mode === "full"
                          ? `Returned value (${money(Math.min(receivedValue, refundableCents))})`
                          : "Partial"}
                    </label>
                  ))}
                </div>
                {refundMode === "partial" ? (
                  <input
                    type="number"
                    min="0.01"
                    step=".01"
                    max={refundableCents / 100}
                    value={partial}
                    onChange={(event) => setPartial(event.target.value)}
                    className={`${input} mt-3 w-40`}
                    aria-label="Partial refund amount in dollars"
                  />
                ) : null}
                {refundMode !== "none" && !canRefund ? (
                  <Notice tone="warning" className="mt-3">
                    Refunding a return needs the <code>refunds.issue</code> permission.
                  </Notice>
                ) : null}
              </fieldset>
              <p className={cx("rounded-xl border border-zinc-700 bg-black/30 p-3 text-xs")}>
                Completing this will refund <strong>{money(plannedRefund)}</strong> and{" "}
                {restock ? "return the received units to stock" : "leave stock unchanged"}.
              </p>
              <button
                type="button"
                disabled={Boolean(busy) || (refundMode !== "none" && !canRefund)}
                onClick={() => {
                  if (
                    !window.confirm(
                      `Complete this inspection?\n\n• Refund: ${plannedRefund > 0 ? money(plannedRefund) : "none"}\n• Stock: ${restock ? "returned to inventory" : "unchanged"}\n\nThe customer will be emailed.`
                    )
                  )
                    return;
                  void onAction(record, "inspect", {
                    inspection_outcome: outcome,
                    inspection_note: note.trim(),
                    restock,
                    refund_mode: refundMode,
                    refund_amount_cents: refundMode === "partial" ? Math.round(Number(partial || 0) * 100) : undefined,
                  });
                }}
                className="ui-btn ui-btn-primary disabled:opacity-40"
              >
                {busy === "return-inspect" ? "Recording…" : "Record inspection"}
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
