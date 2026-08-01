"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";

type Order = {
  id: string;
  order_number: string | null;
  customer_id: string;
  product_name: string;
  status: string;
  quantity: number;
  agreed_price_cents: number | null;
  payment_status: string;
  target_date: string | null;
  created_at: string;
  updated_at: string;
  shipped_at: string | null;
  delivered_at: string | null;
};

type Profile = { id: string; username: string | null; display_name: string | null };
type Workspace = { order_id:string; priority:"low"|"normal"|"high"|"urgent"; assigned_to:string|null; started_at:string|null };
type View = "action" | "waiting" | "active" | "completed" | "all";
type PriorityFilter = "all" | Workspace["priority"];

const closedStatuses = new Set(["completed", "declined", "cancelled"]);
const pretty = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, char => char.toUpperCase());
const prettyStatus = (value: string) => value === "customer_review" ? "Quote Review" : value === "final_review" ? "Finished Product Review" : pretty(value);
const money = (cents: number | null) => cents == null ? "Price pending" : `$${(cents / 100).toFixed(2)}`;

function needsStaffAction(order: Order) {
  return order.status === "requested"
    || (order.status === "accepted" && order.agreed_price_cents == null)
    || (order.status === "ready" && !order.shipped_at)
    || Boolean(order.shipped_at && !order.delivered_at);
}

function isWaitingOnCustomer(order: Order) {
  return ["needs_information", "awaiting_payment", "customer_review", "final_review"].includes(order.status);
}

function ageLabel(value: string) {
  const hours = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 3_600_000));
  if (hours < 1) return "Updated just now";
  if (hours < 24) return `Updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Updated ${days}d ago`;
}

function nextAction(order: Order) {
  if (order.status === "requested") return "Review request";
  if (order.status === "needs_information") return "Waiting on customer details";
  if (order.status === "accepted" && order.agreed_price_cents == null) return "Prepare quote";
  if (order.status === "awaiting_payment") return "Waiting on customer payment";
  if (order.status === "in_progress") return "Continue production";
  if (order.status === "customer_review") return "Waiting on quote approval";
  if (order.status === "final_review") return "Waiting on finished-product approval";
  if (order.status === "ready" && !order.shipped_at) return "Arrange delivery";
  if (order.shipped_at && !order.delivered_at) return "Confirm delivery";
  return "View order";
}

