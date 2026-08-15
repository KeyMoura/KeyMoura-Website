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
import {
  ConsequentialAction,
  resultFromResponse,
  type ActionResult,
} from "@/components/staff/ConsequentialAction";

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
/* The shared input primitive, so the lifecycle forms match every other form
   and follow the Border and Input background appearance settings. */
const input = "ui-input text-sm";

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

/**
 * Which half of this panel to render.
 *
 * The order workspace is tabbed now, and this component covers two of those
 * tabs: the money position and the refund control belong on **Payment**, the
 * cancellation decision and the return workflow on **Returns & cancellations**.
 * Rendering the whole panel on both would put the financial summary on screen
 * twice and give a reader two places to issue the same refund from.
 *
 * `"all"` stays the default so any caller that has not been tabbed keeps the
 * behaviour it had.
 */
export type LifecycleView = "all" | "money" | "lifecycle";

export function OrderLifecyclePanel({
  orderId,
  productName,
  view = "all",
}: {
  orderId: string;
  productName: string;
  view?: LifecycleView;
}) {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [data, setData] = useState<LifecyclePayload | null>(null);
  const [error, setError] = useState("");
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

  // Deferred a tick rather than called in the effect body, matching the other
  // staff panels: the load settles state asynchronously, and calling it
  // synchronously here makes the first paint a cascading render.
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  /**
   * One POST, one `ActionResult`.
   *
   * The panel no longer keeps its own error string for these — the dialog that
   * asked the question shows the answer, including a 409, which it holds in
   * place rather than closing over. Reloading the panel on failure was actively
   * unhelpful: it wiped the form the operator was mid-way through and left the
   * message somewhere else on the page.
   */
  const post = useCallback(
    async (url: string, body: Record<string, unknown>): Promise<ActionResult> => {
      const response = await fetch(url, { method: "POST", headers: await authHeaders(), body: JSON.stringify(body) });
      const result = await resultFromResponse(response);
      if (result.ok) await load();
      return result;
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

  const decideCancellation = async (
    decision: "approve" | "deny",
    notes: { reason: string; internalNote: string }
  ): Promise<ActionResult> => {
    if (!openRequest) return { ok: false, error: "This request is no longer open." };
    if (decision === "approve" && plannedRefund > data.refundableCents) {
      return { ok: false, error: `Only ${money(data.refundableCents)} is left to refund on this order.` };
    }

    const result = await post(`/api/staff/orders/${orderId}/cancellation`, {
      request_id: openRequest.id,
      decision,
      decision_note: notes.reason,
      internal_note: notes.internalNote,
      refund_mode: decision === "approve" ? refundMode : "none",
      refund_amount_cents: refundMode === "partial" ? partialCents : undefined,
      restock_inventory: restock,
      restore_discount: restoreDiscount,
    });
    if (result.ok) {
      setDecisionNote("");
      setInternalNote("");
      setRefundMode("none");
      setPartialAmount("");
    }
    return result;
  };

  const issueRefund = async (notes: { reason: string; internalNote: string }): Promise<ActionResult> => {
    const cents = Math.round(Number(refundAmount || 0) * 100);
    if (!Number.isInteger(cents) || cents < 1) return { ok: false, error: "Enter a refund amount." };
    // Checked here for a quick answer and again on the server against live rows,
    // which is the check that counts. This one cannot be the only one: the page
    // may have been open while another refund settled.
    if (cents > data.refundableCents) {
      return { ok: false, error: `Only ${money(data.refundableCents)} is left to refund on this order.` };
    }

    const result = await post(`/api/staff/orders/${orderId}/refund`, {
      amount_cents: cents,
      reason: notes.reason,
      internal_note: notes.internalNote || undefined,
      // Ties every retry of this click to one refund. A new refund needs a
      // new amount or a fresh page, both of which change the key.
      idempotency_key: `${cents}-${data.order.amount_refunded_cents}-${data.pendingRefundCents}`,
    });
    if (result.ok) {
      setRefundAmount("");
      setRefundReason("");
    }
    return result;
  };

  const returnAction = (record: ReturnRecord, action: string, body: Record<string, unknown> = {}) =>
    post(`/api/staff/orders/${orderId}/returns/${record.id}`, {
      action,
      // What the panel rendered this return's buttons from. A colleague who
      // moved it on since gets a 409 instead of having their step skipped.
      expected_status: record.status,
      ...body,
    });

  const showMoney = view === "all" || view === "money";
  const showLifecycle = view === "all" || view === "lifecycle";

  return (
    <section id="lifecycle" className="ui-card scroll-mt-5 lg:col-span-2">
      {/*
        The heading is only drawn for the untabbed caller. Inside the order
        workspace the tab already names the surface, and a card heading
        repeating it is the doubled-title look the page framework removes.
      */}
      {view === "all" ? (
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
      ) : null}

      {error ? (
        <Notice tone="danger" role="alert" className={view === "all" ? "mt-4" : undefined}>
          {error}
        </Notice>
      ) : null}

      {/* Financial position, stated before any button that changes it. */}
      {showMoney ? (
        <dl className="staff-facts mt-4">
          <div>
            <dt className="staff-fact-label">Collected</dt>
            <dd className="staff-fact-value">{money(order.amount_paid_cents)}</dd>
          </div>
          <div>
            <dt className="staff-fact-label">Refunded</dt>
            <dd className="staff-fact-value text-rose-300">{money(order.amount_refunded_cents)}</dd>
          </div>
          <div>
            <dt className="staff-fact-label">In progress</dt>
            <dd className="staff-fact-value text-amber-300">{money(data.pendingRefundCents)}</dd>
            <p className="text-[10px] text-brand-textMuted">Sent to Stripe, not yet confirmed</p>
          </div>
          <div>
            <dt className="staff-fact-label">Refundable now</dt>
            <dd className="staff-fact-value text-emerald-300">{money(data.refundableCents)}</dd>
          </div>
        </dl>
      ) : null}

      {/* ---- Cancellation ---------------------------------------------- */}
      {showLifecycle && openRequest ? (
        <div className="mt-6 rounded-2xl border border-amber-500/50 bg-amber-500/10 p-5">
          <h3 className="font-semibold">Cancellation request awaiting your decision</h3>
          <p className="mt-1 text-sm text-brand-textMuted">
            Reason: {openRequest.reason_code.replaceAll("_", " ")} · requested{" "}
            {new Date(openRequest.created_at).toLocaleString()}
          </p>
          {openRequest.customer_note ? (
            <p className="mt-3 whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 text-sm">
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
              <p className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 text-xs">
                Approving will refund <strong>{money(plannedRefund)}</strong>, leaving{" "}
                <strong>{money(Math.max(0, data.refundableCents - plannedRefund))}</strong> refundable. The order becomes
                Cancelled and the customer is emailed.
              </p>

              <div className="ui-action-row mt-4">
                <ConsequentialAction
                  label="Deny"
                  title="Decline this cancellation request?"
                  summary="The order carries on as normal and the customer is emailed your reason."
                  currentState="Cancellation requested"
                  nextState="Request declined, order continues"
                  confirmLabel="Decline the request"
                  buttonClassName="!ui-btn-secondary"
                  reason={{
                    label: "Reason for the customer",
                    required: true,
                    placeholder: "They see this exactly as written.",
                  }}
                  internalNote={{ label: "Internal note (optional)" }}
                  effects={{
                    customer: "Their request shows as declined, with your reason.",
                    financial: "No money moves.",
                    inventory: "No stock moves.",
                    notification: "“Cancellation request declined”, carrying your reason.",
                  }}
                  onConfirm={({ reason, internalNote: note }) =>
                    decideCancellation("deny", { reason, internalNote: note })
                  }
                />
                <ConsequentialAction
                  label="Approve cancellation"
                  title="Approve this cancellation?"
                  summary="The order becomes Cancelled and cannot be un-cancelled."
                  currentState="Cancellation requested"
                  nextState="Cancelled"
                  tone="danger"
                  confirmLabel="Approve and cancel the order"
                  disabled={refundMode !== "none" && !permissions.canIssueRefunds}
                  disabledReason={
                    refundMode !== "none" && !permissions.canIssueRefunds
                      ? "Refunding needs the Issue refunds permission."
                      : null
                  }
                  reason={{ label: "Note for the customer (optional)" }}
                  internalNote={{ label: "Internal note (optional)" }}
                  effects={{
                    customer: "Their order reads Cancelled.",
                    financial:
                      plannedRefund > 0
                        ? `${money(plannedRefund)} refunded, leaving ${money(Math.max(0, data.refundableCents - plannedRefund))} refundable.`
                        : "No refund is issued.",
                    inventory: restock ? "The order's units return to sellable stock." : "Stock is left as it is.",
                    notification: "“Cancellation approved”, stating the refund.",
                  }}
                  onConfirm={({ reason, internalNote: note }) =>
                    decideCancellation("approve", { reason, internalNote: note })
                  }
                />
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* ---- Returns ---------------------------------------------------- */}
      {showLifecycle && openReturn ? (
        <ReturnWorkflow
          record={openReturn}
          canReview={permissions.canReviewReturns}
          canRefund={permissions.canIssueRefunds}
          refundableCents={data.refundableCents}
          onAction={returnAction}
        />
      ) : null}

      {/* ---- Manual refund ---------------------------------------------- */}
      {showMoney && permissions.canIssueRefunds && data.refundableCents > 0 ? (
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
            <ConsequentialAction
              className="self-end"
              label="Refund"
              title={`Send ${money(Math.round(Number(refundAmount || 0) * 100))} back to the customer?`}
              summary="The money goes back through Stripe to the card that paid. A refund cannot be taken back."
              tone="money"
              confirmLabel="Send the refund"
              disabled={!refundAmount.trim() || refundReason.trim().length < 3}
              disabledReason={
                !refundAmount.trim()
                  ? "Enter an amount first."
                  : refundReason.trim().length < 3
                    ? "Give the refund a reason first."
                    : null
              }
              internalNote={{ label: "Internal note (optional)", help: "Kept with the refund. Never sent." }}
              effects={{
                customer: "Their order shows a refund in progress until Stripe confirms it.",
                financial: `${money(Math.round(Number(refundAmount || 0) * 100))} refunded. ${money(Math.max(0, data.refundableCents - Math.round(Number(refundAmount || 0) * 100)))} would remain refundable.`,
                inventory: "No stock moves. Restocking is a separate decision.",
                notification: "“Refund on its way”, then a second message when Stripe confirms.",
              }}
              notificationPreview={refundReason.trim() || undefined}
              onConfirm={({ internalNote: note }) =>
                issueRefund({ reason: refundReason.trim(), internalNote: note })
              }
            />
          </div>
        </div>
      ) : null}

      {/* ---- History ---------------------------------------------------- */}
      {showMoney && data.refunds.length ? (
        <div className="mt-6">
          <h3 className="text-sm font-semibold">Refunds</h3>
          <ul className="mt-2 divide-y divide-[var(--border)]">
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

      {showMoney && data.inventoryAdjustments && data.inventoryAdjustments.length ? (
        <div className="mt-6">
          <h3 className="text-sm font-semibold">Inventory impact</h3>
          <ul className="mt-2 divide-y divide-[var(--border)]">
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

      {/*
        Each view earns its own empty state.

        "No cancellation, return or refund activity" under the Payment tab
        would be answering a question that tab did not ask, and under Returns
        it would stay on screen while a refund history sat one tab away.
      */}
      {showLifecycle && !openRequest && !openReturn && (view === "lifecycle" || !data.refunds.length) ? (
        <EmptyState className={view === "all" ? "mt-6" : undefined}>
          {view === "lifecycle"
            ? `No cancellation or return has been raised on ${productName}.`
            : `No cancellation, return or refund activity on ${productName}.`}
        </EmptyState>
      ) : null}
      {view === "money" && !data.refunds.length && data.refundableCents <= 0 ? (
        <EmptyState className="mt-4">No refunds have been issued on this order.</EmptyState>
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
  canReview,
  canRefund,
  refundableCents,
  onAction,
}: {
  record: ReturnRecord;
  canReview: boolean;
  canRefund: boolean;
  refundableCents: number;
  onAction: (record: ReturnRecord, action: string, body?: Record<string, unknown>) => Promise<ActionResult>;
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
        <p className="mt-3 whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 text-sm">
          {record.customer_note}
        </p>
      ) : null}

      <ul className="mt-3 divide-y divide-[var(--border)] text-sm">
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
                <ConsequentialAction
                  label="Deny"
                  title="Decline this return?"
                  summary="The customer keeps the item and is emailed your reason."
                  currentState={lifecycleLabel(RETURN_LABELS, record.status)}
                  nextState="Declined"
                  confirmLabel="Decline the return"
                  reason={{
                    label: "Reason for the customer",
                    required: true,
                    placeholder: "They see this exactly as written.",
                  }}
                  internalNote={{ label: "Internal note (optional)" }}
                  effects={{
                    customer: "The return shows as declined, with your reason.",
                    financial: "No refund.",
                    inventory: "No stock moves.",
                    notification: "“Return request declined”, carrying your reason.",
                  }}
                  onConfirm={({ reason, internalNote: privateNote }) =>
                    onAction(record, "deny", { decision_note: reason, internal_note: privateNote })
                  }
                />
                <ConsequentialAction
                  label="Approve return"
                  title="Approve this return?"
                  summary="The customer is sent the return instructions. No refund is issued yet — that decision comes after you have inspected what arrives."
                  currentState={lifecycleLabel(RETURN_LABELS, record.status)}
                  nextState="Approved, awaiting the parcel"
                  confirmLabel="Approve the return"
                  reason={{ label: "Note for the customer (optional)" }}
                  internalNote={{ label: "Internal note (optional)" }}
                  effects={{
                    customer: "They receive the return address and packing instructions.",
                    financial: "Nothing yet. The refund is decided at inspection.",
                    inventory: "Nothing yet. Stock returns only if you say so at inspection.",
                    notification: "“Return approved”, with the instructions.",
                  }}
                  notificationPreview={instructions.trim() || undefined}
                  onConfirm={({ reason, internalNote: privateNote }) =>
                    onAction(record, "approve", {
                      decision_note: reason,
                      internal_note: privateNote,
                      instructions: instructions.trim(),
                    })
                  }
                />
              </div>
            </div>
          ) : null}

          {["approved", "awaiting_shipment", "in_transit"].includes(record.status) ? (
            <div className="ui-action-row mt-4">
              {record.status === "approved" ? (
                <ConsequentialAction
                  label="Waiting for the parcel"
                  title="Mark this return as awaiting the parcel?"
                  summary="An internal bookkeeping step. Nothing is sent to the customer."
                  currentState={lifecycleLabel(RETURN_LABELS, record.status)}
                  nextState="Awaiting shipment"
                  confirmLabel="Mark as awaiting"
                  buttonClassName="!ui-btn-secondary"
                  effects={{
                    customer: null,
                    financial: null,
                    inventory: null,
                    notification: null,
                  }}
                  onConfirm={() => onAction(record, "await_shipment")}
                />
              ) : null}
              <ConsequentialAction
                label="Mark received"
                title="Confirm the return arrived?"
                summary="Records that the parcel is physically here. Inspection — and any refund or restock — comes next."
                currentState={lifecycleLabel(RETURN_LABELS, record.status)}
                nextState="Received, ready to inspect"
                confirmLabel="Confirm it arrived"
                effects={{
                  customer: "Their return shows as received.",
                  financial: "No refund yet.",
                  inventory: "No stock moves yet.",
                  notification: "“Return received”, telling them it will be inspected shortly.",
                }}
                onConfirm={() => onAction(record, "receive")}
              />
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
              <p className={cx("rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 text-xs")}>
                Completing this will refund <strong>{money(plannedRefund)}</strong> and{" "}
                {restock ? "return the received units to stock" : "leave stock unchanged"}.
              </p>
              <ConsequentialAction
                label="Record inspection"
                title="Complete this inspection?"
                summary="This is the step that moves money and stock. It cannot be repeated — the return leaves the inspectable state."
                currentState={lifecycleLabel(RETURN_LABELS, record.status)}
                nextState={plannedRefund > 0 ? "Inspected, refund sent" : "Inspected and closed"}
                tone={plannedRefund > 0 ? "money" : "default"}
                confirmLabel="Record the inspection"
                disabled={refundMode !== "none" && !canRefund}
                disabledReason={
                  refundMode !== "none" && !canRefund ? "Refunding needs the Issue refunds permission." : null
                }
                internalNote={{ label: "Internal note (optional)", help: "Kept with the inspection. Never sent." }}
                effects={{
                  customer: `Their return shows as inspected — outcome “${outcome.replaceAll("_", " ")}”.`,
                  financial: plannedRefund > 0 ? `${money(plannedRefund)} refunded through Stripe.` : "No refund.",
                  inventory: restock
                    ? "The received units go back into sellable stock."
                    : "Stock is unchanged — the units are not resold.",
                  notification: "“Return inspected”, stating the refund.",
                }}
                notificationPreview={note.trim() || undefined}
                onConfirm={({ internalNote: privateNote }) =>
                  onAction(record, "inspect", {
                    inspection_outcome: outcome,
                    inspection_note: note.trim(),
                    internal_note: privateNote,
                    restock,
                    refund_mode: refundMode,
                    refund_amount_cents: refundMode === "partial" ? Math.round(Number(partial || 0) * 100) : undefined,
                  })
                }
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
