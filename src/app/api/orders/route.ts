import { NextRequest, NextResponse } from "next/server";
import { requireUser, routeServiceClient } from "@/lib/api/routeAuth";
import { notifyOrderStaff } from "@/lib/orderNotifications";

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.product_id !== "string") {
    return NextResponse.json({ error: "Invalid order request" }, { status: 400 });
  }
  const quantity = Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
    return NextResponse.json({ error: "Quantity must be between 1 and 1000." }, { status: 400 });
  }

  const { data: product } = await routeServiceClient.from("products")
    .select("id,name,is_published")
    .eq("id", body.product_id)
    .eq("is_published", true)
    .maybeSingle();
  if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });

  const { data: order, error } = await routeServiceClient.from("orders").insert({
    customer_id: user.id,
    product_id: product.id,
    product_name: product.name,
    quantity,
    specifications: body.specifications && typeof body.specifications === "object" ? body.specifications : {},
    customer_notes: typeof body.customer_notes === "string" ? body.customer_notes.trim() || null : null,
    target_date: typeof body.target_date === "string" && body.target_date ? body.target_date : null,
  }).select("id").single();
  if (error || !order) return NextResponse.json({ error: "Could not create order request" }, { status: 500 });

  await notifyOrderStaff({
    orderId: order.id,
    actorUserId: user.id,
    title: "New order request",
    message: `${product.name} was requested and is ready for review.`,
  });
  return NextResponse.json({ id: order.id }, { status: 201 });
}
