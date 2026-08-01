import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { routeServiceClient } from "@/lib/api/routeAuth";
import { stripeClient } from "@/lib/stripe";
import { getCommerceEmailConfig, sendCommerceEmail } from "@/lib/commerceEmail";
import { notifyOrderUser } from "@/lib/orderNotifications";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const signature = req.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || !secret) return NextResponse.json({ error: "Webhook not configured" }, { status: 400 });
  let event: Stripe.Event;
  try { event = stripeClient().webhooks.constructEvent(await req.text(), signature, secret); }
  catch { return NextResponse.json({ error: "Invalid signature" }, { status: 400 }); }
  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") return NextResponse.json({ received: true });

  const session = event.data.object as Stripe.Checkout.Session;
  if (session.payment_status !== "paid") return NextResponse.json({ received: true });
  const orderId = session.metadata?.order_id || session.client_reference_id;
  if (!orderId || !session.amount_total) return NextResponse.json({ error: "Missing order metadata" }, { status: 400 });

  const inserted = await routeServiceClient.from("stripe_webhook_events").insert({ stripe_event_id: event.id, event_type: event.type });
  if (inserted.error?.code === "23505") return NextResponse.json({ received: true, duplicate: true });
  if (inserted.error) return NextResponse.json({ error: "Could not record event" }, { status: 500 });

  const { data: order } = await routeServiceClient.from("orders").select("id,order_number,product_name,customer_id,agreed_price_cents,amount_paid_cents").eq("id", orderId).maybeSingle();
  const newPaid = (order?.amount_paid_cents || 0) + session.amount_total;
  if (!order || !order.agreed_price_cents || newPaid > order.agreed_price_cents) {
    await routeServiceClient.from("stripe_webhook_events").delete().eq("stripe_event_id", event.id);
    return NextResponse.json({ error: "Order amount mismatch" }, { status: 409 });
  }
  const fullyPaid = newPaid >= order.agreed_price_cents;
  const paymentIntentId = String(session.payment_intent || "");
  if (!paymentIntentId) {
    await routeServiceClient.from("stripe_webhook_events").delete().eq("stripe_event_id", event.id);
    return NextResponse.json({ error: "Missing payment intent" }, { status: 409 });
  }
  const paymentRecord = await routeServiceClient.from("order_payments").insert({ order_id:orderId, stripe_payment_intent_id:paymentIntentId, amount_cents:session.amount_total });
  if (paymentRecord.error?.code !== "23505" && paymentRecord.error) {
    await routeServiceClient.from("stripe_webhook_events").delete().eq("stripe_event_id", event.id);
    return NextResponse.json({ error: "Could not record payment" }, { status: 500 });
  }
  const update = await routeServiceClient.from("orders").update({ payment_status: fullyPaid ? "paid" : "partial", amount_paid_cents: newPaid, stripe_checkout_session_id:null, stripe_payment_intent_id: String(session.payment_intent || ""), paid_at: fullyPaid ? new Date().toISOString() : null, status: "in_progress" }).eq("id", orderId).eq("amount_paid_cents", order.amount_paid_cents || 0);
  if (update.error) {
    await routeServiceClient.from("stripe_webhook_events").delete().eq("stripe_event_id", event.id);
    return NextResponse.json({ error: "Could not fulfill payment" }, { status: 500 });
  }
  const { data: authUser } = await routeServiceClient.auth.admin.getUserById(order.customer_id);
  const config = await getCommerceEmailConfig();
  if (config.sendPaymentUpdates) await sendCommerceEmail({ to:authUser.user?.email, orderId, templateKey:"payment_received", eventKey:`stripe-paid-${event.id}`, variables:{ customer_name:authUser.user?.user_metadata?.display_name || authUser.user?.email?.split("@")[0] || "Customer", product_name:order.product_name, order_label:order.order_number || "your KeyMoura order", status:fullyPaid ? "paid in full" : "deposit received", price:`$${(session.amount_total/100).toFixed(2)}` } });
  await notifyOrderUser({
    orderId,
    actorUserId: null,
    recipientUserId: order.customer_id,
    title: "Payment received",
    message: `Your $${(session.amount_total / 100).toFixed(2)} payment was received.${fullyPaid ? " Your order is paid in full." : ` $${((order.agreed_price_cents-newPaid)/100).toFixed(2)} remains.`}`,
  });
  await routeServiceClient.from("stripe_webhook_events").update({ processed_at: new Date().toISOString() }).eq("stripe_event_id", event.id);
  return NextResponse.json({ received: true });
}
