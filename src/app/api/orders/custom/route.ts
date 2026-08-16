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
import {
  ACCEPTED_FILE_EXTENSIONS,
  MAX_FILE_BYTES,
  MAX_REQUEST_FILES,
  deliveryLabel,
  describeBudget,
  describeDimensions,
  describeFinish,
  describeMaterial,
  describeTiming,
  emptyCustomRequest,
  emptyDimensions,
  fileExtension,
  fulfillmentMethodFor,
  normalizeReferenceUrl,
  requestType,
  requestTypeLabel,
  resolvedTitle,
  validateAll,
  type CustomRequestForm,
  type DeliveryIntent,
} from "@/lib/orders/customRequest";

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
 * is keyed on an authenticated user. Letting a stranger upload 20 MB CAD files
 * needs its own bucket, its own signed-upload route and its own retention
 * decision; inventing a storage policy in passing is how a public write bucket
 * happens. A guest describes the part and staff ask for drawings by reply —
 * which the request page supports — and the form says so rather than
 * discarding an attachment silently.
 *
 * ## What this route validates, and why it validates it again
 *
 * The rules live in `lib/orders/customRequest` and the wizard imports the same
 * ones. That is a way of making the two agree, not a way of trusting the
 * browser: below, the body is read into a form object *this route* builds, and
 * `validateAll` runs against that. Nothing the client claims to have checked is
 * taken as checked, and the fields that matter — quantity bounds, budget
 * amounts, the reference URL's scheme, every file's extension and owner — are
 * decided here.
 *
 * ## Two payload shapes, on purpose
 *
 * `/orders/new` sends the full form. The product page's own request form
 * (`ProductRequestForm`) still sends the older, smaller shape — a free-text
 * `project_type`, a free-text `budget`, a required `fulfillment_method`. Both
 * are accepted. Rewriting the product page's form to match would have meant
 * touching Product Customization 2.0 to deliver a change to `/orders/new`, so
 * instead the body is normalised once, at the top, and everything after that
 * point handles one shape.
 */

const clean = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type UploadedFile = { path: string; name: string; size: number; note: string };

/**
 * The body, as a form this route is willing to reason about.
 *
 * Every field is taken from the request explicitly. Spreading the body into a
 * form object would let an unexpected key ride along into `specifications`.
 */
