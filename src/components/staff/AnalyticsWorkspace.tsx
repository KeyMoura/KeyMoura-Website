"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- API report rows are intentionally heterogeneous across report tabs. */

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { EmptyState, MetricCard, Notice, Panel } from "@/components/ui/DesignSystem";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";

const reports = ["overview", "revenue", "orders", "products", "customers", "production", "fulfillment", "support", "refunds", "inventory"] as const;
type Report = typeof reports[number];
type Response = { generatedAt: string; summary: Record<string, any>; comparison: Record<string, number | null>; operations: Record<string, any>; limitations: string[] };
const money = (value: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value / 100);
const duration = (hours: number | null) => hours == null ? "Unavailable" : hours < 48 ? `${hours.toFixed(1)} hours` : `${(hours / 24).toFixed(1)} days`;
const cards: Record<Report, Array<[string, string, "money" | "number" | "duration"]>> = {
  overview: [["Net revenue", "summary.netCollectedCents", "money"], ["Orders placed", "summary.orderCount", "number"], ["Average order value", "summary.averageOrderCents", "money"], ["Refunds", "summary.refundedCents", "money"]],
  revenue: [["Gross collected", "summary.grossCollectedCents", "money"], ["Discounts", "operations.discounts.amountCents", "money"], ["Refunds", "summary.refundedCents", "money"], ["Net revenue", "summary.netCollectedCents", "money"], ["Paid-order AOV", "summary.averageOrderCents", "money"]],
  orders: [["Placed", "summary.orderCount", "number"], ["Completed", "summary.completedCount", "number"], ["Open", "summary.activeOrderCount", "number"], ["Overdue", "summary.overdueCount", "number"]],
  products: [["Products with sales", "summary.topProducts.length", "number"], ["Units sold", "operations.inventory.unitsSold", "number"], ["Low stock", "summary.inventoryAlerts.length", "number"]],
  customers: [["Account customers", "summary.uniqueCustomers", "number"], ["Repeat customers", "summary.repeatCustomers", "number"]],
  production: [["Jobs created", "operations.production.created", "number"], ["Completed", "operations.production.completed", "number"], ["Active", "operations.production.active", "number"], ["Blocked", "operations.production.blocked", "number"], ["Overdue", "operations.production.overdue", "number"], ["Average duration", "operations.production.averageHours", "duration"]],
  fulfillment: [["Shipped", "operations.fulfillment.shipped", "number"], ["Pickup orders", "operations.fulfillment.pickup", "number"], ["Completed pickups", "operations.fulfillment.completedPickups", "number"], ["Paid to fulfilled", "operations.fulfillment.averagePaidToFulfilledHours", "duration"]],
  support: [["Opened", "operations.support.opened", "number"], ["Resolved", "operations.support.resolved", "number"], ["Open", "operations.support.open", "number"], ["Waiting on staff", "operations.support.waitingOnStaff", "number"], ["Waiting on customer", "operations.support.waitingOnCustomer", "number"], ["First response", "operations.support.averageFirstResponseHours", "duration"]],
  refunds: [["Refund count", "operations.refunds.count", "number"], ["Refund amount", "operations.refunds.amountCents", "money"], ["Returns", "operations.refunds.returns", "number"]],
  inventory: [["Low stock", "summary.inventoryAlerts.length", "number"], ["Adjustments", "operations.inventory.adjustments", "number"], ["Units sold", "operations.inventory.unitsSold", "number"]],
};
const get = (value: any, path: string) => path.split(".").reduce((current, part) => part === "length" ? current?.length : current?.[part], value);

