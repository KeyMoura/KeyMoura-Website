import { NextRequest, NextResponse } from "next/server";
import { getActorAccessFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { getCommerceEmailConfig, sendCommerceEmail } from "@/lib/commerceEmail";
import { notifyOrderStaff, notifyOrderUser } from "@/lib/orderNotifications";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await getActorAccessFromRequest(req);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const body = await req.json().catch(() => null) as { body?: unknown; internal?: unknown } | null;
  const message = typeof body?.body === "string" ? body.body.trim() : "";
  if (!message || message.length > 4000) return NextResponse.json({ error: "Message must be 1–4000 characters." }, { status: 400 });
  const { data: order } = await routeServiceClient.from("orders").select("id,order_number,product_name,customer_id").eq("id", id).maybeSingle();
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  const isStaff = actor.permissions.has("orders.manage");
  if (!isStaff && order.customer_id !== actor.userId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const internal = isStaff && body?.internal === true;
  const { data: inserted, error } = await routeServiceClient.from("order_messages").insert({ order_id: id, sender_id: actor.userId, body: message, is_internal: internal }).select("id").single();
  if (error) return NextResponse.json({ error: "Could not send message" }, { status: 500 });
  if (!internal) {
    const { data: customer } = await routeServiceClient.auth.admin.getUserById(order.customer_id);
    const config = await getCommerceEmailConfig();
    const to = isStaff ? customer.user?.email : config.staffNotificationEmail;
    if (config.sendCustomerMessages) await sendCommerceEmail({ to, orderId:id, templateKey:isStaff ? "customer_message" : "staff_message", eventKey:`order-message-${inserted.id}`, variables:{ customer_name:customer.user?.user_metadata?.display_name || customer.user?.email?.split("@")[0] || "Customer", product_name:order.product_name, order_label:order.order_number || "a KeyMoura request", status:"", price:"" }, href:isStaff ? `/orders/${id}` : `/staff/orders/${id}` });
    if (isStaff) {
      await notifyOrderUser({
        orderId: id,
        actorUserId: actor.userId,
        recipientUserId: order.customer_id,
        title: "New order message",
        message: `KeyMoura sent a message about ${order.product_name}.`,
      });
    } else {
      await notifyOrderStaff({
        orderId: id,
        actorUserId: actor.userId,
        title: "New customer message",
        message: `A customer sent a message about ${order.product_name}.`,
      });
    }
  }
  return NextResponse.json({ ok: true });
}
