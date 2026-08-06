import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import {
  CANCELLATION_REASON_CODES,
  evaluateCancellation,
} from "@/lib/commerce/orderLifecycle";
import {
  applyOrderCancellation,
  loadOrderLifecycleContext,
  logLifecycleAudit,
  logLifecycleFailure,
  notifyStaffEmail,
  sendLifecycleNotification,
} from "@/lib/commerce/orderLifecycleServer";
import { raiseOperationalAlert } from "@/lib/comms/operationalAlerts";
import { RATE_LIMITS, consumeRateLimit, rateLimitMessage } from "@/lib/commerce/rateLimit";

/**
 * Customer cancellation.
 *
 * Two outcomes, decided server-side from live rows:
 *
 * - An **unpaid** eligible order is cancelled here and now. There is no money
 *   to unwind and nothing for staff to weigh up.
 * - A **paid** order raises a request. The customer never triggers a refund;
 *   approving one is a staff decision, and Stripe confirming it is what makes
 *   it real.
 *
 * Eligibility is recomputed on every call. The customer page hides ineligible
 * actions, but hiding a button is a courtesy, not a control.
 */

export const runtime = "nodejs";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: "Sign in to manage this order." }, { status: 401 });

  const { id } = await context.params;
  const body = (await req.json().catch(() => null)) as
    | { reason_code?: unknown; note?: unknown; confirm?: unknown }
    | null;

  const reasonCode = typeof body?.reason_code === "string" ? body.reason_code : "";
  if (!CANCELLATION_REASON_CODES.includes(reasonCode)) {
    return NextResponse.json({ error: "Choose a reason for cancelling." }, { status: 400 });
  }
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 2000) : "";
  if (body?.confirm !== true) {
    return NextResponse.json({ error: "Confirm the cancellation before submitting." }, { status: 400 });
  }

  // Submitting a cancellation is cheap to repeat and writes to two tables. The
  // limiter fails open — it is not an authorization control and a Postgres
  // blip must not lock a customer out of their own order.
  const limit = await consumeRateLimit(RATE_LIMITS.orderCancel, `user:${user.id}`);
  if (!limit.allowed) return NextResponse.json({ error: rateLimitMessage(limit) }, { status: 429 });

  const lifecycle = await loadOrderLifecycleContext(id);
  if (!lifecycle) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  // Ownership, checked against the row rather than anything the client sent.
  if (lifecycle.order.customer_id !== user.id) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  const eligibility = evaluateCancellation({
    ...lifecycle.order,
    policy: lifecycle.policy,
    hasOpenRequest: Boolean(lifecycle.openCancellationRequest),
    productionStatus: lifecycle.productionStatus,
    isCustomOrder: lifecycle.order.order_kind === "custom_request",
  });

  if (eligibility.kind === "pending") {
    return NextResponse.json({ error: eligibility.note, alreadyRequested: true }, { status: 409 });
  }
  if (eligibility.kind === "unavailable") {
    return NextResponse.json({ error: eligibility.reason }, { status: 409 });
  }

  const reasonText = `${reasonCode.replaceAll("_", " ")}${note ? `: ${note}` : ""}`;

  if (eligibility.kind === "immediate") {
    const applied = await applyOrderCancellation({
      orderId: id,
      actorUserId: user.id,
      reason: reasonText,
      cancellationStatus: "completed",
      restockInventory: lifecycle.policy.inventory.restoreOnCancellation,
      restoreDiscount: true,
    });
    if (!applied.ok) return NextResponse.json({ error: applied.error }, { status: 500 });
    if (applied.alreadyCancelled) {
      return NextResponse.json({ ok: true, outcome: "cancelled", duplicate: true });
    }

    // Recorded as a completed request too, so the order's history reads the
    // same whichever path cancelled it.
    const { data: record } = await routeServiceClient
      .from("order_cancellation_requests")
      .insert({
        order_id: id,
        requested_by: user.id,
        requested_by_kind: "customer",
        reason_code: reasonCode,
        customer_note: note || null,
        status: "completed",
        decided_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        refund_mode: "none",
        restock_inventory: lifecycle.policy.inventory.restoreOnCancellation,
      })
      .select("id")
      .maybeSingle();

    await Promise.all([
      sendLifecycleNotification({
        orderId: id,
        order: lifecycle.order,
        actorUserId: user.id,
        templateKey: "order_cancelled",
        eventKey: `cancel-${id}-${record?.id ?? "immediate"}`,
        title: "Order cancelled",
        message: "Your order was cancelled. Nothing was charged.",
        detail: "No payment was taken, so there is nothing to refund.",
        notifyStaff: true,
        staffTitle: "Customer cancelled an unpaid order",
        staffMessage: `${lifecycle.order.product_name} was cancelled by the customer before payment.`,
      }),
      logLifecycleAudit({
        eventType: "staff.order.cancelled",
        actorUserId: user.id,
        actorRole: "customer",
        orderId: id,
        metadata: { reason_code: reasonCode, paid: false, initiated_by: "customer" },
      }),
    ]);

    return NextResponse.json({ ok: true, outcome: "cancelled" });
  }

  // Paid: raise a request. The partial unique index on (order_id) where
  // status='pending' is what makes a double submission impossible — two tabs
  // race to the same insert and the loser gets 23505, not a second request.
  const { data: request, error } = await routeServiceClient
    .from("order_cancellation_requests")
    .insert({
      order_id: id,
      requested_by: user.id,
      requested_by_kind: "customer",
      reason_code: reasonCode,
      customer_note: note || null,
      status: "pending",
    })
    .select("id,created_at")
    .single();

  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return NextResponse.json(
        { error: "A cancellation request for this order is already open.", alreadyRequested: true },
        { status: 409 }
      );
    }
    logLifecycleFailure("create_cancellation_request", error, { orderId: id });
    return NextResponse.json({ error: "Could not submit the request. Please try again." }, { status: 500 });
  }

  const { error: statusError } = await routeServiceClient
    .from("orders")
    .update({
      cancellation_status: "requested",
      cancellation_requested_at: request.created_at,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (statusError) logLifecycleFailure("mark_cancellation_requested", statusError, { orderId: id });

  await Promise.all([
    sendLifecycleNotification({
      orderId: id,
      order: lifecycle.order,
      actorUserId: user.id,
      templateKey: "cancellation_requested",
      eventKey: `cancel-request-${request.id}`,
      title: "Cancellation requested",
      message: "We received your cancellation request. The team will review it and let you know.",
      detail: "Approving a cancellation is not automatic, and any refund is decided as part of the review.",
      notifyStaff: true,
      staffTitle: "Cancellation requested",
      staffMessage: `A customer asked to cancel ${lifecycle.order.product_name}. Review it on the order page.`,
    }),
    logLifecycleAudit({
      eventType: "staff.order.cancellation_requested",
      actorUserId: user.id,
      actorRole: "customer",
      orderId: id,
      metadata: { request_id: request.id, reason_code: reasonCode, refundable_cents: lifecycle.refundableCents },
    }),
    // Routed to `cancellations.review` rather than `orders.manage`: the people
    // who need to see this are the people who can decide it.
    raiseOperationalAlert({
      kind: "cancellation.requested",
      subjectId: id,
      discriminator: request.id,
      actorUserId: user.id,
      message: `A customer asked to cancel ${lifecycle.order.product_name}. Nothing has been refunded.`,
    }),
    notifyStaffEmail({
      templateKey: "staff_cancellation_request",
      eventKey: `cancel-request-staff-${request.id}`,
      orderId: id,
      order: lifecycle.order,
      detail: "Approving it is a decision, and any refund is a separate choice within it.",
      href: `/staff/orders/${id}`,
    }),
  ]);

  return NextResponse.json({ ok: true, outcome: "requested", requestId: request.id });
}

/**
 * Withdraw an open request.
 *
 * Safe only while it is still pending: once staff have approved it a refund may
 * already be moving, and "withdrawing" then would leave the customer's view
 * disagreeing with their bank.
 */
export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: "Sign in to manage this order." }, { status: 401 });

  const { id } = await context.params;
  const lifecycle = await loadOrderLifecycleContext(id);
  if (!lifecycle || lifecycle.order.customer_id !== user.id) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }
  if (!lifecycle.openCancellationRequest) {
    return NextResponse.json({ error: "There is no open cancellation request to withdraw." }, { status: 409 });
  }

  // Conditional on `status = 'pending'`: a decision landing between the read
  // and this write matches zero rows instead of overwriting it.
  const { data: withdrawn, error } = await routeServiceClient
    .from("order_cancellation_requests")
    .update({ status: "withdrawn", withdrawn_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", lifecycle.openCancellationRequest.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (error) {
    logLifecycleFailure("withdraw_cancellation_request", error, { orderId: id });
    return NextResponse.json({ error: "Could not withdraw the request." }, { status: 500 });
  }
  if (!withdrawn) {
    return NextResponse.json(
      { error: "This request has already been decided. Reload the page to see the outcome." },
      { status: 409 }
    );
  }

  await routeServiceClient
    .from("orders")
    .update({ cancellation_status: "withdrawn", updated_at: new Date().toISOString() })
    .eq("id", id);

  await Promise.all([
    sendLifecycleNotification({
      orderId: id,
      order: lifecycle.order,
      actorUserId: user.id,
      templateKey: "cancellation_withdrawn",
      eventKey: `cancel-withdraw-${withdrawn.id}`,
      title: "Cancellation withdrawn",
      message: "Your cancellation request was withdrawn and the order continues as normal.",
      notifyStaff: true,
      staffTitle: "Cancellation request withdrawn",
      staffMessage: `The customer withdrew their request to cancel ${lifecycle.order.product_name}.`,
    }),
    logLifecycleAudit({
      eventType: "staff.order.cancellation_withdrawn",
      actorUserId: user.id,
      actorRole: "customer",
      orderId: id,
      metadata: { request_id: withdrawn.id },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
