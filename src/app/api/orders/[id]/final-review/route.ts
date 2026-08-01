import { NextRequest, NextResponse } from "next/server";
import { requireUser, routeServiceClient } from "@/lib/api/routeAuth";
import { notifyOrderStaff } from "@/lib/orderNotifications";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const { data: order } = await routeServiceClient.from("orders").select("id,customer_id,product_name,status").eq("id", id).eq("customer_id", user.id).maybeSingle();
  if (!order || order.status !== "final_review") return NextResponse.json({ error: "This order is not awaiting final approval." }, { status: 409 });

  const { data: updated, error } = await routeServiceClient.from("orders").update({ status: "ready" }).eq("id", id).eq("customer_id", user.id).eq("status", "final_review").select("id").maybeSingle();
  if (error) return NextResponse.json({ error: "Could not approve the finished order." }, { status: 500 });
  if (!updated) return NextResponse.json({ error: "The order changed. Refresh and try again." }, { status: 409 });

  await routeServiceClient.from("order_status_history").insert({ order_id:id, from_status:"final_review", to_status:"ready", changed_by:user.id, note:"Finished order approved by customer" });
  await notifyOrderStaff({ orderId:id, actorUserId:user.id, title:"Finished order approved", message:`${order.product_name} is approved and ready for fulfillment.` });
  return NextResponse.json({ ok: true });
}
