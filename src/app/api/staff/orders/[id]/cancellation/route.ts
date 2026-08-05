import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import {
  applyOrderCancellation,
  issueOrderRefund,
  loadOrderLifecycleContext,
  logLifecycleAudit,
  logLifecycleFailure,
  moneyText,
  sendLifecycleNotification,
} from "@/lib/commerce/orderLifecycleServer";

/**
 * Staff decision on a cancellation request.
 *
 * Approving may or may not carry a refund; the two are separate choices, and
 * approval never means "refund complete". A refund only counts once Stripe
 * confirms it, which is why the order lands on `refund_pending` when Stripe
 * answers "pending" and only reaches `completed` when the money has actually
 * moved.
 *
 * Deciding is conditional on the request still being `pending`, so a second
 * click, a second tab, or a colleague deciding first matches zero rows rather
 * than overwriting the first decision.
 */

export const runtime = "nodejs";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "cancellations.review");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await context.params;
  const body = (await req.json().catch(() => null)) as {
    request_id?: unknown;
    decision?: unknown;
    decision_note?: unknown;
    internal_note?: unknown;
    refund_mode?: unknown;
    refund_amount_cents?: unknown;
    restock_inventory?: unknown;
    restore_discount?: unknown;
  } | null;

  const requestId = typeof body?.request_id === "string" ? body.request_id : "";
  const decision = body?.decision === "approve" ? "approve" : body?.decision === "deny" ? "deny" : "";
  if (!requestId || !decision) {
    return NextResponse.json({ error: "Choose approve or deny." }, { status: 400 });
  }

  const decisionNote = typeof body?.decision_note === "string" ? body.decision_note.trim().slice(0, 2000) : "";
  const internalNote = typeof body?.internal_note === "string" ? body.internal_note.trim().slice(0, 2000) : "";

  // A denial with no explanation is a dead end for the customer, so the reason
  // is required and it is the reason they are shown.
  if (decision === "deny" && decisionNote.length < 5) {
    return NextResponse.json(
      { error: "Give the customer a reason. They will see exactly what you write here." },
      { status: 400 }
    );
  }

  const lifecycle = await loadOrderLifecycleContext(id);
  if (!lifecycle) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const { data: request } = await routeServiceClient
    .from("order_cancellation_requests")
    .select("id,status,reason_code,requested_by")
    .eq("id", requestId)
    .eq("order_id", id)
    .maybeSingle();

  if (!request) return NextResponse.json({ error: "Cancellation request not found" }, { status: 404 });
  if (request.status !== "pending") {
    return NextResponse.json(
      { error: `This request was already ${request.status}. Reload the order to see the outcome.` },
      { status: 409 }
    );
  }

  const now = new Date().toISOString();

  if (decision === "deny") {
    const { data: denied, error } = await routeServiceClient
      .from("order_cancellation_requests")
      .update({
        status: "denied",
        decision_note: decisionNote,
        internal_note: internalNote || null,
        decided_by: actor.userId,
        decided_at: now,
        updated_at: now,
      })
      .eq("id", requestId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();

    if (error) {
      logLifecycleFailure("deny_cancellation", error, { orderId: id });
      return NextResponse.json({ error: "Could not record the decision." }, { status: 500 });
    }
    if (!denied) {
      return NextResponse.json({ error: "This request was decided a moment ago. Reload the order." }, { status: 409 });
    }

    await routeServiceClient
      .from("orders")
      .update({ cancellation_status: "denied", updated_at: now })
      .eq("id", id);

    await Promise.all([
      sendLifecycleNotification({
        orderId: id,
        order: lifecycle.order,
        actorUserId: actor.userId,
        templateKey: "cancellation_denied",
        eventKey: `cancel-denied-${requestId}`,
        title: "Cancellation request declined",
        message: decisionNote,
        detail: decisionNote,
      }),
      logLifecycleAudit({
        eventType: "staff.order.cancellation_denied",
        actorUserId: actor.userId,
        actorRole: actor.role,
        orderId: id,
        // The note bodies stay out of the audit log; that it was given is what
        // matters here, and the request row holds the text.
        metadata: { request_id: requestId, had_internal_note: Boolean(internalNote) },
      }),
    ]);

    return NextResponse.json({ ok: true, decision: "denied" });
  }

  // ---- Approve -----------------------------------------------------------

  const refundMode = body?.refund_mode === "full" ? "full" : body?.refund_mode === "partial" ? "partial" : "none";
  const restockInventory = body?.restock_inventory !== false && lifecycle.policy.inventory.restoreOnCancellation;
  const restoreDiscount = body?.restore_discount !== false;

  // The amount is always recomputed from the order. A number posted by the
  // browser is a suggestion, never the figure that reaches Stripe.
  let refundCents = 0;
  if (refundMode === "full") {
    refundCents = lifecycle.refundableCents;
  } else if (refundMode === "partial") {
    const requestedAmount = body?.refund_amount_cents;
    if (!Number.isInteger(requestedAmount) || Number(requestedAmount) < 1) {
      return NextResponse.json({ error: "Enter the partial refund amount." }, { status: 400 });
    }
    refundCents = Number(requestedAmount);
    if (refundCents > lifecycle.refundableCents) {
      return NextResponse.json(
        {
          error: `That is more than the ${moneyText(lifecycle.refundableCents)} left to refund on this order.`,
          refundableCents: lifecycle.refundableCents,
        },
        { status: 409 }
      );
    }
  }

  if (refundMode !== "none" && refundCents > 0 && !actor.permissions.has("refunds.issue")) {
    return NextResponse.json(
      { error: "Approving with a refund needs the Issue refunds permission." },
      { status: 403 }
    );
  }

  const { data: approved, error: approveError } = await routeServiceClient
    .from("order_cancellation_requests")
    .update({
      status: "approved",
      decision_note: decisionNote || null,
      internal_note: internalNote || null,
      decided_by: actor.userId,
      decided_at: now,
      refund_mode: refundMode,
      refund_amount_cents: refundCents,
      restock_inventory: restockInventory,
      restore_discount: restoreDiscount,
      updated_at: now,
    })
    .eq("id", requestId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (approveError) {
    logLifecycleFailure("approve_cancellation", approveError, { orderId: id });
    return NextResponse.json({ error: "Could not record the decision." }, { status: 500 });
  }
  if (!approved) {
    return NextResponse.json({ error: "This request was decided a moment ago. Reload the order." }, { status: 409 });
  }

  let refundOutcome: { settledCents: number; pendingCents: number; failedCents: number } | null = null;
  let refundError: string | null = null;

  if (refundCents > 0) {
    await logLifecycleAudit({
      eventType: "staff.order.refund_requested",
      actorUserId: actor.userId,
      actorRole: actor.role,
      orderId: id,
      metadata: { request_id: requestId, amount_cents: refundCents, mode: refundMode },
    });

    const result = await issueOrderRefund({
      orderId: id,
      amountCents: refundCents,
      kind: "cancellation",
      reason: `Cancellation approved (${request.reason_code})`,
      // Keyed on the request, so a retried approval reuses the same refund
      // instead of creating a second one.
      idempotencyKey: `cancellation-${requestId}-${refundCents}`,
      actorUserId: actor.userId,
      customerNote: decisionNote || null,
      internalNote: internalNote || null,
      cancellationRequestId: requestId,
    });

    if (!result.ok) {
      refundError = result.error;
      await routeServiceClient
        .from("order_cancellation_requests")
        .update({ status: "failed", updated_at: new Date().toISOString() })
        .eq("id", requestId)
        .eq("status", "approved");
      await routeServiceClient
        .from("orders")
        .update({ cancellation_status: "refund_failed", updated_at: new Date().toISOString() })
        .eq("id", id);
      await logLifecycleAudit({
        eventType: "staff.order.refund_failed",
        actorUserId: actor.userId,
        actorRole: actor.role,
        orderId: id,
        metadata: { request_id: requestId, amount_cents: refundCents },
      });
      return NextResponse.json(
        { error: refundError, decision: "approved", refundFailed: true, refundableCents: result.refundableCents ?? null },
        { status: 409 }
      );
    }

    refundOutcome = result;

    await logLifecycleAudit({
      eventType: result.failedCents > 0 ? "staff.order.refund_failed" : "staff.order.refund_sent",
      actorUserId: actor.userId,
      actorRole: actor.role,
      orderId: id,
      metadata: {
        request_id: requestId,
        settled_cents: result.settledCents,
        pending_cents: result.pendingCents,
        failed_cents: result.failedCents,
      },
    });
  }

  // Cancellation state follows the money, not the button. A refund Stripe has
  // not confirmed leaves this at `refund_pending` and the webhook finishes it.
  const cancellationStatus =
    refundOutcome && refundOutcome.failedCents > 0
      ? "refund_failed"
      : refundOutcome && refundOutcome.pendingCents > 0
        ? "refund_pending"
        : "completed";

  const applied = await applyOrderCancellation({
    orderId: id,
    actorUserId: actor.userId,
    reason: decisionNote || `Cancellation approved (${request.reason_code})`,
    cancellationStatus,
    cancellationRequestId: requestId,
    restockInventory,
    restoreDiscount,
  });
  if (!applied.ok) return NextResponse.json({ error: applied.error }, { status: 500 });

  if (cancellationStatus === "completed") {
    await routeServiceClient
      .from("order_cancellation_requests")
      .update({ status: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", requestId);
  }

  const refundSentence =
    refundCents > 0
      ? refundOutcome && refundOutcome.settledCents > 0
        ? `A ${moneyText(refundOutcome.settledCents)} refund has been issued. Your bank may take a few business days to show it.`
        : `A ${moneyText(refundCents)} refund is on its way. We will confirm once your bank accepts it.`
      : "No refund was issued for this cancellation.";

  await Promise.all([
    sendLifecycleNotification({
      orderId: id,
      order: lifecycle.order,
      actorUserId: actor.userId,
      templateKey: "cancellation_approved",
      eventKey: `cancel-approved-${requestId}`,
      title: "Cancellation approved",
      message: `Your order was cancelled. ${refundSentence}`,
      detail: `${decisionNote ? `${decisionNote} ` : ""}${refundSentence}`,
      price: refundCents > 0 ? moneyText(refundCents) : "",
    }),
    logLifecycleAudit({
      eventType: "staff.order.cancellation_approved",
      actorUserId: actor.userId,
      actorRole: actor.role,
      orderId: id,
      metadata: {
        request_id: requestId,
        refund_mode: refundMode,
        refund_cents: refundCents,
        restocked: restockInventory,
        discount_released: restoreDiscount,
        outcome: cancellationStatus,
      },
    }),
  ]);

  return NextResponse.json({
    ok: true,
    decision: "approved",
    cancellationStatus,
    refund: refundOutcome,
  });
}
