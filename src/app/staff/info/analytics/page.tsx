"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { AccessDenied } from "@/components/AccessDenied";
import type { AnalyticsRange } from "@/lib/businessAnalytics";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";

type Summary = {
  grossCollectedCents: number;
  refundedCents: number;
  netCollectedCents: number;
  outstandingCents: number;
  orderCount: number;
  activeOrderCount: number;
  completedCount: number;
  completionRate: number;
  acceptanceRate: number;
  averageOrderCents: number;
  averageTurnaroundDays: number | null;
  uniqueCustomers: number;
  repeatCustomers: number;
  overdueCount: number;
  agingCount: number;
  pipeline: { status: string; count: number }[];
  topProducts: { name: string; orders: number; units: number; revenueCents: number }[];
  inventoryAlerts: { id: string; name: string; is_published: boolean; inventory_quantity: number; low_stock_threshold: number }[];
  trend: { key: string; label: string; orders: number; netCents: number }[];
};

type AnalyticsResponse = {
  summary: Summary;
  generatedAt: string;
  searchInsights: { searchesRecorded: number; noResultTerms: { query: string; count: number }[] };
};

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
const percent = (value: number) => `${Math.round(value * 100)}%`;
const pretty = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());

function Metric({ label, value, detail, warning = false }: { label: string; value: string; detail: string; warning?: boolean }) {
  return <div className={`rounded-2xl border p-5 ${warning ? "border-amber-400/35 bg-amber-400/[.06]" : "border-brand-border bg-black/25"}`}>
    <p className="text-xs font-medium uppercase tracking-[.16em] text-brand-textMuted">{label}</p>
    <p className="mt-3 text-3xl font-semibold tracking-tight text-brand-text">{value}</p>
    <p className="mt-2 text-xs text-brand-textMuted">{detail}</p>
  </div>;
}

