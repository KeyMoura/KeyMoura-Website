import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import {
  issueOrderRefund,
  loadOrderLifecycleContext,
  logLifecycleAudit,
  moneyText,
  sendLifecycleNotification,
} from "@/lib/commerce/orderLifecycleServer";

/**
 * Staff-issued refund.
 *
 * Rewritten in the order-lifecycle pass. The previous version called Stripe and
 * treated a resolved promise as a completed refund: it wrote the accounting
 * immediately, had no failure state, and could not see a refund issued from the
 * Stripe Dashboard — so the same money could be sent twice, once from each
 * surface. Now the claim is made in Postgres before Stripe is called, and only
 * Stripe's confirmation moves `amount_refunded_cents`.
 *
 * `refunds.issue` is required rather than `orders.manage`: this is the one
 * route that sends money out, and updating an order should not imply it.
 */

export const runtime = "nodejs";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "refunds.issue");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await context.params;
  const body = (await req.json().catch(() => null)) as {
    amount_cents?: unknown;
    reason?: unknown;
    customer_note?: unknown;
    internal_note?: unknown;
    idempotency_key?: unknown;
  } | null;

  const amount = body?.amount_cents;
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 1000) : "";
  if (!Number.isInteger(amount) || Number(amount) < 1) {
    return NextResponse.json({ error: "Enter a refund amount." }, { status: 400 });
  }
  if (reason.length < 3) {
    return NextResponse.json({ error: "Give the refund a reason." }, { status: 400 });
  }

  const lifecycle = await loadOrderLifecycleContext(id);
  if (!lifecycle) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  // Recomputed server-side from live rows, with pending refunds already
  // subtracted. Whatever the form was showing when it was opened is irrelevant.
  if (Number(amount) > lifecycle.refundableCents) {
    return NextResponse.json(
      {
        error:
          lifecycle.refundableCents > 0
            ? `Only ${moneyText(lifecycle.refundableCents)} is left to refund on this order.`
            : "This order has nothing left to refund.",
        refundableCents: lifecycle.refundableCents,
      },
      { status: 409 }
    );
  }

  /**
   * The client may supply a key so that a retried fetch reuses one refund. It
   * is namespaced by order and amount and can only ever *collapse* a duplicate,
   * never authorize a larger one — the amount is validated above and again
   * inside `begin_order_refund` under a row lock.
   */
  const clientKey = typeof body?.idempotency_key === "string" ? body.idempotency_key.trim().slice(0, 80) : "";
  const idempotencyKey = clientKey
    ? `manual-${id}-${amount}-${clientKey.replace(/[^A-Za-z0-9_-]/g, "")}`
    : `manual-${id}-${amount}-${lifecycle.order.amount_refunded_cents}-${lifecycle.pendingRefundCents}`;

  await logLifecycleAudit({
    eventType: "staff.order.refund_requested",
    actorUserId: actor.userId,
    actorRole: actor.role,
    orderId: id,
    metadata: { amount_cents: Number(amount), refundable_cents: lifecycle.refundableCents },
  });

  const result = await issueOrderRefund({
    orderId: id,
    amountCents: Number(amount),
    kind: "manual",
    reason,
    idempotencyKey,
    actorUserId: actor.userId,
    customerNote: typeof body?.customer_note === "string" ? body.customer_note.trim().slice(0, 2000) : null,
    internalNote: typeof body?.internal_note === "string" ? body.internal_note.trim().slice(0, 2000) : null,
  });

  if (!result.ok) {
    await logLifecycleAudit({
      eventType: "staff.order.refund_failed",
      actorUserId: actor.userId,
      actorRole: actor.role,
      orderId: id,
      metadata: { amount_cents: Number(amount) },
    });
    return NextResponse.json({ error: result.error, refundableCents: result.refundableCents ?? null }, { status: 409 });
  }

  await logLifecycleAudit({
    eventType: result.failedCents > 0 ? "staff.order.refund_failed" : "staff.order.refund_sent",
    actorUserId: actor.userId,
    actorRole: actor.role,
    orderId: id,
    metadata: {
      settled_cents: result.settledCents,
      pending_cents: result.pendingCents,
      failed_cents: result.failedCents,
      legs: result.legs.length,
    },
  });

  const { data: fresh } = await routeServiceClient
    .from("orders")
    .select("amount_refunded_cents,payment_status")
    .eq("id", id)
    .maybeSingle();

  if (result.settledCents > 0 || result.pendingCents > 0) {
    const settled = result.settledCents > 0 && result.pendingCents === 0;
    await sendLifecycleNotification({
      orderId: id,
      order: lifecycle.order,
      actorUserId: actor.userId,
      templateKey: settled ? "refund_completed" : "refund_initiated",
      // Keyed on the refund itself, so a webhook confirming the same refund
      // later does not send the customer a second copy of this message.
      eventKey: `refund-${settled ? "done" : "sent"}-${result.legs.map((leg) => leg.refund_id).join("-")}`,
      title: settled ? "Refund issued" : "Refund on its way",
      message: settled
        ? `A ${moneyText(result.settledCents)} refund was issued. Your bank may take several business days to post it.`
        : `A ${moneyText(Number(amount))} refund has been sent to your bank. We will confirm once it completes.`,
      detail: reason,
      price: moneyText(Number(amount)),
    });
  }

  if (result.failedCents > 0) {
    await sendLifecycleNotification({
      orderId: id,
      order: lifecycle.order,
      actorUserId: actor.userId,
      templateKey: "refund_failed",
      eventKey: `refund-failed-${result.legs.map((leg) => leg.refund_id).join("-")}`,
      title: "Refund needs attention",
      message: "A refund on this order did not complete. The team has been notified and will be in touch.",
      notifyStaff: true,
      staffTitle: "Refund failed",
      staffMessage: `A ${moneyText(result.failedCents)} refund on ${lifecycle.order.product_name} failed at Stripe. Open the order to retry.`,
    });
  }

  return NextResponse.json({
    ok: true,
    settled_cents: result.settledCents,
    pending_cents: result.pendingCents,
    failed_cents: result.failedCents,
    amount_refunded_cents: Number(fresh?.amount_refunded_cents ?? lifecycle.order.amount_refunded_cents),
    payment_status: fresh?.payment_status ?? lifecycle.order.payment_status,
  });
}
