import { NextRequest, NextResponse } from "next/server";
import { getActorAccessFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { getCommerceEmailConfig, sendCommerceEmail } from "@/lib/commerceEmail";
import { notifyOrderStaff, notifyOrderUser } from "@/lib/orderNotifications";
import { raiseOperationalAlert } from "@/lib/comms/operationalAlerts";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await getActorAccessFromRequest(req);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const body = await req.json().catch(() => null) as { body?: unknown; internal?: unknown; client_token?: unknown } | null;
  const message = typeof body?.body === "string" ? body.body.trim() : "";
  if (!message || message.length > 4000) return NextResponse.json({ error: "Message must be 1–4000 characters." }, { status: 400 });
  const { data: order } = await routeServiceClient.from("orders").select("id,order_number,product_name,customer_id").eq("id", id).maybeSingle();
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  const isStaff = actor.permissions.has("orders.manage");
  if (!isStaff && order.customer_id !== actor.userId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const internal = isStaff && body?.internal === true;

  /*
   * One send, one message, however many times the request arrives.
   *
   * The browser mints a token per composed message. A double click, a retried
   * fetch or a resubmitted form all carry the same one and collide with
   * `order_messages_client_token_idx`, so the second arrival is answered with
   * the first message instead of writing a second row.
   *
   * That is what stops the duplicate *email* too: the delivery is keyed on the
   * message id, which used to be a fresh id on every click and therefore a
   * fresh key. Collapsing the row collapses the notification with it.
   *
   * The token is sanitised rather than trusted — it reaches a unique index, and
   * anything outside this alphabet has no business being an identifier.
   */
  const token = typeof body?.client_token === "string" ? body.client_token.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) : "";

  const { data: inserted, error } = await routeServiceClient
    .from("order_messages")
    .insert({ order_id: id, sender_id: actor.userId, body: message, is_internal: internal, client_token: token || null })
    .select("id")
    .single();

  if (error) {
    // 23505 is the unique violation: this exact send already landed. Answering
    // `ok` is correct — the caller asked for the message to exist, and it does.
    if (token && (error as { code?: string }).code === "23505") {
      const { data: original } = await routeServiceClient
        .from("order_messages")
        .select("id")
        .eq("order_id", id)
        .eq("client_token", token)
        .maybeSingle();
      return NextResponse.json({ ok: true, duplicate: true, id: original?.id ?? null });
    }
    return NextResponse.json({ error: "Could not send message" }, { status: 500 });
  }
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
      // Two readers, two alerts. `notifyOrderStaff` keeps the existing
      // orders.manage fan-out; the operational alert is the deduplicated one
      // that says a reply arrived, keyed on the message so a retried send does
      // not ring twice. Neither carries the message body — a customer's words
      // are on the order page, not in a preview line that appears in a bell,
      // a badge and potentially a push.
      await Promise.all([
        notifyOrderStaff({
          orderId: id,
          actorUserId: actor.userId,
          title: "New customer message",
          message: `A customer sent a message about ${order.product_name}.`,
        }),
        raiseOperationalAlert({
          kind: "order.customer_information_received",
          subjectId: id,
          discriminator: String(inserted.id),
          actorUserId: actor.userId,
          message: `A customer replied about ${order.product_name}.`,
        }),
      ]);
    }
  }
  return NextResponse.json({ ok: true });
}
