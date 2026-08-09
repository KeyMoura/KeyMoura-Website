import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { normalizeShippingAddress } from "@/lib/checkout";
import { raiseOperationalAlert } from "@/lib/comms/operationalAlerts";
import { getCommerceEmailConfig, sendCommerceEmail } from "@/lib/commerceEmail";
import { loadCommerceSettings } from "@/lib/commerce/commerceSettingsServer";
import { consumeRateLimit, rateLimitMessage, RATE_LIMITS } from "@/lib/commerce/rateLimit";
import {
  createGuestOrderToken,
  guestAccessExpiry,
  guestDisplayName,
  GUEST_ORDER_COOKIE,
  guestOrderCookieOptions,
  hashGuestOrderToken,
  parseGuestContact,
  type GuestContact,
} from "@/lib/commerce/guestOrders";
import { turnstileMessage, verifyTurnstile } from "@/lib/security/turnstile";

/**
 * A custom project request, from an account or a guest.
 *
 * A request is an `orders` row with `status = 'requested'` and no money
 * attached, so guest requests need exactly what guest checkout needed — a
 * nullable `customer_id`, an address to reply to, and a credential to come
 * back with. Everything after identity is the same code for both.
 *
 * Three controls guard the guest path, because it is the one surface where a
 * stranger can write a row a staff member has to read and cause an email to
 * leave the building:
 *
 * 1. **A setting** (`guest.allowRequests`), so it can be turned off without a
 *    deploy.
 * 2. **A rate limit**, keyed on the request's own identity, five per hour.
 * 3. **Turnstile, when it is configured.** Unconfigured it is a no-op rather
 *    than a refusal — see `security/turnstile.ts` for why that asymmetry is
 *    deliberate.
 *
 * **Files are not accepted from a guest.** The upload path writes to the
 * `order-assets` bucket under `${user.id}/…`, and the storage policy behind it
 * is keyed on an authenticated user. Letting a stranger upload 50 MB CAD files
 * needs its own bucket, its own signed-upload route and its own retention
 * decision; inventing a storage policy in passing is how a public write bucket
 * happens. A guest describes the part and staff ask for drawings by reply —
 * which the request page supports — and the form says so rather than
 * discarding an attachment silently.
 */

