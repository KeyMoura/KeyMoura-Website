import { NextRequest, NextResponse } from "next/server";
import { requireUser, routeServiceClient } from "@/lib/api/routeAuth";
import { stripeClient } from "@/lib/stripe";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const { data: order, error } = await routeServiceClient.from("orders")
    .select("id,order_number,product_name,customer_id,status,agreed_price_cents,payment_status,stripe_checkout_session_id")
    .eq("id", id).eq("customer_id", user.id).maybeSingle();
  if (error || !order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (!["accepted", "awaiting_payment"].includes(order.status) || !order.agreed_price_cents || order.agreed_price_cents < 50) {
    return NextResponse.json({ error: "This order is not ready for payment." }, { status: 409 });
  }
  if (order.payment_status === "paid") return NextResponse.json({ error: "This order is already paid." }, { status: 409 });

  const stripe = stripeClient();
  if (order.stripe_checkout_session_id) {
    try {
      const existingSession = await stripe.checkout.sessions.retrieve(order.stripe_checkout_session_id);
      if (existingSession.status === "open" && existingSession.amount_total === order.agreed_price_cents && existingSession.url) {
        return NextResponse.json({ url: existingSession.url });
      }
    } catch {
      // A removed/expired test session should not prevent creating a fresh checkout.
    }
  }
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://keymoura.com").replace(/\/$/, "");
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: user.email,
    client_reference_id: order.id,
    metadata: { order_id: order.id, customer_id: user.id },
    payment_intent_data: { metadata: { order_id: order.id, customer_id: user.id } },
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: order.agreed_price_cents, product_data: { name: `${order.order_number || "KeyMoura order"} · ${order.product_name}` } } }],
    success_url: `${siteUrl}/orders/${order.id}?payment=success`,
    cancel_url: `${siteUrl}/orders/${order.id}?payment=cancelled`,
  });
  await routeServiceClient.from("orders").update({ stripe_checkout_session_id: session.id, payment_status: "unpaid", status: "awaiting_payment" }).eq("id", order.id).eq("customer_id", user.id);
  return NextResponse.json({ url: session.url });
}
