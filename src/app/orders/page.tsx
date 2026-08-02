"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { moneyFromCents, orderLabel, orderNeedsCustomerAction, orderNextStep } from "@/lib/orderHub";
import { supabaseBrowser } from "@/lib/supabaseClient";

type Order = {
  id: string;
  order_number: string | null;
  product_name: string;
  status: string;
  agreed_price_cents: number | null;
  payment_status: string;
  fulfillment_method: "shipping" | "pickup";
  tracking_number: string | null;
  created_at: string;
  updated_at: string;
};

type Filter = "active" | "action" | "complete" | "all";
type Sort = "updated" | "newest" | "oldest" | "attention" | "price_high" | "price_low";

export default function OrdersPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [orders, setOrders] = useState<Order[]>([]);
  const [filter, setFilter] = useState<Filter>("active");
  const [sort, setSort] = useState<Sort>("updated");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) {
        setError("Sign in to view your requests.");
        setLoading(false);
        return;
      }
      const result = await supabase
        .from("orders")
        .select("id,order_number,product_name,status,agreed_price_cents,payment_status,fulfillment_method,tracking_number,created_at,updated_at")
        .eq("customer_id", data.user.id)
        .order("updated_at", { ascending: false });
      setOrders((result.data ?? []) as Order[]);
      setError(result.error?.message ?? "");
      setLoading(false);
    });
  }, [supabase]);

  const actionable = orders.filter(orderNeedsCustomerAction);
  const active = orders.filter((order) => !["completed", "declined", "cancelled"].includes(order.status));
  const completed = orders.filter((order) => ["completed", "declined", "cancelled"].includes(order.status));
  const filtered = filter === "action" ? actionable : filter === "active" ? active : filter === "complete" ? completed : orders;
  const shown = [...filtered].sort((left, right) => {
    if (sort === "newest") return Date.parse(right.created_at) - Date.parse(left.created_at);
    if (sort === "oldest") return Date.parse(left.created_at) - Date.parse(right.created_at);
    if (sort === "attention") {
      const actionDifference = Number(orderNeedsCustomerAction(right)) - Number(orderNeedsCustomerAction(left));
      return actionDifference || Date.parse(right.updated_at) - Date.parse(left.updated_at);
    }
    if (sort === "price_high" || sort === "price_low") {
      if (left.agreed_price_cents == null) return 1;
      if (right.agreed_price_cents == null) return -1;
      const leftPrice = left.agreed_price_cents;
      const rightPrice = right.agreed_price_cents;
      return sort === "price_high" ? rightPrice - leftPrice : leftPrice - rightPrice;
    }
    return Date.parse(right.updated_at) - Date.parse(left.updated_at);
  });

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-12">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[.2em] text-brand-primary">Customer hub</p>
          <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">Your KeyMoura orders</h1>
          <p className="mt-2 max-w-2xl text-sm text-brand-textMuted">Track requests, reply to questions, pay securely, and follow delivery from one place.</p>
        </div>
        <Link href="/catalog" className="catalog-action-primary rounded-full px-5 py-2.5 text-sm font-semibold">Start a new request</Link>
      </div>

      {!loading && !error && orders.length > 0 ? (
        <section className="mt-8 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-zinc-800 bg-black/30 p-4"><div className="text-2xl font-semibold">{active.length}</div><div className="mt-1 text-xs text-brand-textMuted">Active orders</div></div>
          <div className={`rounded-2xl border p-4 ${actionable.length ? "border-brand-primary/50 bg-brand-primary/10" : "border-zinc-800 bg-black/30"}`}><div className="text-2xl font-semibold">{actionable.length}</div><div className="mt-1 text-xs text-brand-textMuted">Need your attention</div></div>
          <div className="rounded-2xl border border-zinc-800 bg-black/30 p-4"><div className="text-2xl font-semibold">{completed.length}</div><div className="mt-1 text-xs text-brand-textMuted">Finished</div></div>
        </section>
      ) : null}

      <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Filter orders">
          {([['active', `Active (${active.length})`], ['action', `Needs attention (${actionable.length})`], ['complete', `Finished (${completed.length})`], ['all', `All (${orders.length})`]] as [Filter, string][]).map(([value, text]) => (
            <button key={value} type="button" onClick={() => setFilter(value)} className={`shrink-0 rounded-full border px-4 py-2 text-sm transition ${filter === value ? "border-brand-primary bg-brand-primary/15 text-brand-primary" : "border-zinc-700 text-brand-textMuted hover:border-zinc-500 hover:text-brand-text"}`}>{text}</button>
          ))}
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm text-brand-textMuted">
          <span>Sort by</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as Sort)} className="rounded-xl border border-zinc-700 bg-black/30 px-3 py-2 text-brand-text outline-none focus:border-brand-primary" aria-label="Sort your orders">
            <option value="updated">Recently updated</option>
            <option value="newest">Newest request</option>
            <option value="oldest">Oldest request</option>
            <option value="attention">Needs attention first</option>
            <option value="price_high">Price: high to low</option>
            <option value="price_low">Price: low to high</option>
          </select>
        </label>
      </div>

      {loading ? <p className="mt-8 text-brand-textMuted">Loading your orders…</p> : null}
      {error ? <div className="mt-8 rounded-2xl border border-rose-400/30 bg-rose-400/10 p-5 text-rose-100">{error}</div> : null}
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {shown.map((order) => {
          const needsAction = orderNeedsCustomerAction(order);
          return (
            <Link key={order.id} href={`/orders/${order.id}`} className={`group rounded-2xl border bg-black/30 p-5 transition hover:-translate-y-0.5 hover:border-brand-primary/60 ${needsAction ? "border-brand-primary/45" : "border-zinc-800"}`}>
              <div className="flex items-start justify-between gap-4">
                <div><p className="text-xs text-brand-textMuted">{order.order_number || "Request pending review"}</p><h2 className="mt-1 text-lg font-semibold group-hover:text-brand-primary">{order.product_name}</h2></div>
                <span className="shrink-0 rounded-full border border-zinc-700 px-3 py-1 text-xs text-brand-textMuted">{orderLabel(order.status)}</span>
              </div>
              <div className={`mt-5 rounded-xl border p-3 text-sm ${needsAction ? "border-brand-primary/30 bg-brand-primary/10 text-brand-primary" : "border-zinc-800 text-brand-textMuted"}`}><span className="font-medium">Next:</span> {orderNextStep(order)}</div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-brand-textMuted">
                <span>{order.agreed_price_cents == null ? "Price pending" : `${moneyFromCents(order.agreed_price_cents)} · ${orderLabel(order.payment_status)}`}</span>
                <span>Updated {new Date(order.updated_at).toLocaleDateString()}</span>
              </div>
            </Link>
          );
        })}
      </div>
      {!loading && !error && orders.length === 0 ? <div className="mt-8 rounded-2xl border border-zinc-800 bg-black/20 p-10 text-center"><h2 className="text-lg font-semibold">No requests yet</h2><p className="mt-2 text-sm text-brand-textMuted">Browse the catalog and tell us what you want made.</p><Link href="/catalog" className="catalog-action-primary mt-5 inline-block rounded-full px-5 py-2.5 text-sm font-semibold">Browse catalog</Link></div> : null}
      {!loading && !error && orders.length > 0 && shown.length === 0 ? <div className="mt-8 rounded-2xl border border-zinc-800 p-8 text-center text-brand-textMuted">Nothing in this view right now.</div> : null}
    </main>
  );
}
