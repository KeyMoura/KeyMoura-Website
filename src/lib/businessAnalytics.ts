export type AnalyticsRange = "30d" | "90d" | "all";

export type AnalyticsOrder = {
  id: string;
  customer_id: string;
  product_id: string | null;
  product_name: string;
  status: string;
  quantity: number;
  agreed_price_cents: number | null;
  amount_paid_cents: number;
  amount_refunded_cents: number;
  payment_status: string;
  target_date: string | null;
  accepted_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AnalyticsProduct = {
  id: string;
  name: string;
  is_published: boolean;
  inventory_policy: string;
  inventory_quantity: number;
  low_stock_threshold: number;
  archived_at: string | null;
};

export type AnalyticsPayment = { order_id: string; amount_cents: number; received_at: string };
export type AnalyticsRefund = { order_id: string; amount_cents: number; created_at: string };

const terminalStatuses = new Set(["completed", "declined", "cancelled"]);

function rangeStart(range: AnalyticsRange, now: Date) {
  if (range === "all") return null;
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (range === "30d" ? 29 : 89));
  return start;
}

const inWindow = (date: string | null, start: Date | null, end: Date) => {
  if (!date) return false;
  const value = new Date(date);
  return (!start || value >= start) && value <= end;
};

export function buildBusinessAnalytics(
  orders: AnalyticsOrder[],
  products: AnalyticsProduct[],
  payments: AnalyticsPayment[],
  refunds: AnalyticsRefund[],
  range: AnalyticsRange,
  now: Date,
) {
  const start = rangeStart(range, now);
  const periodOrders = orders.filter((order) => inWindow(order.created_at, start, now));
  const periodPayments = payments.filter((payment) => inWindow(payment.received_at, start, now));
  const periodRefunds = refunds.filter((refund) => inWindow(refund.created_at, start, now));
  const paidOrderIds = new Set(periodPayments.map((payment) => payment.order_id));
  const grossCollectedCents = periodPayments.reduce((sum, payment) => sum + payment.amount_cents, 0);
  const refundedCents = periodRefunds.reduce((sum, refund) => sum + refund.amount_cents, 0);
  const netCollectedCents = Math.max(0, grossCollectedCents - refundedCents);
  const activeOrders = orders.filter((order) => !terminalStatuses.has(order.status));
  const outstandingCents = activeOrders.reduce((sum, order) => {
    if (order.agreed_price_cents == null) return sum;
    return sum + Math.max(0, order.agreed_price_cents - order.amount_paid_cents);
  }, 0);

  const completed = periodOrders.filter((order) => order.status === "completed");
  const decided = periodOrders.filter((order) => terminalStatuses.has(order.status));
  const completionRate = decided.length ? completed.length / decided.length : 0;
  const accepted = periodOrders.filter((order) => Boolean(order.accepted_at));
  const acceptanceRate = periodOrders.length ? accepted.length / periodOrders.length : 0;
  const turnaroundDays = completed
    .filter((order) => order.completed_at)
    .map((order) => (new Date(order.completed_at!).getTime() - new Date(order.accepted_at ?? order.created_at).getTime()) / 86_400_000)
    .filter((days) => days >= 0);

  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const staleBoundary = new Date(now);
  staleBoundary.setUTCDate(staleBoundary.getUTCDate() - 14);
  const overdueOrders = activeOrders.filter((order) => order.target_date && new Date(`${order.target_date}T00:00:00Z`) < today);
  const agingOrders = activeOrders.filter((order) => new Date(order.updated_at) < staleBoundary);

  const customers = new Map<string, number>();
  for (const order of periodOrders) customers.set(order.customer_id, (customers.get(order.customer_id) ?? 0) + 1);
  const repeatCustomers = [...customers.values()].filter((count) => count > 1).length;

  const statusCounts = new Map<string, number>();
  for (const order of periodOrders) statusCounts.set(order.status, (statusCounts.get(order.status) ?? 0) + 1);
  const pipeline = [...statusCounts.entries()].map(([status, count]) => ({ status, count }));

  const productMap = new Map<string, { name: string; orders: number; units: number; revenueCents: number }>();
  for (const order of periodOrders) {
    const key = order.product_id ?? order.product_name.toLowerCase();
    const current = productMap.get(key) ?? { name: order.product_name, orders: 0, units: 0, revenueCents: 0 };
    current.orders += 1;
    current.units += order.quantity;
    current.revenueCents += Math.max(0, order.amount_paid_cents - order.amount_refunded_cents);
    productMap.set(key, current);
  }
  const topProducts = [...productMap.values()].sort((a, b) => b.orders - a.orders || b.revenueCents - a.revenueCents).slice(0, 8);

  const inventoryAlerts = products
    .filter((product) => !product.archived_at && product.inventory_policy === "track" && product.inventory_quantity <= product.low_stock_threshold)
    .sort((a, b) => a.inventory_quantity - b.inventory_quantity || a.name.localeCompare(b.name));

  const bucketCount = range === "30d" ? 30 : range === "90d" ? 13 : 12;
  const bucketDays = range === "30d" ? 1 : range === "90d" ? 7 : 30;
  const trend = Array.from({ length: bucketCount }, (_, index) => {
    const bucketStart = new Date(now);
    bucketStart.setUTCHours(0, 0, 0, 0);
    bucketStart.setUTCDate(bucketStart.getUTCDate() - (bucketCount - index) * bucketDays + 1);
    const bucketEnd = new Date(bucketStart);
    bucketEnd.setUTCDate(bucketEnd.getUTCDate() + bucketDays);
    const bucketOrders = orders.filter((order) => inWindow(order.created_at, bucketStart, bucketEnd));
    return {
      key: bucketStart.toISOString(),
      label: bucketStart.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
      orders: bucketOrders.length,
      netCents: Math.max(0,
        payments.filter((payment) => inWindow(payment.received_at, bucketStart, bucketEnd)).reduce((sum, payment) => sum + payment.amount_cents, 0)
        - refunds.filter((refund) => inWindow(refund.created_at, bucketStart, bucketEnd)).reduce((sum, refund) => sum + refund.amount_cents, 0),
      ),
    };
  });

  return {
    grossCollectedCents,
    refundedCents,
    netCollectedCents,
    outstandingCents,
    orderCount: periodOrders.length,
    activeOrderCount: activeOrders.length,
    completedCount: completed.length,
    completionRate,
    acceptanceRate,
    averageOrderCents: paidOrderIds.size ? Math.round(netCollectedCents / paidOrderIds.size) : 0,
    averageTurnaroundDays: turnaroundDays.length ? turnaroundDays.reduce((sum, days) => sum + days, 0) / turnaroundDays.length : null,
    uniqueCustomers: customers.size,
    repeatCustomers,
    overdueCount: overdueOrders.length,
    agingCount: agingOrders.length,
    pipeline,
    topProducts,
    inventoryAlerts,
    trend,
  };
}