export default function StaffOrdersPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { data: access, isLoading } = useMeAccess();
  const permissions = new Set(access?.permissions ?? []);
  const canView = permissions.has("orders.view") || permissions.has("orders.manage");
  const [orders, setOrders] = useState<Order[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [workspaces, setWorkspaces] = useState<Record<string, Workspace>>({});
  const [view, setView] = useState<View>("action");
  const [priority, setPriority] = useState<PriorityFilter>("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!canView) return;
    void (async () => {
      setLoading(true);
      const [orderResult, workspaceResult] = await Promise.all([
        supabase.from("orders").select("id,order_number,customer_id,product_name,status,quantity,agreed_price_cents,payment_status,target_date,created_at,updated_at,shipped_at,delivered_at").order("updated_at", { ascending: false }),
        supabase.from("order_workspaces").select("order_id,priority,assigned_to,started_at"),
      ]);
      const rows = (orderResult.data ?? []) as Order[];
      setOrders(rows);
      const workspaceRows = (workspaceResult.data ?? []) as Workspace[];
      setWorkspaces(Object.fromEntries(workspaceRows.map(item => [item.order_id, item])));
      if (rows.length) {
        const profileResult = await supabase.from("profiles").select("id,username,display_name").in("id", [...new Set(rows.map(row => row.customer_id))]);
        const profileRows = (profileResult.data ?? []) as Profile[];
        setProfiles(Object.fromEntries(profileRows.map(profile => [profile.id, profile])));
        setError(orderResult.error?.message ?? workspaceResult.error?.message ?? profileResult.error?.message ?? "");
      } else {
        setError(orderResult.error?.message ?? workspaceResult.error?.message ?? "");
      }
      setLoading(false);
    })();
  }, [canView, supabase]);

  const counts = useMemo(() => ({
    action: orders.filter(needsStaffAction).length,
    waiting: orders.filter(isWaitingOnCustomer).length,
    active: orders.filter(order => !closedStatuses.has(order.status)).length,
    completed: orders.filter(order => closedStatuses.has(order.status)).length,
    all: orders.length,
  }), [orders]);

  const shown = useMemo(() => orders.filter(order => {
    if (view === "action" && !needsStaffAction(order)) return false;
    if (view === "waiting" && !isWaitingOnCustomer(order)) return false;
    if (view === "active" && closedStatuses.has(order.status)) return false;
    if (view === "completed" && !closedStatuses.has(order.status)) return false;
    if (priority !== "all" && (workspaces[order.id]?.priority ?? "normal") !== priority) return false;
    const profile = profiles[order.customer_id];
    const haystack = [order.order_number, order.product_name, profile?.display_name, profile?.username].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  }), [orders, priority, profiles, query, view, workspaces]);

  if (isLoading) return <div className="ui-card">Loading…</div>;
  if (!canView) return <AccessDeniedCard message="You do not have access to orders." />;

  return <main>
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="text-xs uppercase tracking-[.2em] text-brand-accent">Commerce</p><h1 className="mt-1 text-3xl font-semibold">Order cockpit</h1><p className="mt-2 text-sm text-brand-textMuted">See what needs attention and move every request through quoting, payment, production, and delivery.</p></div>
      <div className="flex w-full gap-2 sm:w-auto"><label className="min-w-0 flex-1 sm:w-72"><span className="sr-only">Search orders</span><input value={query} onChange={event => setQuery(event.target.value)} className="w-full rounded-xl border border-brand-border bg-black/30 px-4 py-2.5 text-sm outline-none focus:border-brand-accent" placeholder="Search order, product, customer…" /></label><label><span className="sr-only">Filter by priority</span><select value={priority} onChange={event=>setPriority(event.target.value as PriorityFilter)} className="h-full rounded-xl border border-brand-border bg-black/30 px-3 text-sm outline-none focus:border-brand-accent"><option value="all">All priorities</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></label></div>
    </div>

    <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {(["action", "waiting", "active", "completed", "all"] as const).map(item => <button key={item} onClick={() => setView(item)} className={`rounded-2xl border p-4 text-left transition ${view === item ? "border-brand-accent bg-brand-accent/10" : "border-brand-border bg-black/20 hover:border-brand-accent/60"}`}><div className="text-2xl font-semibold">{counts[item]}</div><div className={`mt-1 text-sm ${view === item ? "text-brand-accent" : "text-brand-textMuted"}`}>{item === "action" ? "Needs action" : item === "waiting" ? "Waiting on customer" : pretty(item)}</div></button>)}
    </div>

    {error ? <p className="mt-4 rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-rose-200">{error}</p> : null}
    <div className="mt-5 space-y-3">
      {shown.map(order => {
        const profile = profiles[order.customer_id];
        const workspace = workspaces[order.id];
        const customer = profile?.display_name || (profile?.username ? `@${profile.username}` : "Customer");
        return <Link href={`/staff/orders/${order.id}`} key={order.id} className="group grid gap-4 rounded-2xl border border-brand-border bg-black/25 p-5 transition hover:border-brand-accent/70 md:grid-cols-[1.5fr_1fr_auto] md:items-center">
          <div><div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{order.product_name}</span>{order.quantity > 1 ? <span className="rounded-full border border-brand-border px-2 py-0.5 text-[11px] text-brand-textMuted">Qty {order.quantity}</span> : null}{workspace && workspace.priority !== "normal" ? <span className={`rounded-full border px-2 py-0.5 text-[11px] ${workspace.priority === "urgent" ? "border-rose-500/60 text-rose-300" : workspace.priority === "high" ? "border-amber-500/60 text-amber-200" : "border-zinc-600 text-brand-textMuted"}`}>{pretty(workspace.priority)}</span> : null}</div><div className="mt-1 text-xs text-brand-textMuted">{order.order_number || "New request"} · {customer} · {ageLabel(order.updated_at)}</div></div>
          <div><div className="text-sm font-medium text-brand-accent">{nextAction(order)}</div><div className="mt-1 text-xs text-brand-textMuted">{prettyStatus(order.status)} · {pretty(order.payment_status)}</div></div>
          <div className="text-left md:text-right"><div className="font-medium">{money(order.agreed_price_cents)}</div><div className="mt-1 text-xs text-brand-textMuted">{order.target_date ? `Target ${new Date(`${order.target_date}T00:00:00`).toLocaleDateString()}` : "No target date"}</div></div>
        </Link>;
      })}
    </div>
    {!loading && shown.length === 0 ? <div className="mt-8 rounded-2xl border border-dashed border-brand-border p-10 text-center text-brand-textMuted">{query ? "No orders match that search." : "Nothing in this view."}</div> : null}
    {loading ? <p className="mt-8 text-center text-brand-textMuted">Loading orders…</p> : null}
  </main>;
}
