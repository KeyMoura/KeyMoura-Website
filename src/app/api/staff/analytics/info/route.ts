import { NextRequest, NextResponse } from "next/server";

import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { buildBusinessAnalytics, percentageChange, resolveAnalyticsWindow, type AnalyticsOrder, type AnalyticsPayment, type AnalyticsProduct, type AnalyticsRange, type AnalyticsRefund } from "@/lib/businessAnalytics";
import { fulfillmentMetrics, productionMetrics, supportMetrics, type FulfillmentFact, type ProductionFact } from "@/lib/analytics/reporting";

const allowedRanges = new Set<AnalyticsRange>(["today", "7d", "30d", "month", "last_month", "year", "custom", "90d"]);

export async function GET(req: NextRequest) {
  const actor = await requirePermission(req, "analytics.view");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const rawRange = req.nextUrl.searchParams.get("range") as AnalyticsRange | null;
  const range = rawRange && allowedRanges.has(rawRange) ? rawRange : "30d";
  let window;
  try { window = resolveAnalyticsWindow(range, new Date(), req.nextUrl.searchParams.get("from"), req.nextUrl.searchParams.get("to")); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid date range." }, { status: 400 }); }
  if (!window.start) return NextResponse.json({ error: "A bounded date range is required." }, { status: 400 });
  const queryStart = (window.previousStart ?? window.start).toISOString();
  const queryEnd = window.end.toISOString();

  const ordersQuery = routeServiceClient.from("orders")
    .select("id,order_number,customer_id,product_id,product_name,status,order_kind,quantity,subtotal_cents,discount_cents,discount_code,agreed_price_cents,amount_paid_cents,amount_refunded_cents,payment_status,target_date,accepted_at,paid_at,completed_at,created_at,updated_at,fulfillment_method,fulfillment_status,ready_to_fulfill_at,shipped_at,pickup_confirmed_at")
    .gte("created_at", queryStart).lt("created_at", queryEnd).limit(10000);
  const paymentsQuery = routeServiceClient.from("order_payments").select("order_id,amount_cents,received_at").gte("received_at", queryStart).lt("received_at", queryEnd).limit(10000);
  const refundsQuery = routeServiceClient.from("order_refunds").select("order_id,amount_cents,created_at,status").eq("status", "succeeded").gte("created_at", queryStart).lt("created_at", queryEnd).limit(10000);
  const jobsQuery = routeServiceClient.from("production_jobs").select("id,status,priority,due_date,started_at,completed_at,created_at,rework_count").gte("created_at", window.start.toISOString()).lt("created_at", queryEnd).limit(5000);
  const supportQuery = routeServiceClient.from("support_conversations").select("id,status,category,priority,created_at,resolved_at").gte("created_at", window.start.toISOString()).lt("created_at", queryEnd).limit(5000);
  const [ordersResult, productsResult, paymentsResult, refundsResult, jobsResult, supportResult, returnsResult, inventoryResult] = await Promise.all([
    ordersQuery,
    routeServiceClient.from("products").select("id,name,is_published,inventory_policy,inventory_quantity,low_stock_threshold,archived_at").limit(5000),
    paymentsQuery, refundsQuery, jobsQuery, supportQuery,
    routeServiceClient.from("order_returns").select("id,status,reason_code,created_at,order_id").gte("created_at", window.start.toISOString()).lt("created_at", queryEnd).limit(5000),
    routeServiceClient.from("inventory_adjustments").select("id,product_id,delta,reason,created_at").gte("created_at", window.start.toISOString()).lt("created_at", queryEnd).limit(5000),
  ]);
  const required = [ordersResult, productsResult, paymentsResult, refundsResult, jobsResult, supportResult, returnsResult, inventoryResult];
  const failure = required.find((result) => result.error)?.error;
  if (failure) return NextResponse.json({ error: failure.message || "Analytics could not be loaded." }, { status: 500 });

  const orders = (ordersResult.data ?? []) as unknown as (AnalyticsOrder & FulfillmentFact & Record<string, unknown>)[];
  const support = (supportResult.data ?? []) as unknown as Array<{ id: string; status: string; category: string; priority: string; created_at: string; resolved_at: string | null }>;
  // First response is intentionally unavailable here: last_staff_message_at is not a valid substitute.
  const during = (value: string) => new Date(value) >= window.start! && new Date(value) < window.end;
  const currentOrders = orders.filter((order) => during(order.created_at));
  const current = buildBusinessAnalytics(currentOrders, (productsResult.data ?? []) as AnalyticsProduct[], (paymentsResult.data ?? []).filter((item) => during(item.received_at)) as AnalyticsPayment[], (refundsResult.data ?? []).filter((item) => during(item.created_at)) as AnalyticsRefund[], "all", window.end);
  const previousDuring = (value: string) => Boolean(window.previousStart && window.previousEnd && new Date(value) >= window.previousStart && new Date(value) < window.previousEnd);
  const previous = buildBusinessAnalytics(orders.filter((order) => previousDuring(order.created_at)), [], (paymentsResult.data ?? []).filter((item) => previousDuring(item.received_at)) as AnalyticsPayment[], (refundsResult.data ?? []).filter((item) => previousDuring(item.created_at)) as AnalyticsRefund[], "all", window.previousEnd ?? window.end);
  const customOrders = orders.filter((order) => order.order_kind === "custom_request" && new Date(order.created_at) >= window.start!);
  return NextResponse.json({
    ok: true, range, generatedAt: new Date().toISOString(), window: { start: window.start, end: window.end, previousStart: window.previousStart, previousEnd: window.previousEnd },
    summary: current,
    comparison: {
      netRevenue: percentageChange(current.netCollectedCents, previous.netCollectedCents),
      orders: percentageChange(current.orderCount, previous.orderCount),
      aov: percentageChange(current.averageOrderCents, previous.averageOrderCents),
      refunds: percentageChange(current.refundedCents, previous.refundedCents),
    },
    operations: {
      production: productionMetrics((jobsResult.data ?? []) as ProductionFact[], new Date()),
      fulfillment: fulfillmentMetrics(currentOrders),
      support: supportMetrics(support.map((item) => ({ ...item, first_staff_response_at: null }))),
      refunds: { count: refundsResult.data?.filter((item) => new Date(item.created_at) >= window.start!).length ?? 0, amountCents: current.refundedCents, returns: returnsResult.data?.length ?? 0 },
      inventory: { adjustments: inventoryResult.data?.length ?? 0, unitsSold: Math.abs((inventoryResult.data ?? []).filter((item) => item.reason === "order_committed").reduce((sum, item) => sum + Math.min(0, item.delta), 0)) },
      custom: { submitted: customOrders.length, accepted: customOrders.filter((order) => Boolean(order.accepted_at)).length, paid: customOrders.filter((order) => ["paid", "refunded"].includes(order.payment_status)).length, completed: customOrders.filter((order) => order.status === "completed").length, cancelled: customOrders.filter((order) => order.status === "cancelled").length },
      discounts: { amountCents: orders.filter((order) => new Date(order.created_at) >= window.start!).reduce((sum, order) => sum + Number(order.discount_cents ?? 0), 0), orders: orders.filter((order) => new Date(order.created_at) >= window.start! && Number(order.discount_cents ?? 0) > 0).length },
    },
    limitations: ["Category is not snapshotted on order items; historical category grouping is unavailable.", "First support response requires a bounded first-staff-message aggregate and is reported as unavailable.", "Delivery is not inferred from carrier tracking text."],
  });
}
