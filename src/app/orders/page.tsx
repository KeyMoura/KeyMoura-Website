"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { moneyFromCents, orderCustomerStatus, orderLabel, orderNeedsCustomerAction, orderNextStep } from "@/lib/orderHub";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { Badge, EmptyState, MetricCard, Notice } from "@/components/ui/DesignSystem";
import { SegmentedControl } from "@/components/ui/SegmentedControl";

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

type Filter = "active" | "complete" | "cancelled" | "all";
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
  const cancelled = orders.filter((order) => ["declined", "cancelled"].includes(order.status));
  const finished = orders.filter((order) => order.status === "completed");
  const filtered = filter === "active" ? active : filter === "complete" ? finished : filter === "cancelled" ? cancelled : orders;
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
    <main className="page-container page-stack">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[.2em] text-brand-primary">Customer hub</p>
          <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">Your KeyMoura orders</h1>
          <p className="mt-2 max-w-2xl text-sm text-brand-textMuted">Track requests, reply to questions, pay securely, and follow delivery from one place.</p>
        </div>
        <Link href="/catalog" className="ui-btn ui-btn-primary w-full text-center text-sm sm:w-auto">Start a new request</Link>
      </div>

      {!loading && !error && orders.length > 0 ? (
        <section className="grid gap-3 sm:grid-cols-3">
          <MetricCard label="Active orders" value={active.length} detail="Requests currently moving through KeyMoura" />
          <MetricCard label="Need your attention" value={actionable.length} detail="Replies, approvals, or payment needed" tone={actionable.length ? "warning" : "default"} />
          <MetricCard label="Finished" value={completed.length} detail="Completed, declined, or cancelled" />
        </section>
      ) : null}

      <div className="ui-filter-bar flex-col sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl className="w-full sm:w-auto" value={filter} onChange={setFilter} ariaLabel="Filter orders" options={[{ value: "active", label: `Active (${active.length})` }, { value: "complete", label: `Completed (${finished.length})` }, { value: "cancelled", label: `Cancelled / refunded (${cancelled.length})` }, { value: "all", label: `All (${orders.length})` }]} />
        <label className="flex w-full items-center gap-2 text-sm text-brand-textMuted sm:w-auto sm:shrink-0">
          <span className="shrink-0">Sort by</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as Sort)} className="ui-input min-w-0 flex-1 sm:w-auto sm:flex-none" aria-label="Sort your orders">
            <option value="updated">Recently updated</option>
            <option value="newest">Newest request</option>
            <option value="oldest">Oldest request</option>
            <option value="attention">Needs attention first</option>
            <option value="price_high">Price: high to low</option>
            <option value="price_low">Price: low to high</option>
          </select>
        </label>
      </div>

      {loading ? <EmptyState>Loading your orders…</EmptyState> : null}
      {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {shown.map((order) => {
          const needsAction = orderNeedsCustomerAction(order);
          return (
            <Link key={order.id} href={`/orders/${order.id}`} className={`ui-card ui-card-hover group ${needsAction ? "!border-brand-primary/45" : ""}`}>
              <div className="flex items-start justify-between gap-4">
                <div><p className="text-xs text-brand-textMuted">{order.order_number || "Request pending review"}</p><h2 className="mt-1 text-lg font-semibold group-hover:text-brand-primary">{order.product_name}</h2></div>
                <Badge>{orderCustomerStatus(order.status, null)}</Badge>
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
      {!loading && !error && orders.length === 0 ? <EmptyState><h2 className="text-lg font-semibold text-brand-text">No requests yet</h2><p className="mt-2">Browse the catalog and tell us what you want made.</p><Link href="/catalog" className="ui-btn ui-btn-primary mt-5">Browse catalog</Link></EmptyState> : null}
      {!loading && !error && orders.length > 0 && shown.length === 0 ? <EmptyState>Nothing in this view right now.</EmptyState> : null}
    </main>
  );
}
