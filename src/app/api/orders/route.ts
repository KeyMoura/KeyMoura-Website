import { NextRequest, NextResponse } from "next/server";
import { requireUser, routeServiceClient } from "@/lib/api/routeAuth";
import { notifyOrderStaff } from "@/lib/orderNotifications";
import { getCommerceEmailConfig, sendCommerceEmail } from "@/lib/commerceEmail";

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
    .select("id,name,is_published,is_custom,starting_price_cents,availability_status,inventory_policy,inventory_quantity,continue_selling_when_out_of_stock,archived_at")
    .eq("id", body.product_id)
    .eq("is_published", true)
    .maybeSingle();
  if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });
  if (product.archived_at || product.availability_status === "unavailable") {
    return NextResponse.json({ error: "This product is not accepting requests right now." }, { status: 409 });
  }
  if (product.inventory_policy === "track" && product.inventory_quantity < quantity && !product.continue_selling_when_out_of_stock) {
    return NextResponse.json({ error: product.inventory_quantity > 0 ? `Only ${product.inventory_quantity} available.` : "This product is out of stock." }, { status: 409 });
  }

  const requested = body.specifications && typeof body.specifications === "object" && !Array.isArray(body.specifications)
    ? body.specifications as Record<string, unknown> : {};
  const snapshot: Record<string, unknown> = {};
  let estimate = product.starting_price_cents as number | null;
  if (product.is_custom) {
    const { data: groups, error: groupError } = await routeServiceClient.from("product_option_groups")
      .select("id,name,option_key,input_type,is_required,product_option_values(label,value,price_adjustment_cents,is_active)")
      .eq("product_id", product.id).order("sort_order");
    if (groupError) return NextResponse.json({ error: "Could not validate product options" }, { status: 500 });
    for (const group of groups ?? []) {
      const raw = requested[group.option_key];
      const entry = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const value = entry.value;
      if (group.is_required && (value === null || value === undefined || value === "" || value === false)) {
        return NextResponse.json({ error: `${group.name} is required.` }, { status: 400 });
      }
      const choices = (group.product_option_values ?? []).filter(choice => choice.is_active);
      const choice = choices.find(choice => choice.value === value);
      if (["select", "radio"].includes(group.input_type) && value && !choice) {
        return NextResponse.json({ error: `Invalid selection for ${group.name}.` }, { status: 400 });
      }
      if (group.input_type === "file" && value && (typeof value !== "string" || !value.startsWith(`${user.id}/`))) {
        return NextResponse.json({ error: `Invalid upload for ${group.name}.` }, { status: 400 });
      }
      const adjustment = choice?.price_adjustment_cents ?? 0;
      snapshot[group.option_key] = { label: group.name, value, display_value: choice?.label ?? entry.display_value ?? value, price_adjustment_cents: adjustment, ...(group.input_type === "file" ? { kind: "file" } : {}) };
      if (estimate !== null) estimate += adjustment;
    }
  }
  snapshot.budget = typeof requested.budget === "string" ? requested.budget.slice(0, 200) : null;
  snapshot.estimated_total_cents = estimate === null ? null : estimate * quantity;

  const { data: order, error } = await routeServiceClient.from("orders").insert({
    customer_id: user.id,
    product_id: product.id,
    product_name: product.name,
    quantity,
    specifications: snapshot,
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
  const [{ data: profile }, config] = await Promise.all([
    routeServiceClient.from("profiles").select("display_name,username").eq("id",user.id).maybeSingle(),
    getCommerceEmailConfig(),
  ]);
  const customerName = profile?.display_name || profile?.username || user.email?.split("@")[0] || "Customer";
  const variables = { customer_name:customerName, product_name:product.name, order_label:"your request", status:"requested", price:estimate === null ? "Price pending" : `$${((estimate * quantity)/100).toFixed(2)}` };
  await Promise.all([
    sendCommerceEmail({ to:user.email, orderId:order.id, templateKey:"request_received", eventKey:`request-customer-${order.id}`, variables }),
    sendCommerceEmail({ to:config.staffNotificationEmail, orderId:order.id, templateKey:"staff_new_request", eventKey:`request-staff-${order.id}`, variables, href:`/staff/orders/${order.id}` }),
  ]);
  return NextResponse.json({ id: order.id }, { status: 201 });
}
