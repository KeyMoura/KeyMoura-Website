import { NextRequest, NextResponse } from "next/server";
import { requireUser, routeServiceClient } from "@/lib/api/routeAuth";
import { notifyOrderStaff } from "@/lib/orderNotifications";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const action = body?.action === "decline" ? "decline" : body?.action === "accept" ? "accept" : null;
  if (!action) return NextResponse.json({ error: "Choose accept or decline." }, { status: 400 });
  const { data: order } = await routeServiceClient.from("orders").select("id,customer_id,product_name,status,initiated_by_staff").eq("id", id).eq("customer_id", user.id).maybeSingle();
  if (!order || !order.initiated_by_staff || order.status !== "requested") return NextResponse.json({ error: "This proposal is no longer awaiting your decision." }, { status: 409 });
  const now = new Date().toISOString();
  if (action === "decline") {
    const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 1000) : "";
    if (reason.length < 3) return NextResponse.json({ error: "Please tell KeyMoura why you are declining." }, { status: 400 });
    const { data: updated, error } = await routeServiceClient.from("orders").update({ status: "declined", proposal_decided_at: now, proposal_decline_reason: reason }).eq("id", id).eq("status", "requested").select("id").maybeSingle();
    if (error || !updated) return NextResponse.json({ error: "The proposal changed. Refresh and try again." }, { status: 409 });
    await Promise.all([
      routeServiceClient.from("order_status_history").insert({ order_id:id, from_status:"requested", to_status:"declined", changed_by:user.id, note:`Customer declined proposal: ${reason}` }),
      notifyOrderStaff({ orderId:id, actorUserId:user.id, title:"Proposal declined", message:`The customer declined ${order.product_name}: ${reason}` }),
    ]);
    return NextResponse.json({ ok: true, action });
  }
  const { data: accepted, error } = await routeServiceClient.rpc("accept_staff_order_proposal", { p_order_id:id, p_customer_id:user.id });
  if (error) {
    if (error.message.includes("insufficient_inventory")) return NextResponse.json({ error: "This item no longer has enough stock for the proposal. Message KeyMoura to update it." }, { status: 409 });
    if (error.message.includes("product_unavailable")) return NextResponse.json({ error: "This item is no longer available. Message KeyMoura to update the proposal." }, { status: 409 });
    return NextResponse.json({ error: "Could not accept the proposal. Refresh and try again." }, { status: 500 });
  }
  if (!accepted) return NextResponse.json({ error: "The proposal changed. Refresh and try again." }, { status: 409 });
  await Promise.all([
    routeServiceClient.from("order_status_history").insert({ order_id:id, from_status:"requested", to_status:"accepted", changed_by:user.id, note:"Customer accepted staff proposal" }),
    notifyOrderStaff({ orderId:id, actorUserId:user.id, title:"Proposal accepted", message:`The customer accepted ${order.product_name}. It is ready for payment and production.` }),
  ]);
  return NextResponse.json({ ok: true, action });
}
