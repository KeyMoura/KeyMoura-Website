import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/routeAuth";
import { sendCommerceEmail } from "@/lib/commerceEmail";

export async function POST(req: NextRequest) {
  const actor = await requirePermission(req,"emails.manage");
  if (!actor) return NextResponse.json({ error:"Forbidden" }, { status:403 });
  const body = await req.json().catch(() => null) as { to?:unknown }|null;
  const to = typeof body?.to === "string" ? body.to.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return NextResponse.json({ error:"Enter a valid test address." }, { status:400 });
  const result = await sendCommerceEmail({ to, templateKey:"status_update", eventKey:`test-${actor.userId}-${Date.now()}`, variables:{ customer_name:"Ethan", product_name:"KeyMoura sample product", order_label:"KM-TEST", status:"in progress", price:"$125.00" }, href:"/account/orders" });
  return NextResponse.json(result, { status:result.sent ? 200 : 502 });
}
