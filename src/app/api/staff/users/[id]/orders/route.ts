import { NextRequest, NextResponse } from "next/server";

import { requireAnyPermission, routeServiceClient } from "@/lib/api/routeAuth";
import { isUserUuid } from "@/lib/staff/userDirectory";

/**
 * A user's orders, and the production work attached to them.
 *
 * ## Account-owned only, and why the guest list is separate
 *
 * `orders.customer_id = <user>` is the only thing that makes an order this
 * user's. Guest orders are returned too, but in their own array, under their own
 * key, flagged `owned: false`, and they are counted nowhere — not in the totals
 * on this response and not in the metrics on the workspace.
 *
 * Email equality is not proof of ownership. It is a claim anybody who can type
 * an address can make, and a checkout does not verify it before the order
 * exists. Folding those rows into the owned list would mean one person's order
 * history appearing on another person's account the first time somebody typed
 * the wrong address — and, worse, would make this endpoint's output usable as
 * an authorization input elsewhere. Claiming a guest order needs a real
 * ownership proof, and this pass does not build one.
 */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
/** A guest match is a hint, not a list to page through. */
const GUEST_MATCH_LIMIT = 10;

const ORDER_COLUMNS =
  "id,order_number,status,payment_status,fulfillment_status,order_kind,product_name,quantity," +
  "agreed_price_cents,amount_paid_cents,amount_refunded_cents,created_at,paid_at,completed_at,cancelled_at";

type OrderRow = {
  id: string;
  order_number: string | null;
  status: string;
  payment_status: string;
  fulfillment_status: string;
  order_kind: string;
  product_name: string;
  quantity: number;
  agreed_price_cents: number | null;
  amount_paid_cents: number;
  amount_refunded_cents: number;
  created_at: string;
  paid_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
};

type JobRow = {
  id: string;
  job_number: string | null;
  title: string | null;
  status: string;
  priority: string | null;
  due_date: string | null;
  order_id: string | null;
};

export async function GET(req: NextRequest, ctx: Ctx) {
  const actor = await requireAnyPermission(req, ["orders.view", "orders.manage"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  if (!isUserUuid(id)) return NextResponse.json({ error: "Invalid user id" }, { status: 400 });

  const url = new URL(req.url);
  const rawPage = Number(url.searchParams.get("page"));
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const rawSize = Number(url.searchParams.get("size"));
  const pageSize =
    Number.isInteger(rawSize) && rawSize > 0 ? Math.min(rawSize, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

  const offset = (page - 1) * pageSize;

  const { data, error, count } = await routeServiceClient
    .from("orders")
    .select(ORDER_COLUMNS, { count: "exact" })
    .eq("customer_id", id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (error) {
    console.error("[staff/users/:id/orders] list failed", {
      code: (error as { code?: string }).code ?? null,
      message: (error as { message?: string }).message?.slice(0, 300) ?? null,
    });
    return NextResponse.json({ error: "Could not load this user's orders." }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as OrderRow[];
  const total = typeof count === "number" ? count : rows.length;

  // Production jobs for the orders on this page only. Fetching every job for
  // every order the user ever placed would grow with their history rather than
  // with what is on screen.
  const canSeeProduction = actor.permissions.has("production.view") || actor.permissions.has("production.manage");
  const jobsByOrder = new Map<string, JobRow[]>();

  if (canSeeProduction && rows.length) {
    const { data: jobs } = await routeServiceClient
      .from("production_jobs")
      .select("id,job_number,title,status,priority,due_date,order_id")
      .in("order_id", rows.map((r) => r.id))
      .order("created_at", { ascending: false });

    for (const job of (jobs ?? []) as JobRow[]) {
      if (!job.order_id) continue;
      const list = jobsByOrder.get(job.order_id) ?? [];
      list.push(job);
      jobsByOrder.set(job.order_id, list);
    }
  }

  // --- guest orders whose email matches -------------------------------------
  //
  // Only on the first page, only as a hint, and only when the account has an
  // email at all. `owned: false` is part of the payload rather than something
  // the UI decides, so a future caller cannot lose the distinction by forgetting
  // which array it read from.
  const guestMatches: unknown[] = [];
  let guestMatchTotal = 0;

  if (page === 1) {
    const { data: profile } = await routeServiceClient
      .from("staff_user_directory")
      .select("email")
      .eq("id", id)
      .maybeSingle<{ email: string | null }>();

    if (profile?.email) {
      const { data: guests, count: guestCount } = await routeServiceClient
        .from("orders")
        .select("id,order_number,status,payment_status,created_at,guest_email", { count: "exact" })
        .is("customer_id", null)
        .ilike("guest_email", profile.email)
        .order("created_at", { ascending: false })
        .limit(GUEST_MATCH_LIMIT);

      guestMatchTotal = typeof guestCount === "number" ? guestCount : 0;
      for (const g of (guests ?? []) as {
        id: string;
        order_number: string | null;
        status: string;
        payment_status: string;
        created_at: string;
      }[]) {
        guestMatches.push({
          id: g.id,
          orderNumber: g.order_number,
          status: g.status,
          paymentStatus: g.payment_status,
          createdAt: g.created_at,
          owned: false,
        });
      }
    }
  }

  return NextResponse.json({
    orders: rows.map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      status: row.status,
      paymentStatus: row.payment_status,
      fulfillmentStatus: row.fulfillment_status,
      orderKind: row.order_kind,
      productName: row.product_name,
      quantity: row.quantity,
      totalCents: row.agreed_price_cents,
      paidCents: row.amount_paid_cents,
      refundedCents: row.amount_refunded_cents,
      createdAt: row.created_at,
      paidAt: row.paid_at,
      completedAt: row.completed_at,
      cancelledAt: row.cancelled_at,
      owned: true,
      production: (jobsByOrder.get(row.id) ?? []).map((job) => ({
        id: job.id,
        jobNumber: job.job_number,
        title: job.title,
        status: job.status,
        priority: job.priority,
        dueDate: job.due_date,
      })),
    })),
    total,
    page,
    pageSize,
    hasMore: offset + rows.length < total,

    // Named so it cannot be mistaken for the owned list at a glance.
    possibleGuestOrders: guestMatches,
    possibleGuestOrderTotal: guestMatchTotal,
    guestOrdersAreUnclaimed: true,
  });
}
