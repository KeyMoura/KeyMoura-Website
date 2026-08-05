import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission, routeServiceClient } from "@/lib/api/routeAuth";
import { loadOrderLifecycleContext, logLifecycleFailure } from "@/lib/commerce/orderLifecycleServer";

/**
 * The staff view of one order's lifecycle: cancellations, returns, refunds,
 * and the inventory movements the order caused.
 *
 * Read-only. Every write goes through its own named endpoint with its own
 * permission, so having this open in a tab authorizes nothing.
 */

export const runtime = "nodejs";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAnyPermission(req, ["orders.view", "orders.manage"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await context.params;
  const lifecycle = await loadOrderLifecycleContext(id);
  if (!lifecycle) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const [requests, returns, refunds, adjustments] = await Promise.all([
    routeServiceClient
      .from("order_cancellation_requests")
      .select("*")
      .eq("order_id", id)
      .order("created_at", { ascending: false }),
    routeServiceClient
      .from("order_returns")
      .select("*, order_return_items(*)")
      .eq("order_id", id)
      .order("created_at", { ascending: false }),
    routeServiceClient
      .from("order_refunds")
      .select("*")
      .eq("order_id", id)
      .order("created_at", { ascending: false }),
    // Inventory is a separate permission: a staff member who can read orders
    // is not thereby entitled to the shop's stock history.
    actor.permissions.has("inventory.view") || actor.permissions.has("inventory.manage")
      ? routeServiceClient
          .from("inventory_adjustments")
          .select("id,product_id,delta,quantity_before,quantity_after,reason,created_at,note")
          .eq("order_id", id)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: null, error: null }),
  ]);

  for (const [name, result] of [
    ["cancellation_requests", requests],
    ["returns", returns],
    ["refunds", refunds],
  ] as const) {
    if (result.error) {
      logLifecycleFailure(`load_staff_${name}`, result.error, { orderId: id });
      return NextResponse.json({ error: "Could not load the order lifecycle." }, { status: 500 });
    }
  }

  return NextResponse.json({
    order: {
      id: lifecycle.order.id,
      status: lifecycle.order.status,
      payment_status: lifecycle.order.payment_status,
      fulfillment_status: lifecycle.order.fulfillment_status,
      cancellation_status: lifecycle.order.cancellation_status,
      return_status: lifecycle.order.return_status,
      fulfillment_method: lifecycle.order.fulfillment_method,
      amount_paid_cents: lifecycle.order.amount_paid_cents,
      amount_refunded_cents: lifecycle.order.amount_refunded_cents,
      inventory_committed_at: lifecycle.order.inventory_committed_at,
    },
    refundableCents: lifecycle.refundableCents,
    pendingRefundCents: lifecycle.pendingRefundCents,
    productionStatus: lifecycle.productionStatus,
    lines: lifecycle.lines,
    cancellationRequests: requests.data ?? [],
    returns: returns.data ?? [],
    refunds: refunds.data ?? [],
    inventoryAdjustments: adjustments.data ?? null,
    permissions: {
      canReviewCancellations: actor.permissions.has("cancellations.review"),
      canReviewReturns: actor.permissions.has("returns.review"),
      canIssueRefunds: actor.permissions.has("refunds.issue"),
      canViewInventory: actor.permissions.has("inventory.view") || actor.permissions.has("inventory.manage"),
    },
  });
}
