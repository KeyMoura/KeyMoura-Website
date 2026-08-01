import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { getCommerceEmailConfig, sendCommerceEmail, type CommerceEmailTemplateKey } from "@/lib/commerceEmail";
import { notifyOrderUser } from "@/lib/orderNotifications";

const allowedStatuses = new Set(["requested","needs_information","accepted","awaiting_payment","in_progress","customer_review","ready","completed","declined","cancelled"]);
const allowedFulfillmentMethods = new Set(["shipping", "pickup"]);
const optionalText = (value: unknown, max: number) => value === null ? null : typeof value === "string" ? value.trim().slice(0, max) || null : undefined;

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
  if (body.deposit_amount_cents === null || Number.isInteger(body.deposit_amount_cents)) {
    const total = typeof body.agreed_price_cents === "number" ? body.agreed_price_cents : existing.agreed_price_cents;
    if (typeof body.deposit_amount_cents === "number" && (body.deposit_amount_cents < 50 || !total || body.deposit_amount_cents > total)) return NextResponse.json({ error: "Deposit must be at least $0.50 and no more than the quote total." }, { status: 400 });
    update.deposit_amount_cents = body.deposit_amount_cents;
  }
  if (typeof body.target_date === "string" || body.target_date === null) update.target_date = body.target_date;
  if (typeof body.quote_expires_at === "string" || body.quote_expires_at === null) {
    if (body.quote_expires_at && Number.isNaN(new Date(body.quote_expires_at).getTime())) return NextResponse.json({ error: "Invalid quote expiration date." }, { status: 400 });
    update.quote_expires_at = body.quote_expires_at;
  }
  if (typeof body.staff_notes === "string" || body.staff_notes === null) update.staff_notes = body.staff_notes;
  if (typeof body.fulfillment_method === "string") {
    if (!allowedFulfillmentMethods.has(body.fulfillment_method)) return NextResponse.json({ error: "Invalid fulfillment method" }, { status: 400 });
    update.fulfillment_method = body.fulfillment_method;
  }
  if (body.shipping_address === null || (typeof body.shipping_address === "object" && !Array.isArray(body.shipping_address))) update.shipping_address = body.shipping_address;
  for (const [key, max] of [["shipping_carrier",80],["tracking_number",160],["tracking_url",1000]] as const) {
    const value = optionalText(body[key], max);
    if (value !== undefined) update[key] = value;
  }
  if (update.tracking_url && !/^https:\/\//i.test(String(update.tracking_url))) return NextResponse.json({ error: "Tracking link must use https://" }, { status: 400 });
  const shipmentAction = body.shipment_action;
  if (shipmentAction === "mark_shipped") {
    if ((update.fulfillment_method || existing.fulfillment_method) === "shipping" && !(update.tracking_number || existing.tracking_number)) return NextResponse.json({ error: "Add a tracking number before marking this order shipped." }, { status: 400 });
    update.shipped_at = existing.shipped_at || new Date().toISOString();
    update.status = "ready";
  } else if (shipmentAction === "mark_delivered") {
    update.shipped_at = existing.shipped_at || new Date().toISOString();
    update.delivered_at = existing.delivered_at || new Date().toISOString();
    update.status = "completed";
  }
  if (typeof update.agreed_price_cents === "number" && update.agreed_price_cents > 0 && existing.payment_status !== "paid") {
    update.payment_status = "unpaid";
    if (update.agreed_price_cents !== existing.agreed_price_cents || (update.deposit_amount_cents !== undefined && update.deposit_amount_cents !== existing.deposit_amount_cents)) {
      update.quote_revision = (existing.quote_revision || 0) + 1;
      update.quote_accepted_at = null;
      update.stripe_checkout_session_id = null;
      if (!body.status) update.status = "customer_review";
    }
  }
  if (update.status === "cancelled" && existing.status !== "cancelled") {
    const reason = optionalText(body.cancellation_reason, 1000);
    if (!reason) return NextResponse.json({ error: "A cancellation reason is required." }, { status: 400 });
    update.cancelled_at = new Date().toISOString();
    update.cancellation_reason = reason;
    update.stripe_checkout_session_id = null;
  }
  const { error } = await routeServiceClient.from("orders").update(update).eq("id", id);
  if (error) return NextResponse.json({ error: "Could not update order" }, { status: 500 });
  if (typeof update.quote_revision === "number" && typeof update.agreed_price_cents === "number") {
    await routeServiceClient.from("order_quotes").insert({ order_id:id, revision:update.quote_revision, total_cents:update.agreed_price_cents, deposit_cents:update.deposit_amount_cents ?? existing.deposit_amount_cents, note:optionalText(body.quote_note,2000), created_by:actor.userId });
  }
  let historyId: number|string = Date.now();
  if (update.status && update.status !== existing.status) {
    const { data: history } = await routeServiceClient.from("order_status_history").insert({ order_id: id, from_status: existing.status, to_status: update.status, changed_by: actor.userId }).select("id").single();
    historyId = history?.id ?? historyId;
  }

  const { data: customer } = await routeServiceClient.auth.admin.getUserById(existing.customer_id);
  const priceBecamePayable = typeof update.quote_revision === "number" && typeof update.agreed_price_cents === "number" && update.agreed_price_cents > 0;
  const statusChanged = typeof update.status === "string" && update.status !== existing.status;
  if (priceBecamePayable || statusChanged) {
    const finalStatus = String(update.status || existing.status).replaceAll("_", " ");
    const message = priceBecamePayable ? `Quote revision ${update.quote_revision} is ready: $${(Number(update.agreed_price_cents) / 100).toFixed(2)}. Review and approve it from your order page.` : `Your order status changed to ${finalStatus}.`;
    const config = await getCommerceEmailConfig();
    const templateKey: CommerceEmailTemplateKey = priceBecamePayable ? "quote_ready" : update.status === "needs_information" ? "needs_information" : "status_update";
    if ((priceBecamePayable || update.status === "awaiting_payment") ? config.sendPaymentUpdates : config.sendStatusUpdates) await sendCommerceEmail({ to:customer.user?.email, orderId:id, templateKey, eventKey:`order-update-${id}-${historyId}-${templateKey}`, variables:{ customer_name:customer.user?.user_metadata?.display_name || customer.user?.email?.split("@")[0] || "Customer", product_name:existing.product_name, order_label:existing.order_number || "your request", status:finalStatus, price:typeof update.agreed_price_cents === "number" ? `$${(update.agreed_price_cents/100).toFixed(2)}` : "Price pending" } });
    await notifyOrderUser({
      orderId: id,
      actorUserId: actor.userId,
      recipientUserId: existing.customer_id,
      title: priceBecamePayable ? "Quote ready for review" : "Order status updated",
      message,
    });
  }
  if ((shipmentAction === "mark_shipped" && !existing.shipped_at) || (shipmentAction === "mark_delivered" && !existing.delivered_at)) {
    const delivered = shipmentAction === "mark_delivered";
    const templateKey: CommerceEmailTemplateKey = delivered ? "order_delivered" : "order_shipped";
    const carrier = String(update.shipping_carrier || existing.shipping_carrier || (update.fulfillment_method === "pickup" || existing.fulfillment_method === "pickup" ? "KeyMoura pickup" : "Carrier"));
    const trackingNumber = String(update.tracking_number || existing.tracking_number || "Not applicable");
    await sendCommerceEmail({ to:customer.user?.email, orderId:id, templateKey, eventKey:`order-fulfillment-${id}-${templateKey}`, variables:{ customer_name:customer.user?.user_metadata?.display_name || customer.user?.email?.split("@")[0] || "Customer", product_name:existing.product_name, order_label:existing.order_number || "your order", status:delivered ? "delivered" : "shipped", price:"", carrier, tracking_number:trackingNumber }, href:!delivered && String(update.tracking_url || existing.tracking_url || "").startsWith("https://") ? String(update.tracking_url || existing.tracking_url) : `/orders/${id}` });
    await notifyOrderUser({ orderId:id, actorUserId:actor.userId, recipientUserId:existing.customer_id, title:delivered ? "Order delivered" : "Order shipped", message:delivered ? `${existing.product_name} was marked delivered.` : `${existing.product_name} has shipped. Tracking: ${trackingNumber}` });
  }
  return NextResponse.json({ ok: true });
}
