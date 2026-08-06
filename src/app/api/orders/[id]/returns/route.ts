import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { RETURN_REASON_CODES, evaluateReturn } from "@/lib/commerce/orderLifecycle";
import {
  loadOrderLifecycleContext,
  logLifecycleAudit,
  logLifecycleFailure,
  notifyStaffEmail,
  sendLifecycleNotification,
} from "@/lib/commerce/orderLifecycleServer";
import { raiseOperationalAlert } from "@/lib/comms/operationalAlerts";
import { RATE_LIMITS, consumeRateLimit, rateLimitMessage } from "@/lib/commerce/rateLimit";

/**
 * Customer return requests.
 *
 * Requesting a return is not being granted one, and the wording says so: the
 * response never promises a refund, and `return_approved` is a staff decision
 * that happens later. Quantities are validated inside `create_order_return`,
 * which locks the order and sums existing returns — doing that check here
 * would leave a window between the read and the insert wide enough to return
 * the same item twice from two tabs.
 */

export const runtime = "nodejs";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: "Sign in to start a return." }, { status: 401 });

  const { id } = await context.params;
  const body = (await req.json().catch(() => null)) as
    | { reason_code?: unknown; note?: unknown; items?: unknown; confirm?: unknown }
    | null;

  const reasonCode = typeof body?.reason_code === "string" ? body.reason_code : "";
  if (!RETURN_REASON_CODES.includes(reasonCode)) {
    return NextResponse.json({ error: "Choose a reason for the return." }, { status: 400 });
  }
  if (body?.confirm !== true) {
    return NextResponse.json({ error: "Confirm the return before submitting." }, { status: 400 });
  }
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 2000) : "";

  const rawItems = Array.isArray(body?.items) ? body.items : [];
  const requested = rawItems
    .map((entry) => {
      const row = entry as { order_item_id?: unknown; quantity?: unknown };
      return {
        order_item_id: typeof row.order_item_id === "string" ? row.order_item_id : "",
        quantity: Number.isInteger(row.quantity) ? Number(row.quantity) : 0,
      };
    })
    .filter((entry) => entry.order_item_id && entry.quantity > 0)
    .slice(0, 50);

  if (!requested.length) {
    return NextResponse.json({ error: "Choose at least one item to return." }, { status: 400 });
  }

  const limit = await consumeRateLimit(RATE_LIMITS.orderReturn, `user:${user.id}`);
  if (!limit.allowed) return NextResponse.json({ error: rateLimitMessage(limit) }, { status: 429 });

  const lifecycle = await loadOrderLifecycleContext(id);
  if (!lifecycle || lifecycle.order.customer_id !== user.id) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  const eligibility = evaluateReturn({
    ...lifecycle.order,
    policy: lifecycle.policy,
    hasOpenReturn: Boolean(lifecycle.openReturn),
    lines: lifecycle.lines,
  });

  if (eligibility.kind === "pending") {
    return NextResponse.json({ error: eligibility.note, alreadyOpen: true }, { status: 409 });
  }
  if (eligibility.kind === "unavailable") {
    return NextResponse.json({ error: eligibility.reason }, { status: 409 });
  }

  // Only lines the server itself judged returnable. A client asking for an item
  // that is out of window, already returned, or excluded as custom is refused
  // by name rather than silently trimmed.
  const allowed = new Map(eligibility.lines.map((line) => [line.order_item_id, line]));
  for (const entry of requested) {
    const line = allowed.get(entry.order_item_id);
    if (!line) {
      return NextResponse.json(
        { error: "One of the selected items cannot be returned. Reload the order and try again." },
        { status: 409 }
      );
    }
    if (entry.quantity > line.quantity) {
      return NextResponse.json(
        { error: `You can return at most ${line.quantity} of ${line.product_name}.` },
        { status: 409 }
      );
    }
  }

  const { data: created, error } = await routeServiceClient.rpc("create_order_return", {
    p_order_id: id,
    p_requested_by: user.id,
    p_requested_by_kind: "customer",
    p_reason_code: reasonCode,
    p_customer_note: note || null,
    p_items: requested,
  });

  if (error) {
    const message = String((error as { message?: string }).message || "");
    if (message.includes("return_already_open")) {
      return NextResponse.json({ error: "A return for this order is already open.", alreadyOpen: true }, { status: 409 });
    }
    if (message.includes("return_quantity_exceeds_purchased")) {
      return NextResponse.json({ error: "That is more than was purchased on this order." }, { status: 409 });
    }
    logLifecycleFailure("create_order_return", error, { orderId: id });
    return NextResponse.json({ error: "Could not start the return. Please try again." }, { status: 500 });
  }

  const result = created as { return_id?: string; return_number?: string; item_count?: number } | null;

  await Promise.all([
    sendLifecycleNotification({
      orderId: id,
      order: lifecycle.order,
      actorUserId: user.id,
      templateKey: "return_requested",
      eventKey: `return-request-${result?.return_id}`,
      title: "Return requested",
      message: `We received your return request${result?.return_number ? ` (${result.return_number})` : ""}. The team will review it.`,
      detail: "We will send return instructions if it is approved. Please hold on to the item until then.",
      notifyStaff: true,
      staffTitle: "Return requested",
      staffMessage: `A customer asked to return ${result?.item_count ?? 1} item(s) from ${lifecycle.order.product_name}.`,
    }),
    // Routed to `returns.review`, not `orders.manage`: the reader who can act
    // on this is the one who decides returns.
    raiseOperationalAlert({
      kind: "return.requested",
      subjectId: id,
      discriminator: result?.return_id ?? undefined,
      actorUserId: user.id,
      message: `A customer asked to return ${result?.item_count ?? 1} item(s) from ${lifecycle.order.product_name}.`,
    }),
    notifyStaffEmail({
      templateKey: "staff_return_request",
      eventKey: `return-request-staff-${result?.return_id}`,
      orderId: id,
      order: lifecycle.order,
      detail: "Nothing has been refunded and no stock has moved. Approving it sends the return instructions.",
      href: `/staff/orders/${id}`,
    }),
    logLifecycleAudit({
      eventType: "staff.order.return_requested",
      actorUserId: user.id,
      actorRole: "customer",
      orderId: id,
      metadata: {
        return_id: result?.return_id ?? null,
        reason_code: reasonCode,
        item_count: result?.item_count ?? 0,
      },
    }),
  ]);

  return NextResponse.json({
    ok: true,
    returnId: result?.return_id,
    returnNumber: result?.return_number,
  });
}
