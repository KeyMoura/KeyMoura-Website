import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import {
  CANCELLATION_REASONS,
  RETURN_REASONS,
  customerLifecycleHeadline,
  evaluateCancellation,
  evaluateReturn,
} from "@/lib/commerce/orderLifecycle";
import { loadOrderLifecycleContext } from "@/lib/commerce/orderLifecycleServer";

/**
 * What one customer may do with one order, and why not when they may not.
 *
 * The page renders from this rather than deciding for itself, so the button a
 * customer sees and the rule the write path enforces are the same computation.
 * The write paths re-run it anyway — this endpoint shapes the UI, it does not
 * authorize anything.
 *
 * Everything returned here is customer-safe. Internal notes, staff identities,
 * Stripe identifiers, production detail and cost data are all deliberately
 * absent, including from the refund list.
 */

export const runtime = "nodejs";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: "Sign in to view this order." }, { status: 401 });

  const { id } = await context.params;
  const lifecycle = await loadOrderLifecycleContext(id);
  if (!lifecycle || lifecycle.order.customer_id !== user.id) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  const cancellation = evaluateCancellation({
    ...lifecycle.order,
    policy: lifecycle.policy,
    hasOpenRequest: Boolean(lifecycle.openCancellationRequest),
    productionStatus: lifecycle.productionStatus,
    isCustomOrder: lifecycle.order.order_kind === "custom_request",
  });

  const returnEligibility = evaluateReturn({
    ...lifecycle.order,
    policy: lifecycle.policy,
    hasOpenReturn: Boolean(lifecycle.openReturn),
    lines: lifecycle.lines,
  });

  const [{ data: requests }, { data: returns }, { data: refunds }] = await Promise.all([
    routeServiceClient
      .from("order_cancellation_requests")
      // `internal_note` is not selected. It is staff-only by design, and the
      // safest way to keep it out of a customer payload is never to load it.
      .select("id,status,reason_code,customer_note,decision_note,created_at,decided_at,withdrawn_at,completed_at,refund_mode,refund_amount_cents")
      .eq("order_id", id)
      .order("created_at", { ascending: false })
      .limit(10),
    routeServiceClient
      .from("order_returns")
      .select(
        "id,return_number,status,reason_code,customer_note,decision_note,return_instructions,return_address," +
          "carrier,tracking_number,tracking_url,shipped_at,received_at,inspected_at,inspection_outcome," +
          "refund_decision,refund_amount_cents,created_at,decided_at,closed_at," +
          "order_return_items(id,product_name,unit_price_cents,requested_quantity,approved_quantity,received_quantity)"
      )
      .eq("order_id", id)
      .order("created_at", { ascending: false })
      .limit(10),
    routeServiceClient
      .from("order_refunds")
      // No `stripe_refund_id`, no `internal_note`, no `failure_message` —
      // provider internals and staff wording are not the customer's business,
      // and "Refund failed, we are looking into it" is the honest summary.
      .select("id,status,amount_cents,requested_amount_cents,confirmed_amount_cents,reason,customer_note,created_at,confirmed_at,failed_at,kind")
      .eq("order_id", id)
      .order("created_at", { ascending: false })
      .limit(25),
  ]);

  return NextResponse.json({
    headline: customerLifecycleHeadline(lifecycle.order),
    state: {
      status: lifecycle.order.status,
      payment_status: lifecycle.order.payment_status,
      fulfillment_status: lifecycle.order.fulfillment_status,
      cancellation_status: lifecycle.order.cancellation_status,
      return_status: lifecycle.order.return_status,
      fulfillment_method: lifecycle.order.fulfillment_method,
    },
    money: {
      agreed_price_cents: lifecycle.order.agreed_price_cents,
      amount_paid_cents: lifecycle.order.amount_paid_cents,
      amount_refunded_cents: lifecycle.order.amount_refunded_cents,
      pending_refund_cents: lifecycle.pendingRefundCents,
    },
    cancellation: {
      eligibility: cancellation,
      reasons: CANCELLATION_REASONS,
      requests: requests ?? [],
    },
    returns: {
      eligibility: returnEligibility,
      reasons: RETURN_REASONS,
      records: returns ?? [],
      policyText: lifecycle.policy.returns.policyText,
      customerPaysReturnShipping: lifecycle.policy.returns.customerPaysReturnShipping,
    },
    refunds: refunds ?? [],
  });
}
