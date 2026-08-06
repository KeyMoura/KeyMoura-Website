import { NextRequest, NextResponse } from "next/server";

import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { logLifecycleFailure } from "@/lib/commerce/orderLifecycleServer";
import {
  runReconciliation,
  type ReconAdjustment,
  type ReconAlert,
  type ReconOrder,
  type ReconPayment,
  type ReconProduct,
  type ReconRefund,
  type ReconReservation,
} from "@/lib/staff/reconciliation";

/**
 * The reconciliation report.
 *
 * **Read-only.** There is no POST, and no repair action, on purpose: pass 7's
 * refund settlement and pass 8's inventory commit are the only writers of these
 * numbers and both are idempotent and guarded. A "fix it" button here would be
 * a third writer with none of those properties, and the failure mode of getting
 * it wrong is moving money.
 *
 * Gated on `orders.view` — every check reads order-level money. Holding only
 * `inventory.view` is not enough, because the payment and refund sections are
 * the bulk of what comes back.
 *
 * The loads are bounded. This is a report a human reads; pulling an unbounded
 * order history to sum it in JavaScript is how a page that is fine with six
 * orders falls over at six thousand. The bound is stated in the response so the
 * page can say what it looked at rather than implying it looked at everything.
 */

export const runtime = "nodejs";

const ORDER_LIMIT = 1000;
const ROW_LIMIT = 2000;

const ORDER_COLUMNS =
  "id,order_number,status,payment_status,fulfillment_status,fulfillment_method,agreed_price_cents," +
  "amount_paid_cents,amount_refunded_cents,tracking_number,paid_at,inventory_committed_at,created_at";

export async function GET(req: NextRequest) {
  const actor = await requirePermission(req, "orders.view");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const [orders, payments, refunds, reservations, products, adjustments, alerts] = await Promise.all([
    routeServiceClient.from("orders").select(ORDER_COLUMNS).order("created_at", { ascending: false }).limit(ORDER_LIMIT),
    routeServiceClient.from("order_payments").select("order_id,amount_cents").limit(ROW_LIMIT),
    routeServiceClient
      .from("order_refunds")
      .select("id,order_id,status,amount_cents,confirmed_amount_cents,created_at")
      .limit(ROW_LIMIT),
    routeServiceClient
      .from("inventory_reservations")
      .select("id,product_id,order_id,status,quantity,expires_at")
      .eq("status", "active")
      .limit(ROW_LIMIT),
    routeServiceClient
      .from("products")
      .select("id,name,inventory_policy,inventory_quantity,low_stock_threshold,made_to_order,archived_at")
      .limit(ROW_LIMIT),
    routeServiceClient
      .from("inventory_adjustments")
      .select("product_id,quantity_after,created_at")
      .order("created_at", { ascending: false })
      .limit(ROW_LIMIT),
    routeServiceClient.from("inventory_alerts").select("id,product_id,level,status").limit(ROW_LIMIT),
  ]);

  const failure = [orders, payments, refunds, reservations, products, adjustments, alerts].find(
    (result) => result.error
  );
  if (failure?.error) {
    logLifecycleFailure("load_reconciliation", failure.error, {});
    return NextResponse.json({ error: "Could not build the reconciliation report." }, { status: 500 });
  }

  /*
   * The most recent adjustment per product.
   *
   * The query already comes back newest-first, so the first row seen for a
   * product is its latest. Doing this here rather than with a lateral join
   * keeps the whole report on one round trip per table.
   */
  const latestAdjustments: ReconAdjustment[] = [];
  const seen = new Set<string>();
  for (const row of (adjustments.data ?? []) as ReconAdjustment[]) {
    if (seen.has(row.product_id)) continue;
    seen.add(row.product_id);
    latestAdjustments.push(row);
  }

  const report = runReconciliation({
    orders: (orders.data ?? []) as unknown as ReconOrder[],
    payments: (payments.data ?? []) as ReconPayment[],
    refunds: (refunds.data ?? []) as ReconRefund[],
    reservations: (reservations.data ?? []) as ReconReservation[],
    products: (products.data ?? []) as ReconProduct[],
    latestAdjustments,
    alerts: (alerts.data ?? []) as ReconAlert[],
    now: new Date(),
  });

  return NextResponse.json({
    ...report,
    scope: {
      orders: orders.data?.length ?? 0,
      orderLimit: ORDER_LIMIT,
      // True when the report may not have seen everything, so the page can say
      // so instead of presenting a partial pass as a clean bill of health.
      truncated: (orders.data?.length ?? 0) >= ORDER_LIMIT,
    },
  });
}