const clean = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  // ---------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------
  let guest: GuestContact | null = null;
  let guestToken: string | null = null;

  if (!user) {
    const settings = await loadCommerceSettings();
    if (!settings.guest.allowRequests) {
      return NextResponse.json(
        { error: "Sign in to submit a custom request.", requiresSignIn: true },
        { status: 401 }
      );
    }

    const parsed = parseGuestContact({ email: body.guest_email, name: body.guest_name });
    if (!parsed.ok) return NextResponse.json({ error: parsed.message, field: parsed.field }, { status: 400 });
    guest = parsed.contact;

    // The limiter's subject is hashed inside `consumeRateLimit`; the address
    // itself never reaches `rate_limit_hits`.
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
    const verdict = await consumeRateLimit(RATE_LIMITS.guestRequest, `${guest.email}|${ip}`);
    if (!verdict.allowed) {
      return NextResponse.json({ error: rateLimitMessage(verdict) }, { status: 429 });
    }

    const turnstile = await verifyTurnstile(body.turnstile_token, ip || null);
    if (!turnstile.ok) {
      return NextResponse.json({ error: turnstileMessage(turnstile) }, { status: 400 });
    }

    guestToken = createGuestOrderToken();
  }

  // ---------------------------------------------------------------------
  // The request itself — identical for both paths
  // ---------------------------------------------------------------------
  const projectType = clean(body.project_type, 80);
  const description = clean(body.description, 5000);
  const quantity = Number(body.quantity);
  if (!projectType || description.length < 20) {
    return NextResponse.json({ error: "Choose a project type and add a useful description." }, { status: 400 });
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
    return NextResponse.json({ error: "Quantity must be between 1 and 1000." }, { status: 400 });
  }
  const fulfillmentMethod =
    body.fulfillment_method === "pickup" ? "pickup" : body.fulfillment_method === "shipping" ? "shipping" : null;
  if (!fulfillmentMethod) return NextResponse.json({ error: "Choose shipping or pickup." }, { status: 400 });
  const shippingAddress =
    fulfillmentMethod === "shipping" ? normalizeShippingAddress(body.shipping_address) : null;
  if (fulfillmentMethod === "shipping" && !shippingAddress) {
    return NextResponse.json({ error: "Enter a complete shipping address." }, { status: 400 });
  }

  /**
   * Attachments, and who may send them.
   *
   * The path check is what makes this safe for an account: a caller can only
   * reference a file already uploaded under their own storage prefix, so a
   * crafted payload cannot attach somebody else's drawing to their own
   * request. A guest has no prefix, so a guest sends no files — and says so
   * rather than having them dropped.
   */
  const files = Array.isArray(body.files)
    ? body.files
        .filter((item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
        )
        .slice(0, 10)
    : [];
  if (files.length) {
    if (!user) {
      return NextResponse.json(
        { error: "Files can be attached once you have an account. Send the request and we will ask for drawings by reply." },
        { status: 400 }
      );
    }
    if (files.some((file) => typeof file.path !== "string" || !file.path.startsWith(`${user.id}/`) || typeof file.name !== "string")) {
      return NextResponse.json({ error: "Invalid uploaded file." }, { status: 400 });
    }
  }

  /**
   * Where this came from, when it came from a product page's "Request a
   * custom version".
   *
   * The product is resolved from the database rather than trusted: the client
   * sends a slug, and the name recorded is the published product's own. A
   * request that quotes an unpublished or invented product name is a request
   * staff would price against something that does not exist.
   */
  const productSlug = clean(body.product_slug, 120);
  let sourceProduct: { id: string; name: string; slug: string } | null = null;
  if (productSlug) {
    const { data } = await routeServiceClient
      .from("products")
      .select("id,name,slug")
      .eq("slug", productSlug)
      .eq("is_published", true)
      .is("archived_at", null)
      .maybeSingle();
    sourceProduct = (data as { id: string; name: string; slug: string } | null) ?? null;
  }

  // Free-form option context, bounded on both key and value and stored as
  // data rather than interpolated into prose anywhere.
  const rawOptions = body.selected_options;
  const selectedOptions: Record<string, string> = {};
  if (rawOptions && typeof rawOptions === "object" && !Array.isArray(rawOptions)) {
    for (const [key, value] of Object.entries(rawOptions as Record<string, unknown>).slice(0, 30)) {
      const label = clean(key, 80);
      const text = clean(value, 200);
      if (label && text) selectedOptions[label] = text;
    }
  }

  const specifications: Record<string, unknown> = {
    project_type: { label: "Project type", value: projectType, display_value: projectType },
    material: { label: "Material", value: clean(body.material, 120), display_value: clean(body.material, 120) || "Open to recommendation" },
    dimensions: { label: "Dimensions", value: clean(body.dimensions, 300), display_value: clean(body.dimensions, 300) || "See files / discuss" },
    tolerance: { label: "Tolerance", value: clean(body.tolerance, 120), display_value: clean(body.tolerance, 120) || "Standard / advise me" },
    finish: { label: "Finish", value: clean(body.finish, 160), display_value: clean(body.finish, 160) || "Open to recommendation" },
    budget: clean(body.budget, 200) || null,
    files: { label: "Files", value: files.map((file) => file.path), display_value: files.map((file) => file.name).join(", "), kind: "files" },
  };

  if (sourceProduct) {
    specifications.based_on = {
      label: "Based on",
      value: sourceProduct.slug,
      display_value: sourceProduct.name,
    };
  }
  if (Object.keys(selectedOptions).length) {
    specifications.chosen_options = {
      label: "Chosen options",
      value: selectedOptions,
      display_value: Object.entries(selectedOptions).map(([key, value]) => `${key}: ${value}`).join(", "),
      kind: "options",
    };
  }

  const { data: order, error } = await routeServiceClient
    .from("orders")
    .insert({
      customer_id: user?.id ?? null,
      guest_email: guest?.email ?? null,
      guest_name: guest?.name ?? null,
      guest_token_hash: guestToken ? hashGuestOrderToken(guestToken) : null,
      guest_access_expires_at: guestToken ? guestAccessExpiry() : null,
      product_id: sourceProduct?.id ?? null,
      product_name: clean(body.title, 120) || `${projectType} custom project`,
      status: "requested",
      quantity,
      specifications,
      customer_notes: description,
      target_date:
        typeof body.target_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.target_date) ? body.target_date : null,
      fulfillment_method: fulfillmentMethod,
      shipping_address: shippingAddress,
    })
    .select("id,product_name")
    .single();

  if (error || !order) return NextResponse.json({ error: "Could not create custom request." }, { status: 500 });

  if (user && typeof body.draft_id === "string") {
    await routeServiceClient.from("order_request_drafts").delete().eq("id", body.draft_id).eq("customer_id", user.id);
  }

  // Deduplicated on the order, so a retried submit cannot ring the bell twice.
  await raiseOperationalAlert({
    kind: "order.new_request",
    subjectId: order.id,
    actorUserId: user?.id ?? null,
    message: `${order.product_name} is ready for review.${user ? "" : " Submitted as a guest."}`,
  });

  const config = await getCommerceEmailConfig();
  const recipient = user ? user.email : guest?.email;
  const customerName = user
    ? user.email?.split("@")[0] || "Customer"
    : guestDisplayName(guest ?? { email: "" });
  const variables = {
    customer_name: customerName,
    product_name: order.product_name,
    order_label: "your custom request",
    status: "requested",
    price: "Price pending",
  };

  await Promise.all([
    sendCommerceEmail({
      to: recipient,
      orderId: order.id,
      templateKey: "request_received",
      eventKey: `custom-request-customer-${order.id}`,
      variables,
    }),
    sendCommerceEmail({
      to: config.staffNotificationEmail,
      orderId: order.id,
      templateKey: "staff_new_request",
      eventKey: `custom-request-staff-${order.id}`,
      variables,
      href: `/staff/orders/${order.id}`,
    }),
  ]);

  const response = NextResponse.json(
    { id: order.id, href: guestToken ? `/orders/guest/${order.id}` : `/orders/${order.id}/confirmed` },
    { status: 201 }
  );

  if (guestToken) {
    response.cookies.set(GUEST_ORDER_COOKIE, guestToken, guestOrderCookieOptions());
  }

  return response;
}
