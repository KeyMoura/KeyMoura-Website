import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { notifyOrderUser } from "@/lib/orderNotifications";

const clean = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

export async function GET(req: NextRequest) {
  const actor = await requirePermission(req, "orders.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const [{ data: customers, error: customerError }, { data: products, error: productError }] = await Promise.all([
    routeServiceClient.from("profiles").select("id,username,display_name").order("display_name", { ascending: true }),
    routeServiceClient.from("products").select("id,name,starting_price_cents,is_published,archived_at").is("archived_at", null).order("name"),
  ]);
  if (customerError || productError) return NextResponse.json({ error: "Could not load proposal choices." }, { status: 500 });
  return NextResponse.json({ customers: customers ?? [], products: products ?? [] });
}

export async function POST(req: NextRequest) {
  const actor = await requirePermission(req, "orders.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid proposal." }, { status: 400 });
  const customerId = clean(body.customer_id, 80);
  const productId = clean(body.product_id, 80) || null;
  const quantity = Number(body.quantity);
  const price = Number(body.agreed_price_cents);
  const deposit = body.deposit_amount_cents === null || body.deposit_amount_cents === "" ? null : Number(body.deposit_amount_cents);
  const fulfillmentMethod = body.fulfillment_method === "pickup" ? "pickup" : body.fulfillment_method === "shipping" ? "shipping" : null;
  if (!customerId || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000) return NextResponse.json({ error: "Choose a customer and enter a valid quantity." }, { status: 400 });
  if (!Number.isInteger(price) || price < 50) return NextResponse.json({ error: "Total price must be at least $0.50." }, { status: 400 });
  if (deposit !== null && (!Number.isInteger(deposit) || deposit < 50 || deposit > price)) return NextResponse.json({ error: "Deposit must be at least $0.50 and no more than the total." }, { status: 400 });
  if (!fulfillmentMethod) return NextResponse.json({ error: "Choose shipping or pickup." }, { status: 400 });
  const { data: customer } = await routeServiceClient.from("profiles").select("id").eq("id", customerId).maybeSingle();
  if (!customer) return NextResponse.json({ error: "Customer not found." }, { status: 404 });
  let productName = clean(body.product_name, 120);
  if (productId) {
    const { data: product } = await routeServiceClient.from("products").select("id,name").eq("id", productId).maybeSingle();
    if (!product) return NextResponse.json({ error: "Product not found." }, { status: 404 });
    productName = product.name;
  }
  if (productName.length < 2) return NextResponse.json({ error: "Enter an item name." }, { status: 400 });
  const note = clean(body.customer_notes, 5000);
  const now = new Date().toISOString();
  const { data: order, error } = await routeServiceClient.from("orders").insert({
    customer_id: customerId,
    product_id: productId,
    product_name: productName,
    status: "requested",
    quantity,
    specifications: { proposal_summary: { label: "Proposal details", value: note, display_value: note || "No additional details" } },
    customer_notes: note || null,
    agreed_price_cents: price,
    deposit_amount_cents: deposit,
    payment_status: "not_required",
    fulfillment_method: fulfillmentMethod,
    target_date: typeof body.target_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.target_date) ? body.target_date : null,
    initiated_by_staff: true,
    proposal_sent_at: now,
  }).select("id").single();
  if (error || !order) return NextResponse.json({ error: "Could not create proposal." }, { status: 500 });
  await Promise.all([
    routeServiceClient.from("order_status_history").insert({ order_id: order.id, from_status: null, to_status: "requested", changed_by: actor.userId, note: "Order proposal sent to customer" }),
    notifyOrderUser({ orderId: order.id, actorUserId: actor.userId, recipientUserId: customerId, title: "New order proposal", message: `KeyMoura sent you a ${productName} proposal for $${(price / 100).toFixed(2)}. Review, accept, or decline it.` }),
  ]);
  return NextResponse.json({ id: order.id }, { status: 201 });
}
