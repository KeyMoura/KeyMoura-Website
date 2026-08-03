import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { routeServiceClient } from "@/lib/api/routeAuth";
import { stripeClient } from "@/lib/stripe";
import { getCommerceEmailConfig, sendCommerceEmail } from "@/lib/commerceEmail";
import { notifyOrderStaff, notifyOrderUser } from "@/lib/orderNotifications";
import { captureCommerceException } from "@/lib/monitoring";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const signature = req.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || !secret) return NextResponse.json({ error: "Webhook not configured" }, { status: 400 });
  let event: Stripe.Event;
  try { event = stripeClient().webhooks.constructEvent(await req.text(), signature, secret); }
  catch { return NextResponse.json({ error: "Invalid signature" }, { status: 400 }); }
  if (event.type === "checkout.session.async_payment_failed") {
    const failedEvent = await routeServiceClient.from("stripe_webhook_events").insert({ stripe_event_id: event.id, event_type: event.type });
    if (failedEvent.error?.code === "23505") return NextResponse.json({ received: true, duplicate: true });
    if (failedEvent.error) {
      captureCommerceException(failedEvent.error, { operation: "record_failed_payment_event", stripeEventId: event.id });
      return NextResponse.json({ error: "Could not record event" }, { status: 500 });
    }
    const failedSession = event.data.object as Stripe.Checkout.Session;
    const failedOrderId = failedSession.metadata?.order_id || failedSession.client_reference_id;
    const failedCustomerId = failedSession.metadata?.customer_id;
    if (failedOrderId && failedCustomerId) {
      await routeServiceClient.from("orders").update({ stripe_checkout_session_id: null }).eq("id", failedOrderId).eq("stripe_checkout_session_id", failedSession.id);
      await Promise.all([
        notifyOrderUser({ orderId:failedOrderId, actorUserId:null, recipientUserId:failedCustomerId, title:"Payment failed", message:"Your payment did not complete. No successful payment was recorded; open the order to try again." }),
        notifyOrderStaff({ orderId:failedOrderId, actorUserId:null, title:"Customer payment failed", message:"A delayed payment failed. The order remains unpaid and the customer can try again." }),
      ]);
    }
    await routeServiceClient.from("stripe_webhook_events").update({ processed_at: new Date().toISOString() }).eq("stripe_event_id", event.id);
    return NextResponse.json({ received: true });
  }
  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") return NextResponse.json({ received: true });

  const session = event.data.object as Stripe.Checkout.Session;
  if (session.payment_status !== "paid") return NextResponse.json({ received: true });
  const orderId = session.metadata?.order_id || session.client_reference_id;
  if (!orderId || !session.amount_total || session.currency !== "usd") return NextResponse.json({ error: "Missing order metadata" }, { status: 400 });

  const inserted = await routeServiceClient.from("stripe_webhook_events").insert({ stripe_event_id: event.id, event_type: event.type });
  if (inserted.error?.code === "23505") return NextResponse.json({ received: true, duplicate: true });
  if (inserted.error) return NextResponse.json({ error: "Could not record event" }, { status: 500 });

  const { data: order } = await routeServiceClient.from("orders").select("id,order_number,product_name,customer_id,agreed_price_cents,order_kind").eq("id", orderId).maybeSingle();
  if (!order || !order.agreed_price_cents || session.metadata?.customer_id !== order.customer_id) {
    await routeServiceClient.from("stripe_webhook_events").delete().eq("stripe_event_id", event.id);
    return NextResponse.json({ error: "Order amount mismatch" }, { status: 409 });
  }
  const paymentIntentId = String(session.payment_intent || "");
  if (!paymentIntentId) {
    await routeServiceClient.from("stripe_webhook_events").delete().eq("stripe_event_id", event.id);
    return NextResponse.json({ error: "Missing payment intent" }, { status: 409 });
  }
  const { data: accounting, error: accountingError } = await routeServiceClient.rpc("record_stripe_order_payment", {
    p_order_id: orderId,
    p_payment_intent_id: paymentIntentId,
    p_amount_cents: session.amount_total,
  });
  if (accountingError) {
    await routeServiceClient.from("stripe_webhook_events").delete().eq("stripe_event_id", event.id);
    captureCommerceException(accountingError, { operation: "record_payment", orderId, stripeEventId: event.id });
    return NextResponse.json({ error: "Could not fulfill payment" }, { status: 500 });
  }
  const result = accounting as { applied?: boolean; duplicate?: boolean; fully_paid?: boolean; amount_paid_cents?: number } | null;
  if (!result?.applied) {
    await routeServiceClient.from("stripe_webhook_events").update({ processed_at: new Date().toISOString() }).eq("stripe_event_id", event.id);
    return NextResponse.json({ received: true, duplicate: Boolean(result?.duplicate) });
  }
  const fullyPaid = Boolean(result.fully_paid);
  const newNetCollected = Number(result.amount_paid_cents || 0);

  // A direct purchase empties its cart only now, once payment is confirmed.
  // Clearing it at session creation would lose the customer's items if they
  // abandoned Stripe; clearing it on the success redirect would trust a URL.
  if (order.order_kind === "direct_purchase") {
    const { data: convertedCart } = await routeServiceClient
      .from("carts")
      .select("id")
      .eq("converted_order_id", orderId)
      .maybeSingle();

    if (convertedCart) {
      await routeServiceClient.from("cart_items").delete().eq("cart_id", convertedCart.id);
      await routeServiceClient
        .from("carts")
        .update({ status: "converted", discount_code: null, updated_at: new Date().toISOString() })
        .eq("id", convertedCart.id);
    }

    // The redemption is recorded against the paid order, so per-customer and
    // total-use limits count real purchases rather than attempts. The RPC locks
    // the code row and is a no-op on repeat, so a replayed webhook cannot
    // double-count a use or race another checkout past the limit.
    const { data: paidOrder } = await routeServiceClient
      .from("orders")
      .select("discount_code_id,discount_cents")
      .eq("id", orderId)
      .maybeSingle();

    if (paidOrder?.discount_code_id && Number(paidOrder.discount_cents) > 0) {
      const { error: redeemError } = await routeServiceClient.rpc("redeem_discount_code", {
        p_code_id: paidOrder.discount_code_id,
        p_order_id: orderId,
        p_customer_id: order.customer_id,
        p_amount_cents: Number(paidOrder.discount_cents),
      });
      // A failed redemption must not fail the payment: the money is already
      // taken and the order is settled. Surface it instead of throwing.
      if (redeemError) {
        captureCommerceException(redeemError, { operation: "redeem_discount", orderId, stripeEventId: event.id });
      }
    }
  }
  const { data: authUser } = await routeServiceClient.auth.admin.getUserById(order.customer_id);
  const config = await getCommerceEmailConfig();
  if (config.sendPaymentUpdates) await sendCommerceEmail({ to:authUser.user?.email, orderId, templateKey:"payment_received", eventKey:`stripe-paid-${event.id}`, variables:{ customer_name:authUser.user?.user_metadata?.display_name || authUser.user?.email?.split("@")[0] || "Customer", product_name:order.product_name, order_label:order.order_number || "your KeyMoura order", status:fullyPaid ? "paid in full" : "deposit received", price:`$${(session.amount_total/100).toFixed(2)}` } });
  await Promise.all([
    notifyOrderUser({
      orderId,
      actorUserId: null,
      recipientUserId: order.customer_id,
      title: "Payment received",
      message: `Your $${(session.amount_total / 100).toFixed(2)} payment was received.${fullyPaid ? " Your order is paid in full." : ` $${((order.agreed_price_cents-newNetCollected)/100).toFixed(2)} remains.`}`,
    }),
    notifyOrderStaff({ orderId, actorUserId:null, title:fullyPaid ? "Order paid in full" : "Deposit received", message:`$${(session.amount_total/100).toFixed(2)} was received for ${order.product_name}. Production is ready to continue.` }),
  ]);
  await routeServiceClient.from("stripe_webhook_events").update({ processed_at: new Date().toISOString() }).eq("stripe_event_id", event.id);
  return NextResponse.json({ received: true });
}