export default function AnalyticsPage() {
  const { data: access, isLoading: accessLoading } = useMeAccess();
  const canView = Boolean(access?.permissions?.includes("analytics.view"));
  const [range, setRange] = useState<AnalyticsRange>("30d");
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!canView) return;
    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      setError("");
      try {
        const session = await supabaseBrowser().auth.getSession();
        const token = session.data.session?.access_token;
        if (!token) throw new Error("You must be signed in.");
        const response = await fetch(`/api/staff/analytics/info?range=${range}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
        const body = await response.json().catch(() => null) as (AnalyticsResponse & { error?: string }) | null;
        if (!response.ok || !body) throw new Error(body?.error ?? "Analytics could not be loaded.");
        setData(body);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Analytics could not be loaded.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [canView, range]);

  const summary = data?.summary;
  const maxTrend = useMemo(() => Math.max(1, ...(summary?.trend.map((point) => point.netCents) ?? [1])), [summary]);
  const maxPipeline = Math.max(1, ...(summary?.pipeline.map((stage) => stage.count) ?? [1]));

  if (accessLoading) return <div className="ui-card p-6 text-sm text-brand-textMuted">Loading analytics…</div>;
  if (!canView) return <div className="mx-auto w-full max-w-6xl p-4"><AccessDenied backHref="/staff" backLabel="Back to staff" /></div>;

  return <main className="mx-auto w-full max-w-7xl">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="text-xs uppercase tracking-[.2em] text-brand-accent">Operations · Analytics</p>
        <h1 className="mt-1 text-3xl font-semibold text-brand-text">Business analytics</h1>
        <p className="mt-2 max-w-2xl text-sm text-brand-textMuted">Track cash, order conversion, turnaround, workshop pressure, inventory risk, and what customers request most.</p>
      </div>
      <div className="flex rounded-xl border border-brand-border bg-black/25 p-1" aria-label="Analytics date range">
        {(["30d", "90d", "all"] as const).map((item) => <button key={item} type="button" onClick={() => setRange(item)} aria-pressed={range === item} className={`min-h-10 rounded-lg px-3 py-2 text-xs font-medium transition ${range === item ? "bg-brand-accent text-black" : "text-brand-textMuted hover:text-brand-accent"}`}>{item === "all" ? "All time" : item === "30d" ? "30 days" : "90 days"}</button>)}
      </div>
    </div>

    {error ? <p role="alert" className="mt-5 rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200">{error}</p> : null}
    {loading && !summary ? <div className="mt-6 rounded-2xl border border-brand-border bg-black/20 p-12 text-center text-brand-textMuted">Loading business analytics…</div> : null}

    {summary ? <>
      <section className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Financial summary">
        <Metric label="Net collected" value={money(summary.netCollectedCents)} detail={`${money(summary.grossCollectedCents)} gross · ${money(summary.refundedCents)} refunded`} />
        <Metric label="Outstanding" value={money(summary.outstandingCents)} detail="Quoted balance remaining on active orders" warning={summary.outstandingCents > 0} />
        <Metric label="Average paid order" value={money(summary.averageOrderCents)} detail="Net collected per order with payment" />
        <Metric label="Active workload" value={String(summary.activeOrderCount)} detail={`${summary.overdueCount} overdue · ${summary.agingCount} untouched for 14+ days`} warning={summary.overdueCount > 0 || summary.agingCount > 0} />
      </section>

      <section className="mt-5 grid gap-5 xl:grid-cols-[1.55fr_1fr]">
        <div className="rounded-2xl border border-brand-border bg-black/25 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Net revenue trend</h2><p className="mt-1 text-xs text-brand-textMuted">Payments collected minus refunds; hover a bar for the exact value.</p></div><Link href="/staff/orders" className="text-xs font-medium text-brand-accent hover:underline">View orders</Link></div>
          <div className="mt-6 flex h-48 items-end gap-1.5" aria-label="Net revenue chart">
            {summary.trend.map((point) => <div key={point.key} className="group flex min-w-0 flex-1 flex-col items-center justify-end gap-2" title={`${point.label}: ${money(point.netCents)} net, ${point.orders} orders`}><div className="w-full rounded-t-md bg-brand-accent/75 transition group-hover:bg-brand-accent" style={{ height: `${Math.max(point.netCents ? 7 : 2, point.netCents / maxTrend * 100)}%` }} /><span className="hidden text-[9px] text-brand-textMuted first:block last:block sm:block sm:[&:not(:nth-child(4n+1))]:hidden">{point.label}</span></div>)}
          </div>
        </div>
        <div className="rounded-2xl border border-brand-border bg-black/25 p-5">
          <h2 className="text-lg font-semibold">Order outcomes</h2><p className="mt-1 text-xs text-brand-textMuted">Performance for orders requested in this period</p>
          <dl className="mt-5 grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-white/10 p-3"><dt className="text-xs text-brand-textMuted">Requests</dt><dd className="mt-1 text-2xl font-semibold">{summary.orderCount}</dd></div>
            <div className="rounded-xl border border-white/10 p-3"><dt className="text-xs text-brand-textMuted">Completed</dt><dd className="mt-1 text-2xl font-semibold">{summary.completedCount}</dd></div>
            <div className="rounded-xl border border-white/10 p-3"><dt className="text-xs text-brand-textMuted">Accepted</dt><dd className="mt-1 text-2xl font-semibold">{percent(summary.acceptanceRate)}</dd></div>
            <div className="rounded-xl border border-white/10 p-3"><dt className="text-xs text-brand-textMuted">Completion rate</dt><dd className="mt-1 text-2xl font-semibold">{percent(summary.completionRate)}</dd></div>
          </dl>
          <p className="mt-4 text-xs text-brand-textMuted">Average production turnaround: <strong className="text-brand-text">{summary.averageTurnaroundDays == null ? "Not enough completed orders" : `${summary.averageTurnaroundDays.toFixed(1)} days`}</strong></p>
        </div>
      </section>

      <section className="mt-5 grid gap-5 xl:grid-cols-2">
        <div className="rounded-2xl border border-brand-border bg-black/25 p-5"><h2 className="text-lg font-semibold">Order pipeline</h2><p className="mt-1 text-xs text-brand-textMuted">Requests created in this period by current status</p><div className="mt-5 space-y-3">{summary.pipeline.map((stage) => <div key={stage.status}><div className="flex justify-between gap-3 text-sm"><span>{pretty(stage.status)}</span><span className="font-semibold">{stage.count}</span></div><div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-brand-accent" style={{ width: `${Math.max(8, stage.count / maxPipeline * 100)}%` }} /></div></div>)}</div>{!summary.pipeline.length ? <p className="mt-6 text-sm text-brand-textMuted">No orders in this period.</p> : null}</div>
        <div className="rounded-2xl border border-brand-border bg-black/25 p-5"><h2 className="text-lg font-semibold">Customer health</h2><p className="mt-1 text-xs text-brand-textMuted">How broad and repeatable demand is becoming</p><dl className="mt-5 grid grid-cols-2 gap-3"><div className="rounded-xl border border-white/10 p-3"><dt className="text-xs text-brand-textMuted">Unique customers</dt><dd className="mt-1 text-2xl font-semibold">{summary.uniqueCustomers}</dd></div><div className="rounded-xl border border-white/10 p-3"><dt className="text-xs text-brand-textMuted">Repeat customers</dt><dd className="mt-1 text-2xl font-semibold">{summary.repeatCustomers}</dd></div></dl><p className="mt-4 text-xs text-brand-textMuted">A repeat customer has submitted more than one order during the selected period.</p></div>
      </section>

      <section className="mt-5 grid gap-5 xl:grid-cols-2">
        <div className="rounded-2xl border border-brand-border bg-black/25 p-5"><div className="flex justify-between gap-3"><div><h2 className="text-lg font-semibold">Most requested products</h2><p className="mt-1 text-xs text-brand-textMuted">Ranked by order count, including custom requests</p></div><Link href="/staff/catalog" className="text-xs font-medium text-brand-accent hover:underline">Catalog</Link></div><div className="mt-4 divide-y divide-white/10">{summary.topProducts.map((product) => <div key={product.name} className="grid grid-cols-[1fr_auto] gap-4 py-3"><div><p className="text-sm font-medium">{product.name}</p><p className="mt-1 text-xs text-brand-textMuted">{product.units} unit{product.units === 1 ? "" : "s"} · {money(product.revenueCents)} net</p></div><span className="text-sm font-semibold">{product.orders}</span></div>)}</div>{!summary.topProducts.length ? <p className="mt-6 text-sm text-brand-textMuted">No product demand yet.</p> : null}</div>
        <div className="rounded-2xl border border-brand-border bg-black/25 p-5"><div className="flex justify-between gap-3"><div><h2 className="text-lg font-semibold">Inventory risk</h2><p className="mt-1 text-xs text-brand-textMuted">Tracked items at or below their warning threshold</p></div><Link href="/staff/catalog" className="text-xs font-medium text-brand-accent hover:underline">Restock</Link></div><div className="mt-4 divide-y divide-white/10">{summary.inventoryAlerts.slice(0, 8).map((product) => <div key={product.id} className="flex items-center justify-between gap-4 py-3"><div><p className="text-sm font-medium">{product.name}</p><p className="mt-1 text-xs text-brand-textMuted">Alert at {product.low_stock_threshold} · {product.is_published ? "Published" : "Draft"}</p></div><span className={`rounded-full px-2.5 py-1 text-xs ${product.inventory_quantity === 0 ? "bg-rose-500/15 text-rose-200" : "bg-amber-400/10 text-amber-200"}`}>{product.inventory_quantity === 0 ? "Out" : `${product.inventory_quantity} left`}</span></div>)}</div>{!summary.inventoryAlerts.length ? <p className="mt-6 text-sm text-brand-textMuted">No low-stock products.</p> : null}</div>
      </section>

      <section className="mt-5 rounded-2xl border border-brand-border bg-black/25 p-5"><h2 className="text-lg font-semibold">Customer search gaps</h2><p className="mt-1 text-xs text-brand-textMuted">A compact replacement for the old search-only analytics page: terms customers searched that returned no Info results.</p><div className="mt-4 flex flex-wrap gap-2">{data?.searchInsights.noResultTerms.map((term) => <span key={term.query} className="rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-xs">{term.query} <span className="text-brand-textMuted">×{term.count}</span></span>)}</div>{!data?.searchInsights.noResultTerms.length ? <p className="mt-4 text-sm text-brand-textMuted">No repeated content gaps in the latest {data?.searchInsights.searchesRecorded ?? 0} recorded searches.</p> : null}</section>
      <p className="mt-4 text-right text-[11px] text-brand-textMuted">Updated {new Date(data.generatedAt).toLocaleString()}</p>
    </> : null}
  </main>;
}
