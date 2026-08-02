"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { Badge, EmptyState, Notice } from "@/components/ui/DesignSystem";
import { SegmentedControl } from "@/components/ui/SegmentedControl";

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
type Sort = "updated_desc" | "created_desc" | "created_asc" | "priority" | "target_date" | "price_desc";

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
  const [sort, setSort] = useState<Sort>("updated_desc");
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
  }).toSorted((a, b) => {
    if (sort === "created_desc") return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (sort === "created_asc") return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    if (sort === "priority") {
      const rank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
      return rank[workspaces[a.id]?.priority ?? "normal"] - rank[workspaces[b.id]?.priority ?? "normal"] || new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    }
    if (sort === "target_date") {
      const aDate = a.target_date ? new Date(`${a.target_date}T00:00:00`).getTime() : Number.MAX_SAFE_INTEGER;
      const bDate = b.target_date ? new Date(`${b.target_date}T00:00:00`).getTime() : Number.MAX_SAFE_INTEGER;
      return aDate - bDate || new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    }
    if (sort === "price_desc") return (b.agreed_price_cents ?? -1) - (a.agreed_price_cents ?? -1);
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  }), [orders, priority, profiles, query, sort, view, workspaces]);

  if (isLoading) return <div className="ui-card">Loading…</div>;
  if (!canView) return <AccessDeniedCard message="You do not have access to orders." />;

  return <main className="page-stack">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="text-xs uppercase tracking-[.2em] text-brand-accent">Commerce</p><h1 className="mt-1 text-3xl font-semibold">Order cockpit</h1><p className="mt-2 text-sm text-brand-textMuted">See what needs attention and move every request through quoting, payment, production, and delivery.</p></div>
      <Link href="/staff/orders/new" className="ui-btn ui-btn-primary w-full text-center text-sm sm:w-auto">Create proposal</Link>
    </div>

    <div className="ui-filter-bar">
      <SegmentedControl className="w-full xl:w-auto" value={view} onChange={setView} ariaLabel="Order queue" options={[{ value: "action", label: `Needs action (${counts.action})` }, { value: "waiting", label: `Waiting (${counts.waiting})` }, { value: "active", label: `Active (${counts.active})` }, { value: "completed", label: `Completed (${counts.completed})` }, { value: "all", label: `All (${counts.all})` }]} />
      <label className="min-w-[14rem] flex-1"><span className="sr-only">Search orders</span><input value={query} onChange={event => setQuery(event.target.value)} className="ui-input h-full" placeholder="Search order, product, customer…" /></label>
      <label><span className="sr-only">Filter by priority</span><select value={priority} onChange={event=>setPriority(event.target.value as PriorityFilter)} className="ui-input h-full"><option value="all">All priorities</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></label>
      <label><span className="sr-only">Sort orders</span><select value={sort} onChange={event=>setSort(event.target.value as Sort)} className="ui-input h-full"><option value="updated_desc">Recently updated</option><option value="created_desc">Newest orders</option><option value="created_asc">Oldest orders</option><option value="priority">Highest priority</option><option value="target_date">Target date</option><option value="price_desc">Highest price</option></select></label>
    </div>

    {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
    <div className="space-y-3">
      {shown.map(order => {
        const profile = profiles[order.customer_id];
        const workspace = workspaces[order.id];
        const customer = profile?.display_name || (profile?.username ? `@${profile.username}` : "Customer");
        return <Link href={`/staff/orders/${order.id}`} key={order.id} className="ui-card ui-card-hover group grid gap-4 md:grid-cols-[1.5fr_1fr_auto] md:items-center">
          <div><div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{order.product_name}</span>{order.quantity > 1 ? <Badge>Qty {order.quantity}</Badge> : null}{workspace && workspace.priority !== "normal" ? <Badge tone={workspace.priority === "urgent" ? "danger" : workspace.priority === "high" ? "warning" : "neutral"}>{pretty(workspace.priority)}</Badge> : null}</div><div className="mt-1 text-xs text-brand-textMuted">{order.order_number || "New request"} · {customer} · {ageLabel(order.updated_at)}</div></div>
          <div><div className="text-sm font-medium text-brand-accent">{nextAction(order)}</div><div className="mt-1 text-xs text-brand-textMuted">{prettyStatus(order.status)} · {pretty(order.payment_status)}</div></div>
          <div className="text-left md:text-right"><div className="font-medium">{money(order.agreed_price_cents)}</div><div className="mt-1 text-xs text-brand-textMuted">{order.target_date ? `Target ${new Date(`${order.target_date}T00:00:00`).toLocaleDateString()}` : "No target date"}</div></div>
        </Link>;
      })}
    </div>
    {!loading && shown.length === 0 ? <EmptyState>{query ? "No orders match that search." : "Nothing in this view."}</EmptyState> : null}
    {loading ? <EmptyState>Loading orders…</EmptyState> : null}
  </main>;
}
