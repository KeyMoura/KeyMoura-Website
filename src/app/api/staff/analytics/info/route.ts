import { NextRequest, NextResponse } from "next/server";

import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { buildBusinessAnalytics, type AnalyticsOrder, type AnalyticsPayment, type AnalyticsProduct, type AnalyticsRange, type AnalyticsRefund } from "@/lib/businessAnalytics";

export async function GET(req: NextRequest) {
  const actor = await requirePermission(req, "analytics.view");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const requestedRange = req.nextUrl.searchParams.get("range");
  const range: AnalyticsRange = requestedRange === "90d" || requestedRange === "all" ? requestedRange : "30d";
  const [ordersResult, productsResult, paymentsResult, refundsResult, searchesResult] = await Promise.all([
    routeServiceClient
      .from("orders")
      .select("id,customer_id,product_id,product_name,status,quantity,agreed_price_cents,amount_paid_cents,amount_refunded_cents,payment_status,target_date,accepted_at,completed_at,created_at,updated_at")
      .returns<AnalyticsOrder[]>(),
    routeServiceClient
      .from("products")
      .select("id,name,is_published,inventory_policy,inventory_quantity,low_stock_threshold,archived_at")
      .returns<AnalyticsProduct[]>(),
    routeServiceClient.from("order_payments").select("order_id,amount_cents,received_at").returns<AnalyticsPayment[]>(),
    routeServiceClient.from("order_refunds").select("order_id,amount_cents,created_at").returns<AnalyticsRefund[]>(),
    routeServiceClient
      .from("info_search_events")
      .select("raw_query,results_count,created_at")
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  if (ordersResult.error || productsResult.error || paymentsResult.error || refundsResult.error) {
    return NextResponse.json({ error: ordersResult.error?.message ?? productsResult.error?.message ?? paymentsResult.error?.message ?? refundsResult.error?.message ?? "Analytics could not be loaded." }, { status: 500 });
  }

  const searches = searchesResult.error ? [] : searchesResult.data ?? [];
  const noResultTerms = new Map<string, number>();
  for (const search of searches) {
    const query = typeof search.raw_query === "string" ? search.raw_query.trim() : "";
    if (!query || search.results_count !== 0) continue;
    noResultTerms.set(query.toLowerCase(), (noResultTerms.get(query.toLowerCase()) ?? 0) + 1);
  }

  return NextResponse.json({
    ok: true,
    range,
    generatedAt: new Date().toISOString(),
    summary: buildBusinessAnalytics(ordersResult.data ?? [], productsResult.data ?? [], paymentsResult.data ?? [], refundsResult.data ?? [], range, new Date()),
    searchInsights: {
      searchesRecorded: searches.length,
      noResultTerms: [...noResultTerms.entries()].map(([query, count]) => ({ query, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    },
  });
}
