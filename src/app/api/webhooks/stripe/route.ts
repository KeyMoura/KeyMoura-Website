import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { routeServiceClient } from "@/lib/api/routeAuth";
import { stripeClient } from "@/lib/stripe";
import { sendOrderEmail } from "@/lib/commerceEmail";

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

  const { data: order } = await routeServiceClient.from("orders").select("id,order_number,product_name,customer_id,agreed_price_cents").eq("id", orderId).maybeSingle();
  if (!order || order.agreed_price_cents !== session.amount_total) {
    await routeServiceClient.from("stripe_webhook_events").delete().eq("stripe_event_id", event.id);
    return NextResponse.json({ error: "Order amount mismatch" }, { status: 409 });
  }
  const update = await routeServiceClient.from("orders").update({ payment_status: "paid", amount_paid_cents: session.amount_total, stripe_payment_intent_id: String(session.payment_intent || ""), paid_at: new Date().toISOString(), status: "in_progress" }).eq("id", orderId).eq("agreed_price_cents", session.amount_total);
  if (update.error) {
    await routeServiceClient.from("stripe_webhook_events").delete().eq("stripe_event_id", event.id);
    return NextResponse.json({ error: "Could not fulfill payment" }, { status: 500 });
  }
  const { data: authUser } = await routeServiceClient.auth.admin.getUserById(order.customer_id);
  await sendOrderEmail({ to: authUser.user?.email, orderId, orderNumber: order.order_number, productName: order.product_name, subject: `Payment received for ${order.order_number || "your KeyMoura order"}`, message: `We received your $${(session.amount_total / 100).toFixed(2)} payment. Your order is now in progress.`, eventKey: `stripe-paid-${event.id}` });
  await routeServiceClient.from("stripe_webhook_events").update({ processed_at: new Date().toISOString() }).eq("stripe_event_id", event.id);
  return NextResponse.json({ received: true });
}
