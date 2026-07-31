import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { getCommerceEmailConfig, sendCommerceEmail, type CommerceEmailTemplateKey } from "@/lib/commerceEmail";
import { notifyOrderUser } from "@/lib/orderNotifications";

const allowedStatuses = new Set(["requested","needs_information","accepted","awaiting_payment","in_progress","customer_review","ready","completed","declined","cancelled"]);

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "orders.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await context.params;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { data: existing } = await routeServiceClient.from("orders").select("*").eq("id", id).maybeSingle();
  if (!existing) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const update: Record<string, unknown> = {};
  if (typeof body.status === "string") {
    if (!allowedStatuses.has(body.status)) return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    update.status = body.status;
  }
  if (body.agreed_price_cents === null || Number.isInteger(body.agreed_price_cents)) {
    if (existing.payment_status === "paid" && body.agreed_price_cents !== existing.agreed_price_cents) return NextResponse.json({ error: "A paid order's price cannot be changed." }, { status: 409 });
    if (typeof body.agreed_price_cents === "number" && body.agreed_price_cents < 0) return NextResponse.json({ error: "Price cannot be negative." }, { status: 400 });
    update.agreed_price_cents = body.agreed_price_cents;
  }
  if (typeof body.target_date === "string" || body.target_date === null) update.target_date = body.target_date;
  if (typeof body.staff_notes === "string" || body.staff_notes === null) update.staff_notes = body.staff_notes;
  if (typeof update.agreed_price_cents === "number" && update.agreed_price_cents > 0 && existing.payment_status !== "paid") {
    update.payment_status = "unpaid";
    if (!body.status && ["accepted", "requested"].includes(existing.status)) update.status = "awaiting_payment";
  }
  const { error } = await routeServiceClient.from("orders").update(update).eq("id", id);
  if (error) return NextResponse.json({ error: "Could not update order" }, { status: 500 });
  let historyId: number|string = Date.now();
  if (update.status && update.status !== existing.status) {
    const { data: history } = await routeServiceClient.from("order_status_history").insert({ order_id: id, from_status: existing.status, to_status: update.status, changed_by: actor.userId }).select("id").single();
    historyId = history?.id ?? historyId;
  }

  const { data: customer } = await routeServiceClient.auth.admin.getUserById(existing.customer_id);
  const priceBecamePayable = typeof update.agreed_price_cents === "number" && update.agreed_price_cents > 0 && update.agreed_price_cents !== existing.agreed_price_cents;
  const statusChanged = typeof update.status === "string" && update.status !== existing.status;
  if (priceBecamePayable || statusChanged) {
    const finalStatus = String(update.status || existing.status).replaceAll("_", " ");
    const message = priceBecamePayable ? `Your final price is $${(Number(update.agreed_price_cents) / 100).toFixed(2)}. You can now pay securely from your order page.` : `Your order status changed to ${finalStatus}.`;
    const config = await getCommerceEmailConfig();
    const templateKey: CommerceEmailTemplateKey = priceBecamePayable ? "quote_ready" : update.status === "needs_information" ? "needs_information" : "status_update";
    if ((priceBecamePayable || update.status === "awaiting_payment") ? config.sendPaymentUpdates : config.sendStatusUpdates) await sendCommerceEmail({ to:customer.user?.email, orderId:id, templateKey, eventKey:`order-update-${id}-${historyId}-${templateKey}`, variables:{ customer_name:customer.user?.user_metadata?.display_name || customer.user?.email?.split("@")[0] || "Customer", product_name:existing.product_name, order_label:existing.order_number || "your request", status:finalStatus, price:typeof update.agreed_price_cents === "number" ? `$${(update.agreed_price_cents/100).toFixed(2)}` : "Price pending" } });
    await notifyOrderUser({
      orderId: id,
      actorUserId: actor.userId,
      recipientUserId: existing.customer_id,
      title: priceBecamePayable ? "Order ready for payment" : "Order status updated",
      message,
    });
  }
  return NextResponse.json({ ok: true });
}
