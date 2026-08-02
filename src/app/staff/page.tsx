"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { Badge, EmptyState, MetricCard, Notice, Panel } from "@/components/ui/DesignSystem";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";
import {
  buildDashboardSummary,
  dashboardNextAction,
  type DashboardOrder,
  type DashboardProduct,
  type DashboardRange,
} from "@/lib/staffDashboard";

type Profile = { id: string; username: string | null; display_name: string | null };
type Activity = { id: number; order_id: string; sender_id: string; body: string; created_at: string };

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
const pretty = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, char => char.toUpperCase());
const shortDate = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(value));

export default function StaffDashboardPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { data: access, isLoading: accessLoading } = useMeAccess();
  const permissions = useMemo(() => new Set(access?.permissions ?? []), [access]);
  const canViewOrders = permissions.has("orders.view") || permissions.has("orders.manage");
  const canViewCatalog = permissions.has("catalog.view") || permissions.has("catalog.manage");
  const canView = canViewOrders || canViewCatalog || permissions.has("analytics.view");
  const [orders, setOrders] = useState<DashboardOrder[]>([]);
  const [products, setProducts] = useState<DashboardProduct[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [range, setRange] = useState<DashboardRange>("30d");
  const [now, setNow] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!canView) return;
    void (async () => {
      setLoading(true);
      const loadedAt = new Date();
      setNow(loadedAt);
      const [orderResult, productResult, activityResult] = await Promise.all([
        canViewOrders ? supabase.from("orders").select("id,order_number,customer_id,product_name,status,quantity,agreed_price_cents,amount_paid_cents,payment_status,paid_at,target_date,created_at,updated_at,shipped_at,delivered_at").order("updated_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
        canViewCatalog ? supabase.from("products").select("id,name,slug,is_published,inventory_policy,inventory_quantity,low_stock_threshold,archived_at").order("inventory_quantity", { ascending: true }) : Promise.resolve({ data: [], error: null }),
        canViewOrders ? supabase.from("order_messages").select("id,order_id,sender_id,body,created_at").eq("is_internal", false).order("created_at", { ascending: false }).limit(8) : Promise.resolve({ data: [], error: null }),
      ]);
      const orderRows = (orderResult.data ?? []) as DashboardOrder[];
      const activityRows = (activityResult.data ?? []) as Activity[];
      setOrders(orderRows);
      setProducts((productResult.data ?? []) as DashboardProduct[]);
      setActivities(activityRows);
      const profileIds = [...new Set([...orderRows.map(row => row.customer_id), ...activityRows.map(row => row.sender_id)])];
      if (profileIds.length) {
        const profileResult = await supabase.from("profiles").select("id,username,display_name").in("id", profileIds);
        setProfiles(Object.fromEntries(((profileResult.data ?? []) as Profile[]).map(profile => [profile.id, profile])));
        setError(orderResult.error?.message ?? productResult.error?.message ?? activityResult.error?.message ?? profileResult.error?.message ?? "");
      } else {
        setError(orderResult.error?.message ?? productResult.error?.message ?? activityResult.error?.message ?? "");
      }
      setLoading(false);
    })();
  }, [canView, canViewCatalog, canViewOrders, supabase]);

  const summary = useMemo(() => now ? buildDashboardSummary(orders, products, range, now) : null, [now, orders, products, range]);

  if (accessLoading) return <div className="ui-card p-6 text-sm text-brand-textMuted">Loading dashboard…</div>;
  if (!canView) return <AccessDeniedCard message="You do not have access to the staff dashboard." />;

  const maxTrend = Math.max(1, ...(summary?.trend.map(point => point.revenueCents) ?? [1]));
  const orderById = new Map(orders.map(order => [order.id, order]));

  return <main className="page-stack">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="text-xs uppercase tracking-[.2em] text-brand-accent">KeyMoura operations</p><h1 className="mt-1 text-3xl font-semibold">Staff dashboard</h1><p className="mt-2 text-sm text-brand-textMuted">Revenue, workshop workload, deadlines, and the next jobs that need attention.</p></div>
      <SegmentedControl value={range} onChange={setRange} ariaLabel="Dashboard date range" options={[{ value: "30d", label: "30 days" }, { value: "90d", label: "90 days" }, { value: "all", label: "All time" }]} />
    </div>

    {error ? <Notice tone="danger" role="alert">Dashboard data could not be fully loaded: {error}</Notice> : null}
    {loading || !summary ? <EmptyState>Loading business snapshot…</EmptyState> : <>
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Business summary">
        <MetricCard label="Revenue collected" value={money(summary.revenueCents)} detail={summary.revenueComparison} />
        <MetricCard label="Orders" value={String(summary.orderCount)} detail={`${summary.paidOrderCount} with payment collected`} />
        <MetricCard label="Average paid order" value={money(summary.averageOrderCents)} detail="Based on orders with collected payments" />
        <MetricCard label="Needs attention" value={String(summary.needsAttention.length)} detail={`${summary.overdue.length} overdue · ${summary.dueSoon.length} due within 7 days`} tone={summary.needsAttention.length ? "warning" : "default"} />
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.55fr_1fr]">
        <Panel>
          <div className="flex items-start justify-between gap-4"><div><h2 className="text-lg font-semibold">Revenue trend</h2><p className="mt-1 text-xs text-brand-textMuted">Payments collected by {range === "30d" ? "day" : "week"}</p></div><Link href="/staff/orders" className="text-xs font-medium text-brand-accent hover:underline">View orders</Link></div>
          <div className="mt-6 flex h-44 items-end gap-1.5" aria-label="Revenue chart">
            {summary.trend.map(point => <div key={point.key} className="group flex min-w-0 flex-1 flex-col items-center justify-end gap-2" title={`${point.label}: ${money(point.revenueCents)}`}><div className="w-full rounded-t-md bg-brand-accent/75 transition group-hover:bg-brand-accent" style={{ height: `${Math.max(point.revenueCents ? 7 : 2, point.revenueCents / maxTrend * 100)}%` }} /><span className="hidden text-[9px] text-brand-textMuted first:block last:block sm:block sm:[&:not(:nth-child(4n+1))]:hidden">{point.label}</span></div>)}
          </div>
        </Panel>

        <Panel>
          <h2 className="text-lg font-semibold">Workshop load</h2><p className="mt-1 text-xs text-brand-textMuted">Open orders by production stage</p>
          <div className="mt-5 space-y-3">{summary.stageCounts.map(stage => <div key={stage.status}><div className="flex items-center justify-between gap-3 text-sm"><span>{pretty(stage.status)}</span><span className="font-semibold">{stage.count}</span></div><div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-brand-accent" style={{ width: `${Math.max(stage.count ? 8 : 0, stage.count / Math.max(1, summary.maxStageCount) * 100)}%` }} /></div></div>)}</div>
          {!summary.stageCounts.length ? <EmptyState className="mt-5">No active production work.</EmptyState> : null}
        </Panel>
      </section>

      <section className="grid gap-5 xl:grid-cols-2">
        <Panel>
          <div className="flex items-center justify-between gap-4"><div><h2 className="text-lg font-semibold">Action queue</h2><p className="mt-1 text-xs text-brand-textMuted">Highest-priority orders first</p></div><Badge>{summary.needsAttention.length}</Badge></div>
          <div className="mt-4 divide-y divide-white/10">{summary.needsAttention.slice(0, 6).map(order => <Link key={order.id} href={`/staff/orders/${order.id}`} className="grid gap-1 py-3 transition hover:text-brand-accent sm:grid-cols-[1fr_auto] sm:items-center"><div><p className="text-sm font-medium">{order.product_name}</p><p className="mt-1 text-xs text-brand-textMuted">{order.order_number || "New request"} · {dashboardNextAction(order)}</p></div><p className={`text-xs ${summary.overdue.some(item => item.id === order.id) ? "text-rose-300" : "text-brand-textMuted"}`}>{order.target_date ? shortDate(`${order.target_date}T00:00:00`) : pretty(order.status)}</p></Link>)}</div>
          {!summary.needsAttention.length ? <EmptyState className="mt-5">Nothing needs immediate attention.</EmptyState> : null}
        </Panel>

        <Panel>
          <div className="flex items-center justify-between gap-4"><div><h2 className="text-lg font-semibold">Inventory alerts</h2><p className="mt-1 text-xs text-brand-textMuted">Tracked products at or below threshold</p></div><Link href="/staff/catalog" className="text-xs font-medium text-brand-accent hover:underline">Manage catalog</Link></div>
          <div className="mt-4 divide-y divide-white/10">{summary.inventoryAlerts.slice(0, 6).map(product => <Link key={product.id} href="/staff/catalog" className="flex items-center justify-between gap-4 py-3 transition hover:text-brand-accent"><div><p className="text-sm font-medium">{product.name}</p><p className="mt-1 text-xs text-brand-textMuted">{product.is_published ? "Published" : "Draft"}</p></div><span className={`rounded-full px-2.5 py-1 text-xs ${product.inventory_quantity === 0 ? "bg-rose-500/15 text-rose-200" : "bg-amber-400/10 text-amber-200"}`}>{product.inventory_quantity === 0 ? "Out of stock" : `${product.inventory_quantity} left`}</span></Link>)}</div>
          {!summary.inventoryAlerts.length ? <EmptyState className="mt-5">Stock levels look healthy.</EmptyState> : null}
        </Panel>
      </section>

      <Panel>
        <div className="flex items-center justify-between gap-4"><div><h2 className="text-lg font-semibold">Recent customer activity</h2><p className="mt-1 text-xs text-brand-textMuted">Latest customer-visible order messages</p></div><Link href="/staff/orders" className="text-xs font-medium text-brand-accent hover:underline">Open cockpit</Link></div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">{activities.slice(0, 6).map(activity => { const profile = profiles[activity.sender_id]; const order = orderById.get(activity.order_id); return <Link key={activity.id} href={`/staff/orders/${activity.order_id}`} className="ui-card ui-card-hover"><div className="flex items-center justify-between gap-3"><span className="text-sm font-medium">{profile?.display_name || (profile?.username ? `@${profile.username}` : "Customer")}</span><span className="text-[11px] text-brand-textMuted">{shortDate(activity.created_at)}</span></div><p className="mt-2 line-clamp-2 text-sm text-brand-textMuted">{activity.body}</p><p className="mt-2 text-[11px] text-brand-accent">{order?.order_number || order?.product_name || "Order"}</p></Link>; })}</div>
        {!activities.length ? <EmptyState className="mt-5">No recent customer messages.</EmptyState> : null}
      </Panel>
    </>}
  </main>;
}
