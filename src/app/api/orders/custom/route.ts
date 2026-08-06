import { NextRequest, NextResponse } from "next/server";
import { requireUser, routeServiceClient } from "@/lib/api/routeAuth";
import { normalizeShippingAddress } from "@/lib/checkout";
import { raiseOperationalAlert } from "@/lib/comms/operationalAlerts";
import { getCommerceEmailConfig, sendCommerceEmail } from "@/lib/commerceEmail";

const clean = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Sign in to submit a custom request." }, { status: 401 });
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const projectType = clean(body.project_type, 80);
  const description = clean(body.description, 5000);
  const quantity = Number(body.quantity);
  if (!projectType || description.length < 20) return NextResponse.json({ error: "Choose a project type and add a useful description." }, { status: 400 });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) return NextResponse.json({ error: "Quantity must be between 1 and 1000." }, { status: 400 });
  const fulfillmentMethod = body.fulfillment_method === "pickup" ? "pickup" : body.fulfillment_method === "shipping" ? "shipping" : null;
  if (!fulfillmentMethod) return NextResponse.json({ error: "Choose shipping or pickup." }, { status: 400 });
  const shippingAddress = fulfillmentMethod === "shipping" ? normalizeShippingAddress(body.shipping_address) : null;
  if (fulfillmentMethod === "shipping" && !shippingAddress) return NextResponse.json({ error: "Enter a complete shipping address." }, { status: 400 });
  const files = Array.isArray(body.files) ? body.files.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)).slice(0, 10) : [];
  if (files.some(file => typeof file.path !== "string" || !file.path.startsWith(`${user.id}/`) || typeof file.name !== "string")) return NextResponse.json({ error: "Invalid uploaded file." }, { status: 400 });
  const specifications = {
    project_type: { label: "Project type", value: projectType, display_value: projectType },
    material: { label: "Material", value: clean(body.material, 120), display_value: clean(body.material, 120) || "Open to recommendation" },
    dimensions: { label: "Dimensions", value: clean(body.dimensions, 300), display_value: clean(body.dimensions, 300) || "See files / discuss" },
    tolerance: { label: "Tolerance", value: clean(body.tolerance, 120), display_value: clean(body.tolerance, 120) || "Standard / advise me" },
    finish: { label: "Finish", value: clean(body.finish, 160), display_value: clean(body.finish, 160) || "Open to recommendation" },
    budget: clean(body.budget, 200) || null,
    files: { label: "Files", value: files.map(file => file.path), display_value: files.map(file => file.name).join(", "), kind: "files" },
  };
  const { data: order, error } = await routeServiceClient.from("orders").insert({
    customer_id: user.id, product_id: null, product_name: clean(body.title, 120) || `${projectType} custom project`, status: "requested",
    quantity, specifications, customer_notes: description,
    target_date: typeof body.target_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.target_date) ? body.target_date : null,
    fulfillment_method: fulfillmentMethod, shipping_address: shippingAddress,
  }).select("id,product_name").single();
  if (error || !order) return NextResponse.json({ error: "Could not create custom request." }, { status: 500 });
  if (typeof body.draft_id === "string") await routeServiceClient.from("order_request_drafts").delete().eq("id", body.draft_id).eq("customer_id", user.id);
  // Deduplicated on the order, so a retried submit cannot ring the bell twice.
  await raiseOperationalAlert({ kind: "order.new_request", subjectId: order.id, actorUserId: user.id, message: `${order.product_name} is ready for review.` });
  const config = await getCommerceEmailConfig();
  const variables = { customer_name:user.email?.split("@")[0] || "Customer", product_name:order.product_name, order_label:"your custom request", status:"requested", price:"Price pending" };
  await Promise.all([
    sendCommerceEmail({ to:user.email, orderId:order.id, templateKey:"request_received", eventKey:`custom-request-customer-${order.id}`, variables }),
    sendCommerceEmail({ to:config.staffNotificationEmail, orderId:order.id, templateKey:"staff_new_request", eventKey:`custom-request-staff-${order.id}`, variables, href:`/staff/orders/${order.id}` }),
  ]);
  return NextResponse.json({ id: order.id }, { status: 201 });
}
