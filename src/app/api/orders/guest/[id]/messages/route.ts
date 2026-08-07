import { NextRequest, NextResponse } from "next/server";
import { routeServiceClient } from "@/lib/api/routeAuth";
import { getCommerceEmailConfig, sendCommerceEmail } from "@/lib/commerceEmail";
import { notifyOrderStaff } from "@/lib/orderNotifications";
import { raiseOperationalAlert } from "@/lib/comms/operationalAlerts";
import { authorizeGuestOrderWrite, guestOrderTokenFromRequest } from "@/lib/commerce/guestOrderAccess";
import { consumeRateLimit, rateLimitMessage, RATE_LIMITS } from "@/lib/commerce/rateLimit";

/**
 * A guest replying about their own order or request.
 *
 * A separate route from `/api/orders/[id]/messages` on purpose. That one
 * decides between a customer and a staff member and can mark a message
 * internal; this one has exactly one caller with exactly one capability, so
 * there is no branch here that could ever be reached with `internal: true`.
 * Two small routes with one rule each beat one route with a matrix.
 *
 * `is_internal` is hard-coded `false` and `sender_id` is hard-coded `null`.
 * Neither is read from the body, so no payload can make a guest's message
 * invisible to them or attribute it to an account.
 */

export const runtime = "nodejs";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const token = guestOrderTokenFromRequest(req);

  const access = await authorizeGuestOrderWrite(token, id);
  if (!access.ok) {
    // One answer for every denial. Distinguishing "no cookie" from "wrong
    // order" would tell a caller which order ids are real.
    return NextResponse.json({ error: "That order is not available on this device." }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { body?: unknown; client_token?: unknown } | null;
  const message = typeof body?.body === "string" ? body.body.trim() : "";
  if (!message || message.length > 4000) {
    return NextResponse.json({ error: "Message must be 1–4000 characters." }, { status: 400 });
  }

  const verdict = await consumeRateLimit(RATE_LIMITS.guestMessage, `${id}|${token}`);
  if (!verdict.allowed) return NextResponse.json({ error: rateLimitMessage(verdict) }, { status: 429 });

  // Same idempotency contract as the account route: one composed message is
  // one row and one notification, however many times the request arrives.
  const clientToken =
    typeof body?.client_token === "string" ? body.client_token.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) : "";

  const { data: order } = await routeServiceClient
    .from("orders")
    .select("id,order_number,product_name")
    .eq("id", id)
    .maybeSingle();
  if (!order) return NextResponse.json({ error: "That order is not available on this device." }, { status: 403 });

  const { data: inserted, error } = await routeServiceClient
    .from("order_messages")
    .insert({
      order_id: id,
      sender_id: null,
      body: message,
      is_internal: false,
      client_token: clientToken || null,
    })
    .select("id")
    .single();

  if (error) {
    if (clientToken && (error as { code?: string }).code === "23505") {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    return NextResponse.json({ error: "Could not send message" }, { status: 500 });
  }

  const config = await getCommerceEmailConfig();

  await Promise.all([
    // Staff hear about it. The customer does not get an email about their own
    // message — they just wrote it.
    config.sendCustomerMessages && config.staffNotificationEmail
      ? sendCommerceEmail({
          to: config.staffNotificationEmail,
          orderId: id,
          templateKey: "staff_message",
          eventKey: `guest-order-message-${inserted.id}`,
          href: `/staff/orders/${id}`,
          variables: {
            customer_name: "",
            product_name: order.product_name,
            order_label: order.order_number || "a KeyMoura request",
            status: "",
            price: "",
          },
        })
      : Promise.resolve(),
    notifyOrderStaff({
      orderId: id,
      actorUserId: null,
      title: "New customer message",
      // The body is deliberately absent. A customer's words belong on the
      // order page, not in a preview line that appears in a bell and a badge.
      message: `A guest replied about ${order.product_name}.`,
    }),
    raiseOperationalAlert({
      kind: "order.customer_information_received",
      subjectId: id,
      discriminator: String(inserted.id),
      actorUserId: null,
      message: `A guest replied about ${order.product_name}.`,
    }),
  ]);

  return NextResponse.json({ ok: true });
}
