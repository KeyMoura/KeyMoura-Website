export type ProductionFact = { id: string; status: string; priority: string; due_date: string | null; started_at: string | null; completed_at: string | null; created_at: string; rework_count: number };
export type FulfillmentFact = { id: string; fulfillment_method: string | null; fulfillment_status: string | null; paid_at: string | null; ready_to_fulfill_at: string | null; shipped_at: string | null; pickup_confirmed_at: string | null };
export type SupportFact = { id: string; status: string; category: string; priority: string; created_at: string; first_staff_response_at: string | null; resolved_at: string | null };

const hours = (from: string, to: string) => (new Date(to).getTime() - new Date(from).getTime()) / 3_600_000;
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function productionMetrics(jobs: ProductionFact[], now: Date) {
  const terminal = new Set(["completed", "cancelled"]);
  const durations = jobs.filter((job) => job.started_at && job.completed_at).map((job) => hours(job.started_at!, job.completed_at!)).filter((value) => value >= 0);
  const active = jobs.filter((job) => !terminal.has(job.status));
  return {
    created: jobs.length, completed: jobs.filter((job) => job.status === "completed").length, active: active.length,
    blocked: active.filter((job) => ["on_hold", "waiting_on_customer", "waiting_on_materials", "rework_required"].includes(job.status)).length,
    overdue: active.filter((job) => job.due_date && new Date(`${job.due_date}T00:00:00Z`) < now).length,
    averageHours: average(durations), medianHours: median(durations), reworked: jobs.filter((job) => job.rework_count > 0).length,
  };
}

export function fulfillmentMetrics(orders: FulfillmentFact[]) {
  const completed = orders.filter((order) => order.fulfillment_status === "shipped" || order.fulfillment_status === "delivered" || order.fulfillment_status === "picked_up");
  const leadTimes = completed.flatMap((order) => order.paid_at && (order.shipped_at || order.pickup_confirmed_at) ? [hours(order.paid_at, order.shipped_at ?? order.pickup_confirmed_at!)] : []);
  return {
    shipped: orders.filter((order) => order.fulfillment_status === "shipped" || order.fulfillment_status === "delivered").length,
    pickup: orders.filter((order) => order.fulfillment_method === "pickup").length,
    completedPickups: orders.filter((order) => order.fulfillment_status === "picked_up").length,
    averagePaidToFulfilledHours: average(leadTimes),
    readyPickupWaitHours: average(orders.flatMap((order) => order.ready_to_fulfill_at && order.pickup_confirmed_at ? [hours(order.ready_to_fulfill_at, order.pickup_confirmed_at)] : [])),
  };
}

export function supportMetrics(conversations: SupportFact[]) {
  return {
    opened: conversations.length,
    resolved: conversations.filter((item) => item.status === "resolved" || item.status === "closed").length,
    open: conversations.filter((item) => !["resolved", "closed"].includes(item.status)).length,
    waitingOnStaff: conversations.filter((item) => item.status === "waiting_on_staff").length,
    waitingOnCustomer: conversations.filter((item) => item.status === "waiting_on_customer").length,
    averageFirstResponseHours: average(conversations.flatMap((item) => item.first_staff_response_at ? [hours(item.created_at, item.first_staff_response_at)] : [])),
    averageResolutionHours: average(conversations.flatMap((item) => item.resolved_at ? [hours(item.created_at, item.resolved_at)] : [])),
  };
}