function readForm(body: Record<string, unknown>): CustomRequestForm {
  const base = emptyCustomRequest();
  const typeId = clean(body.request_type, 40);
  const dimensions = (body.dimensions ?? {}) as Record<string, unknown>;

  const quantity = Number(body.quantity);
  const deliveryRaw = clean(body.delivery, 20);
  const legacyMethod = clean(body.fulfillment_method, 20);
  const delivery: DeliveryIntent =
    deliveryRaw === "shipping" || deliveryRaw === "pickup" || deliveryRaw === "undecided"
      ? deliveryRaw
      : legacyMethod === "pickup"
        ? "pickup"
        : legacyMethod === "shipping"
          ? "shipping"
          : "undecided";

  const budgetMode = clean(body.budget_mode, 12);

  return {
    ...base,
    request_type: requestType(typeId) ? (typeId as CustomRequestForm["request_type"]) : "",
    product_slug: clean(body.product_slug, 120),
    title: clean(body.title, 120),
    description: clean(body.description, 5000),
    context: clean(body.context, 300),
    dimensions_known: body.dimensions_known === "help" ? "help" : "known",
    dimensions: {
      ...emptyDimensions(),
      length: clean(dimensions.length, 60),
      width: clean(dimensions.width, 60),
      height: clean(dimensions.height, 60),
      diameter: clean(dimensions.diameter, 60),
      thread: clean(dimensions.thread, 60),
      notes: clean(dimensions.notes, 300),
    },
    material: clean(body.material, 40),
    material_other: clean(body.material_other, 120),
    finish: clean(body.finish, 40),
    finish_other: clean(body.finish_other, 120),
    reference_url: clean(body.reference_url, 500),
    quantity: Number.isFinite(quantity) ? quantity : Number.NaN,
    repeatability: body.repeatability === "repeatable" ? "repeatable" : "one-off",
    budget_mode: budgetMode === "target" || budgetMode === "range" ? budgetMode : "none",
    budget_min: clean(body.budget_min, 12),
    budget_max: clean(body.budget_max, 12),
    timing: body.timing === "asap" ? "asap" : body.timing === "by-date" ? "by-date" : "flexible",
    target_date: clean(body.target_date, 10),
    delivery,
    postal_code: clean(body.postal_code, 24),
    country: clean(body.country, 2).toUpperCase() || "US",
    guest_email: "",
    guest_name: "",
  };
}

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const form = readForm(body);

  /**
   * The older payload's free-text project type.
   *
   * When it is present and `request_type` is not, this is a product-page
   * request. It still has to name its project, so the legacy string carries
   * that — but it never becomes a `RequestTypeId`, because it is not one.
   */
  const legacyProjectType = clean(body.project_type, 80);
  const typeLabel = requestTypeLabel(form.request_type) || legacyProjectType;
  if (!typeLabel) {
    return NextResponse.json(
      { error: "Choose the kind of project so we know what to ask.", field: "request_type" },
      { status: 400 }
    );
  }

  /*
   * The same rules the wizard ran, run again here on this route's own reading
   * of the request. `request_type` is exempted for the legacy shape, which
   * satisfies the requirement through `project_type` instead.
   */
  const problems = validateAll(form).filter((problem) => {
    if (problem.field === "request_type" && legacyProjectType) return false;
    // The legacy form has no product picker; its product context is optional.
    if (problem.field === "product_slug" && legacyProjectType) return false;
    return true;
  });
  if (problems.length) {
    return NextResponse.json({ error: problems[0].message, field: problems[0].field }, { status: 400 });
  }

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

  /**
   * Duplicate submissions.
   *
   * The wizard generates one `checkout_token` for its whole life and resends it
   * on every retry, so a double-click, an impatient second tap, and a retry
   * after a timeout that had actually succeeded all arrive carrying the same
   * value. For an account this is backed by a real constraint —
   * `orders_customer_checkout_token_idx` is unique on
   * `(customer_id, checkout_token)` — and the lookup below is what turns that
   * constraint into a helpful answer rather than a 500.
   *
   * For a guest, `customer_id` is null and distinct NULLs do not collide, so
   * this lookup is the only guard and it can lose a genuine race between two
   * simultaneous submissions. The rate limit and the disabled submit button
   * bound that; a token that identified a guest order strongly enough to
   * deduplicate it reliably would be a new credential, which is a larger
   * decision than this pass should make quietly.
   *
   * A repeat returns the original order rather than an error. The customer
   * asked for one request and has one.
   */
  const checkoutToken = clean(body.checkout_token, 40);
  if (UUID.test(checkoutToken)) {
    const lookup = routeServiceClient.from("orders").select("id").eq("checkout_token", checkoutToken);
    const { data: existing } = await (user
      ? lookup.eq("customer_id", user.id)
      : lookup.is("customer_id", null).eq("guest_email", guest?.email ?? "")
    ).maybeSingle();

    if (existing) {
      const id = (existing as { id: string }).id;
      return NextResponse.json(
        { id, href: user ? `/orders/${id}/confirmed` : `/orders/guest/${id}`, duplicate: true },
        { status: 200 }
      );
    }
  }

  // ---------------------------------------------------------------------
  // The request itself — identical for both paths
  // ---------------------------------------------------------------------
  const description = form.description;
  const quantity = form.quantity;

  /**
   * Attachments, and who may send them.
   *
   * Four things are checked, and the first is the one that matters: a caller
   * may only reference a file already uploaded under their own storage prefix,
   * so a crafted payload cannot attach somebody else's drawing to their own
   * request. The extension is checked because the form's `accept` attribute is
   * a file-picker hint, not a control. The declared size is checked because a
   * client that lied about it should not have that lie recorded next to the
   * file. A guest has no prefix, so a guest sends no files — and is told so
   * rather than having them dropped.
   */
  const rawFiles = Array.isArray(body.files)
    ? body.files
        .filter((item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
        )
        .slice(0, MAX_REQUEST_FILES)
    : [];

  const files: UploadedFile[] = [];
  if (rawFiles.length) {
    if (!user) {
      return NextResponse.json(
        { error: "Files can be attached once you have an account. Send the request and we will ask for drawings by reply." },
        { status: 400 }
      );
    }
    for (const raw of rawFiles) {
      const path = typeof raw.path === "string" ? raw.path : "";
      const name = clean(raw.name, 200);
      const size = Number(raw.size);
      if (!path.startsWith(`${user.id}/`) || !name) {
        return NextResponse.json({ error: "Invalid uploaded file." }, { status: 400 });
      }
      if (!(ACCEPTED_FILE_EXTENSIONS as readonly string[]).includes(fileExtension(name))) {
        return NextResponse.json({ error: `${name} is not a file type we accept.` }, { status: 400 });
      }
      if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES) {
        return NextResponse.json({ error: `${name} is larger than 20 MB.` }, { status: 400 });
      }
      files.push({ path, name, size, note: clean(raw.note, 200) });
    }
  }

  /**
   * Where this came from, when it came from a product page's "Request a
   * custom version" or from the wizard's existing-product branch.
   *
   * The product is resolved from the database rather than trusted: the client
   * sends a slug, and the name recorded is the published product's own. A
   * request that quotes an unpublished or invented product name is a request
   * staff would price against something that does not exist.
   */
  const productSlug = form.product_slug;
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

  // Free-form option context from the product page's form, bounded on both key
  // and value and stored as data rather than interpolated into prose anywhere.
  const rawOptions = body.selected_options;
  const selectedOptions: Record<string, string> = {};
  if (rawOptions && typeof rawOptions === "object" && !Array.isArray(rawOptions)) {
    for (const [key, value] of Object.entries(rawOptions as Record<string, unknown>).slice(0, 30)) {
      const label = clean(key, 80);
      const text = clean(value, 200);
      if (label && text) selectedOptions[label] = text;
    }
  }

  const reference = normalizeReferenceUrl(form.reference_url);
  const referenceUrl = "url" in reference ? reference.url : "";

  /**
   * Everything staff needs, in the shape `RequestSpecifications` renders.
   *
   * `{ label, value, display_value }` per entry: `value` is the machine form
   * and `display_value` is what a person reads, so a staff screen never has to
   * translate a slug and a customer never sees one. Nothing internal goes in
   * here — no cost, no staff note, no internal status — because this bag is
   * rendered to the customer on their own order page as well.
   */
  const budgetText = legacyProjectType && form.budget_mode === "none"
    ? clean(body.budget, 200)
    : describeBudget(form);

  const specifications: Record<string, unknown> = {
    project_type: { label: "Project type", value: form.request_type || legacyProjectType, display_value: typeLabel },
    description_summary: { label: "Summary", value: description.slice(0, 160), display_value: description.slice(0, 160) },
    material: { label: "Material", value: form.material, display_value: describeMaterial(form) },
    finish: { label: "Finish", value: form.finish, display_value: describeFinish(form) },
    dimensions: {
      label: "Dimensions",
      value: form.dimensions_known === "known" ? form.dimensions : "needs-help",
      display_value: describeDimensions(form) || "See files / discuss",
    },
    quantity_intent: {
      label: "Repeat work",
      value: form.repeatability,
      display_value: form.repeatability === "repeatable" ? "May be reordered" : "One-off",
    },
    timing: { label: "Timing", value: form.timing, display_value: describeTiming(form) },
    delivery: {
      label: "Delivery preference",
      value: form.delivery,
      display_value:
        form.delivery === "shipping" && form.postal_code
          ? `${deliveryLabel(form.delivery)} · ${form.postal_code}`
          : deliveryLabel(form.delivery),
    },
    budget: budgetText || null,
  };

  if (form.context) {
    specifications.context = {
      label: requestType(form.request_type)?.context?.label ?? "Context",
      value: form.context,
      display_value: form.context,
    };
  }
  if (referenceUrl) {
    specifications.reference_link = { label: "Reference link", value: referenceUrl, display_value: referenceUrl, kind: "link" };
  }
  if (files.length) {
    specifications.files = {
      label: "Files",
      value: files.map((file) => file.path),
      display_value: files.map((file) => file.name).join(", "),
      kind: "files",
      // Enough for staff to render a real list — a name and a note per path,
      // in the same order as `value`.
      items: files.map((file) => ({ path: file.path, name: file.name, size: file.size, note: file.note })),
    };
  }
  if (sourceProduct) {
    specifications.based_on = { label: "Based on", value: sourceProduct.slug, display_value: sourceProduct.name };
  }
  if (Object.keys(selectedOptions).length) {
    specifications.chosen_options = {
      label: "Chosen options",
      value: selectedOptions,
      display_value: Object.entries(selectedOptions).map(([key, value]) => `${key}: ${value}`).join(", "),
      kind: "options",
    };
  }

  /*
   * The address, when there is one.
   *
   * The wizard no longer collects a full address at inquiry stage — it asks for
   * a postal code and says the address is confirmed before anything ships. The
   * product page's form still sends a whole one, and that is still stored. So
   * this accepts either and requires neither: a null `shipping_address` on a
   * `requested` order is already the normal state of every pickup request.
   */
  const shippingAddress = normalizeShippingAddress(body.shipping_address);

  const { data: order, error } = await routeServiceClient
    .from("orders")
    .insert({
      customer_id: user?.id ?? null,
      guest_email: guest?.email ?? null,
      guest_name: guest?.name ?? null,
      guest_token_hash: guestToken ? hashGuestOrderToken(guestToken) : null,
      guest_access_expires_at: guestToken ? guestAccessExpiry() : null,
      product_id: sourceProduct?.id ?? null,
      product_name: (clean(body.title, 120) || resolvedTitle({ ...form, title: "" })).slice(0, 120),
      order_kind: "custom_request",
      status: "requested",
      quantity,
      specifications,
      customer_notes: description,
      target_date: form.timing === "by-date" && /^\d{4}-\d{2}-\d{2}$/.test(form.target_date) ? form.target_date : null,
      fulfillment_method: fulfillmentMethodFor(form.delivery),
      shipping_address: shippingAddress,
      checkout_token: UUID.test(checkoutToken) ? checkoutToken : null,
    })
    .select("id,product_name")
    .single();

  if (error || !order) {
    // A unique violation here is the account-side duplicate the lookup above
    // raced with. It is the customer pressing twice, not a failure.
    if (error?.code === "23505" && user && UUID.test(checkoutToken)) {
      const { data: raced } = await routeServiceClient
        .from("orders")
        .select("id")
        .eq("customer_id", user.id)
        .eq("checkout_token", checkoutToken)
        .maybeSingle();
      if (raced) {
        const id = (raced as { id: string }).id;
        return NextResponse.json({ id, href: `/orders/${id}/confirmed`, duplicate: true }, { status: 200 });
      }
    }
    return NextResponse.json({ error: "Could not create custom request." }, { status: 500 });
  }

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
