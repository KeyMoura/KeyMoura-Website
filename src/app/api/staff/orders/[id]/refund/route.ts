import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { stripeClient } from "@/lib/stripe";
import { notifyOrderUser } from "@/lib/orderNotifications";
import { captureCommerceException } from "@/lib/monitoring";

export const runtime = "nodejs";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "orders.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await context.params;
  const body = await req.json().catch(() => null) as { amount_cents?: unknown; reason?: unknown } | null;
  const amount = body?.amount_cents;
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 1000) : "";
  if (!Number.isInteger(amount) || Number(amount) < 1 || reason.length < 3) {
    return NextResponse.json({ error: "Enter a valid refund amount and reason." }, { status: 400 });
  }

  const { data: order } = await routeServiceClient.from("orders")
    .select("id,customer_id,amount_paid_cents,amount_refunded_cents,payment_status")
    .eq("id", id).maybeSingle();
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  const refundable = (order.amount_paid_cents || 0) - (order.amount_refunded_cents || 0);
  if (Number(amount) > refundable) return NextResponse.json({ error: "Refund exceeds the refundable amount." }, { status: 409 });

  const { data: payments } = await routeServiceClient.from("order_payments")
    .select("id,stripe_payment_intent_id,amount_cents,amount_refunded_cents")
    .eq("order_id", id).order("received_at", { ascending: false });
  let remaining = Number(amount);
  let totalRefunded = order.amount_refunded_cents || 0;
  const available = (payments || []).reduce((sum, payment) => sum + payment.amount_cents - payment.amount_refunded_cents, 0);
  if (available < remaining) return NextResponse.json({ error: "Older payment records are unavailable. Refund this payment in Stripe, then record it manually before continuing." }, { status: 409 });

  for (const payment of payments || []) {
    if (remaining <= 0) break;
    const paymentAvailable = payment.amount_cents - payment.amount_refunded_cents;
    if (paymentAvailable <= 0) continue;
    const refundAmount = Math.min(remaining, paymentAvailable);
    const refund = await stripeClient().refunds.create({
      payment_intent: payment.stripe_payment_intent_id,
      amount: refundAmount,
      reason: "requested_by_customer",
      metadata: { order_id: id, staff_user_id: actor.userId, internal_reason: reason.slice(0, 450) },
    }, { idempotencyKey: `order-${id}-payment-${payment.id}-refunded-${payment.amount_refunded_cents}-amount-${refundAmount}` });
    const { data: accounting, error: refundError } = await routeServiceClient.rpc("record_stripe_order_refund", {
      p_order_id: id,
      p_order_payment_id: payment.id,
      p_stripe_refund_id: refund.id,
      p_amount_cents: refundAmount,
      p_reason: reason,
      p_created_by: actor.userId,
    });
    if (refundError) {
      captureCommerceException(refundError, { operation: "record_refund", orderId: id });
      return NextResponse.json({ error: "Stripe accepted the refund, but its local record needs attention." }, { status: 500 });
    }
    const result = accounting as { amount_refunded_cents?: number } | null;
    totalRefunded = Number(result?.amount_refunded_cents ?? totalRefunded + refundAmount);
    remaining -= refundAmount;
  }

  await notifyOrderUser({ orderId:id, actorUserId:actor.userId, recipientUserId:order.customer_id,
    title:"Refund issued", message:`A $${(Number(amount) / 100).toFixed(2)} refund was issued. Your bank may take several business days to post it.` });
  return NextResponse.json({ ok: true, amount_refunded_cents: totalRefunded });
}
