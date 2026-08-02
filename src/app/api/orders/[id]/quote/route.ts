import { NextRequest, NextResponse } from "next/server";
import { requireUser, routeServiceClient } from "@/lib/api/routeAuth";
import { notifyOrderStaff } from "@/lib/orderNotifications";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const { data: order } = await routeServiceClient.from("orders").select("id,customer_id,status,quote_revision,quote_accepted_at,agreed_price_cents,quote_expires_at").eq("id", id).eq("customer_id", user.id).maybeSingle();
  if (!order || order.status !== "customer_review" || order.quote_accepted_at || !order.agreed_price_cents) return NextResponse.json({ error: "This quote is not ready for approval." }, { status: 409 });
  if (order.quote_expires_at && new Date(order.quote_expires_at).getTime() <= Date.now()) return NextResponse.json({ error: "This quote has expired. Message KeyMoura to request an updated quote." }, { status: 409 });
  const acceptedAt = new Date().toISOString();
  const { error } = await routeServiceClient.from("orders").update({ status:"awaiting_payment", quote_accepted_at:acceptedAt, payment_status:"unpaid" }).eq("id", id).eq("quote_revision", order.quote_revision);
  if (error) return NextResponse.json({ error: "Could not approve quote." }, { status: 500 });
  await routeServiceClient.from("order_quotes").update({ accepted_at:acceptedAt }).eq("order_id", id).eq("revision", order.quote_revision);
  await routeServiceClient.from("order_status_history").insert({ order_id:id, from_status:"customer_review", to_status:"awaiting_payment", changed_by:user.id, note:`Quote revision ${order.quote_revision} approved by customer` });
  await notifyOrderStaff({ orderId:id, actorUserId:user.id, title:"Quote approved", message:`The customer approved quote revision ${order.quote_revision} and can now pay.` });
  return NextResponse.json({ ok:true });
}
