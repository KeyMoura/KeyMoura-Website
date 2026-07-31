export type DashboardRange = "30d" | "90d" | "all";

export type DashboardOrder = {
  id: string;
  order_number: string | null;
  customer_id: string;
  product_name: string;
  status: string;
  quantity: number;
  agreed_price_cents: number | null;
  amount_paid_cents: number;
  payment_status: string;
  paid_at: string | null;
  target_date: string | null;
  created_at: string;
  updated_at: string;
  shipped_at: string | null;
  delivered_at: string | null;
};

export type DashboardProduct = {
  id: string;
  name: string;
  slug: string;
  is_published: boolean;
  inventory_policy: string;
  inventory_quantity: number;
  low_stock_threshold: number;
  archived_at: string | null;
};

const closed = new Set(["completed", "declined", "cancelled"]);
const urgent = new Set(["requested", "needs_information", "customer_review", "ready"]);

export function dashboardNextAction(order: DashboardOrder) {
  if (order.status === "requested") return "Review request";
  if (order.status === "needs_information") return "Follow up for details";
  if (order.status === "accepted" && order.agreed_price_cents == null) return "Prepare quote";
  if (order.status === "awaiting_payment") return "Payment pending";
  if (order.status === "in_progress") return "Continue production";
  if (order.status === "customer_review") return "Review customer reply";
  if (order.status === "ready" && !order.shipped_at) return "Arrange delivery";
  if (order.shipped_at && !order.delivered_at) return "Confirm delivery";
  return "View order";
}

function startForRange(range: DashboardRange, now: Date) {
  if (range === "all") return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (range === "30d" ? 29 : 89));
  return start;
}

function revenueInWindow(orders: DashboardOrder[], start: Date | null, end: Date) {
  return paymentsInWindow(orders, start, end).reduce((sum, order) => sum + Math.max(0, order.amount_paid_cents || 0), 0);
}

function paymentsInWindow(orders: DashboardOrder[], start: Date | null, end: Date) {
  return orders.filter(order => {
    const collected = new Date(order.paid_at || order.created_at);
    return order.amount_paid_cents > 0 && (!start || collected >= start) && collected < end;
  });
}

export function buildDashboardSummary(orders: DashboardOrder[], products: DashboardProduct[], range: DashboardRange, now: Date) {
  const start = startForRange(range, now);
  const currentOrders = orders.filter(order => !start || new Date(order.created_at) >= start);
  const revenueCents = revenueInWindow(orders, start, now);
  const paidOrders = paymentsInWindow(orders, start, now);
  let revenueComparison = "All recorded payments";
  if (start) {
    const duration = now.getTime() - start.getTime();
    const previousStart = new Date(start.getTime() - duration);
    const previousRevenue = revenueInWindow(orders, previousStart, start);
    if (previousRevenue === 0) revenueComparison = revenueCents ? "No revenue in the previous period" : "No revenue in either period";
    else {
      const percent = Math.round((revenueCents - previousRevenue) / previousRevenue * 100);
      revenueComparison = `${percent >= 0 ? "+" : ""}${percent}% vs previous period`;
    }
  }

  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const nextWeek = new Date(today); nextWeek.setDate(nextWeek.getDate() + 7);
  const active = orders.filter(order => !closed.has(order.status));
  const overdue = active.filter(order => order.target_date && new Date(`${order.target_date}T00:00:00`) < today);
  const dueSoon = active.filter(order => order.target_date && new Date(`${order.target_date}T00:00:00`) >= today && new Date(`${order.target_date}T00:00:00`) <= nextWeek);
  const needsAttention = active.filter(order => urgent.has(order.status) || order.payment_status === "unpaid" || order.payment_status === "partial" || overdue.some(item => item.id === order.id))
    .sort((a, b) => Number(overdue.some(item => item.id === b.id)) - Number(overdue.some(item => item.id === a.id)) || a.updated_at.localeCompare(b.updated_at));

  const stageMap = new Map<string, number>();
  for (const order of active) stageMap.set(order.status, (stageMap.get(order.status) ?? 0) + 1);
  const stageCounts = [...stageMap].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count);

  const inventoryAlerts = products.filter(product => !product.archived_at && product.inventory_policy === "track" && product.inventory_quantity <= product.low_stock_threshold)
    .sort((a, b) => a.inventory_quantity - b.inventory_quantity || a.name.localeCompare(b.name));

  const bucketCount = range === "30d" ? 30 : range === "90d" ? 13 : 12;
  const bucketDays = range === "30d" ? 1 : range === "90d" ? 7 : 30;
  const trendEnd = new Date(now); trendEnd.setHours(23, 59, 59, 999);
  const trend = Array.from({ length: bucketCount }, (_, index) => {
    const bucketStart = new Date(trendEnd);
    bucketStart.setDate(bucketStart.getDate() - (bucketCount - index) * bucketDays + 1);
    bucketStart.setHours(0, 0, 0, 0);
    const bucketEnd = new Date(bucketStart); bucketEnd.setDate(bucketEnd.getDate() + bucketDays);
    return {
      key: bucketStart.toISOString(),
      label: bucketStart.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      revenueCents: revenueInWindow(orders, bucketStart, bucketEnd),
    };
  });

  return {
    revenueCents,
    revenueComparison,
    orderCount: currentOrders.length,
    paidOrderCount: paidOrders.length,
    averageOrderCents: paidOrders.length ? Math.round(revenueCents / paidOrders.length) : 0,
    needsAttention,
    overdue,
    dueSoon,
    stageCounts,
    maxStageCount: Math.max(0, ...stageCounts.map(stage => stage.count)),
    inventoryAlerts,
    trend,
  };
}
