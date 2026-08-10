import { NextRequest, NextResponse } from "next/server";

import { requireAnyPermission, routeServiceClient } from "@/lib/api/routeAuth";
import { toDeliveryView, type DeliveryRow } from "@/lib/comms/deliveryCenter";
import { isUserUuid } from "@/lib/staff/userDirectory";

/**
 * What has been emailed to this user.
 *
 * ## This is the existing delivery log, filtered — not a second one
 *
 * The rows come from `email_deliveries` and are projected by the **same**
 * `toDeliveryView` the communications centre uses. That projection already
 * decided what a staff surface may see, and re-deciding it here would mean two
 * answers to "is the provider message id safe to render". So this route adds a
 * filter and nothing else. Three things consequently stay server-side:
 *
 *  * the full recipient address — masked;
 *  * `provider_id` — a Resend handle is an internal identifier;
 *  * `error_message` — the raw provider string can quote the address it refused.
 *
 * The brief allows showing the provider id under "advanced details". The
 * existing system deliberately withholds it and that decision is left standing;
 * a per-user view is a stranger place to relax it than the main log would be.
 *
 * ## Which rows belong to this user
 *
 * Two authoritative links, and no address-matching shortcut:
 *
 *  1. deliveries against an order this account **owns** (`customer_id`);
 *  2. account-level deliveries — no order — sent to this account's own address.
 *
 * A delivery for somebody's *guest* order is not included even when the address
 * matches, for the same reason the guest orders themselves are not claimed.
 *
 * Re-sending is not done here. It already exists at
 * `/api/staff/emails/deliveries/[id]/resend`, which writes `email.manual_resend`
 * to the audit log; this route returns the delivery ids so the UI can call it.
 */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
/** Bounds the id list handed to `in()`, so a heavy account cannot build a huge query. */
const MAX_ORDER_IDS = 500;

const DELIVERY_COLUMNS =
  "id,order_id,template_key,recipient,subject,status,failure_category,audience," +
  "attempt_count,delivered_at,resend_of_id,created_at,updated_at";

export async function GET(req: NextRequest, ctx: Ctx) {
  const actor = await requireAnyPermission(req, ["emails.view", "emails.resend"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  if (!isUserUuid(id)) return NextResponse.json({ error: "Invalid user id" }, { status: 400 });

  const url = new URL(req.url);
  const rawPage = Number(url.searchParams.get("page"));
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const rawSize = Number(url.searchParams.get("size"));
  const pageSize =
    Number.isInteger(rawSize) && rawSize > 0 ? Math.min(rawSize, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

  const [ownedOrdersRes, directoryRes] = await Promise.all([
    routeServiceClient.from("orders").select("id,order_number").eq("customer_id", id).limit(MAX_ORDER_IDS),
    routeServiceClient.from("staff_user_directory").select("email").eq("id", id).maybeSingle<{ email: string | null }>(),
  ]);

  const ownedOrders = (ownedOrdersRes.data ?? []) as { id: string; order_number: string | null }[];
  const orderIds = ownedOrders.map((o) => o.id);
  const email = directoryRes.data?.email ?? null;

  // Nothing to match on at all — no orders and no address — is an empty history,
  // not an unfiltered one. Without this guard the `or()` below would degenerate
  // and return every delivery in the system.
  if (!orderIds.length && !email) {
    return NextResponse.json({
      deliveries: [],
      total: 0,
      page,
      pageSize,
      hasMore: false,
      canResend: actor.permissions.has("emails.resend"),
    });
  }

  let query = routeServiceClient
    .from("email_deliveries")
    .select(DELIVERY_COLUMNS, { count: "exact" })
    .order("created_at", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);

  const clauses: string[] = [];
  if (orderIds.length) clauses.push(`order_id.in.(${orderIds.join(",")})`);
  if (email) {
    // Account-level mail only: `order_id` must be null, so a guest order's
    // confirmation to the same address cannot arrive through this clause.
    const safeEmail = email.replace(/[(),*\\"]/g, "");
    if (safeEmail) clauses.push(`and(order_id.is.null,recipient.ilike.${safeEmail})`);
  }

  query = clauses.length === 1 ? query.or(clauses[0]) : query.or(clauses.join(","));

  const { data, error, count } = await query;

  if (error) {
    console.error("[staff/users/:id/communications] list failed", {
      code: (error as { code?: string }).code ?? null,
      message: (error as { message?: string }).message?.slice(0, 300) ?? null,
    });
    return NextResponse.json({ error: "Could not load this user's email history." }, { status: 502 });
  }

  const rows = (data ?? []) as unknown as DeliveryRow[];
  const total = typeof count === "number" ? count : rows.length;

  const orderNumbers = Object.fromEntries(
    ownedOrders.filter((o) => o.order_number).map((o) => [o.id, String(o.order_number)])
  );
  const { data: templates } = await routeServiceClient.from("email_templates").select("key,name");
  const templateNames = Object.fromEntries((templates ?? []).map((t) => [String(t.key), String(t.name)]));

  return NextResponse.json({
    deliveries: rows.map((row) => toDeliveryView(row, { orderNumbers, templateNames })),
    total,
    page,
    pageSize,
    hasMore: (page - 1) * pageSize + rows.length < total,
    canResend: actor.permissions.has("emails.resend"),
  });
}