export function AnalyticsWorkspace({ report = "overview" }: { report?: Report }) {
  const { data: access, isLoading: accessLoading } = useMeAccess();
  const canView = Boolean(access?.permissions?.includes("analytics.view"));
  const params = useSearchParams(), router = useRouter(), pathname = usePathname();
  const range = params.get("range") ?? "30d";
  const [data, setData] = useState<Response | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!canView) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => { if (!controller.signal.aborted) { setLoading(true); setError(""); } });
    void supabaseBrowser().auth.getSession().then(async ({ data: session }) => {
      if (!session.session) throw new Error("You must be signed in.");
      const query = new URLSearchParams(params.toString());
      const response = await fetch(`/api/staff/analytics/info?${query}`, { headers: { Authorization: `Bearer ${session.session.access_token}` }, signal: controller.signal });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Analytics could not be loaded."); setData(body);
    }).catch((caught) => { if (caught.name !== "AbortError") { setData(null); setError(caught.message); } }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [canView, params]);
  if (accessLoading) return <EmptyState>Checking analytics access…</EmptyState>;
  if (!canView) return <AccessDeniedCard />;
  const setRange = (next: string) => { const query = new URLSearchParams(params.toString()); query.set("range", next); query.delete("from"); query.delete("to"); router.push(`${pathname}?${query}`); };
  return <main className="page-stack mx-auto w-full max-w-7xl">
    <header className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs uppercase tracking-[.2em] text-brand-accent">Operations · Analytics</p><h1 className="mt-1 text-3xl font-semibold capitalize">{report === "overview" ? "Business analytics" : `${report} report`}</h1><p className="mt-2 text-sm text-brand-textMuted">Authoritative, UTC-bounded operational reporting. Dates are displayed in your locale.</p></div><label className="text-sm">Date range <select className="ui-input ml-2" value={range} onChange={(event) => setRange(event.target.value)}>{[["today","Today"],["7d","Last 7 days"],["30d","Last 30 days"],["month","This month"],["last_month","Last month"],["year","This year"]].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label></header>
    <nav aria-label="Analytics reports" className="flex gap-2 overflow-x-auto border-b border-[var(--border)] pb-3">{reports.map((item) => <Link key={item} aria-current={item === report ? "page" : undefined} className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm ${item === report ? "bg-brand-accent text-black" : "ui-card"}`} href={`/staff/analytics${item === "overview" ? "" : `/${item}`}?range=${range}`}>{item[0].toUpperCase()+item.slice(1)}</Link>)}</nav>
    {error ? <Notice tone="danger" role="alert">Analytics unavailable: {error}. No values have been replaced with zero.</Notice> : null}
    {loading && !data ? <EmptyState>Loading report…</EmptyState> : null}
    {data ? <><section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label={`${report} key metrics`}>{cards[report].map(([label,path,format]) => { const value = get(data, path); const key = path === "summary.netCollectedCents" ? "netRevenue" : path === "summary.orderCount" ? "orders" : path === "summary.averageOrderCents" ? "aov" : path === "summary.refundedCents" ? "refunds" : ""; const change = key ? data.comparison[key] : null; return <MetricCard key={path} label={label} value={value == null ? "Unavailable" : format === "money" ? money(value) : format === "duration" ? duration(value) : String(value)} detail={change == null ? "Selected UTC period" : `${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}% vs previous period`} />; })}</section><ReportDetail report={report} data={data} /><Panel><h2 className="font-semibold">Data-quality notes</h2><ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-brand-textMuted">{data.limitations.map((item) => <li key={item}>{item}</li>)}</ul></Panel><p className="text-right text-xs text-brand-textMuted">Updated {new Date(data.generatedAt).toLocaleString()}</p></> : null}
  </main>;
}

function ReportDetail({ report, data }: { report: Report; data: Response }) {
  if (report === "products" || report === "revenue") return <Panel><h2 className="text-lg font-semibold">Product performance</h2><p className="mt-1 text-xs text-brand-textMuted">Order snapshot names are preserved. Net is paid less refunded at order level.</p><div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th scope="col">Product snapshot</th><th scope="col">Orders</th><th scope="col">Units</th><th scope="col">Net</th></tr></thead><tbody>{data.summary.topProducts.map((item: any) => <tr key={item.name} className="border-t border-[var(--border)]"><th className="py-3 font-medium">{item.name}</th><td>{item.orders}</td><td>{item.units}</td><td>{money(item.revenueCents)}</td></tr>)}</tbody></table></div>{!data.summary.topProducts.length ? <EmptyState>No data for this period.</EmptyState> : null}</Panel>;
  if (report === "orders" || report === "overview") return <Panel><h2 className="text-lg font-semibold">Order status</h2><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{data.summary.pipeline.map((item: any) => <Link className="ui-card" key={item.status} href={`/staff/orders?status=${item.status}`}><span className="capitalize">{item.status.replaceAll("_", " ")}</span><strong className="float-right">{item.count}</strong></Link>)}</div>{!data.summary.pipeline.length ? <EmptyState>No data for this period.</EmptyState> : null}</Panel>;
  if (report === "inventory") return <Panel><h2 className="text-lg font-semibold">Current stock attention</h2><div className="mt-3 divide-y divide-[var(--border)]">{data.summary.inventoryAlerts.map((item: any) => <Link href={`/staff/inventory/${item.id}`} className="flex justify-between py-3" key={item.id}><span>{item.name}</span><strong>{item.inventory_quantity} on hand</strong></Link>)}</div>{!data.summary.inventoryAlerts.length ? <EmptyState>No low-stock products.</EmptyState> : null}</Panel>;
  if (report === "customers") return <Panel><h2 className="text-lg font-semibold">Identity semantics</h2><p className="mt-2 text-sm text-brand-textMuted">Customer counts use only non-null account ownership. Guest checkout identities are never joined to accounts by matching email. Top-customer detail is deferred until a bounded aggregate can avoid exposing customer records.</p></Panel>;
  return <Panel><h2 className="text-lg font-semibold">Operational interpretation</h2><p className="mt-2 text-sm text-brand-textMuted">Durations include only records with both authoritative stage timestamps. Incomplete intervals are excluded rather than treated as zero. Follow the corresponding operational workspace for record-level action.</p></Panel>;
}
