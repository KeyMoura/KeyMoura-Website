"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, EmptyState, Notice } from "@/components/ui/DesignSystem";
import { moneyFromCents, orderCustomerStatus, orderNeedsCustomerAction, orderNextStep } from "@/lib/orderHub";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { type SupportStatus } from "@/lib/support/domain";

type Order = { id:string; order_number:string|null; product_name:string; status:string; payment_status:string; agreed_price_cents:number|null; amount_paid_cents:number|null; amount_refunded_cents:number|null; fulfillment_method:"shipping"|"pickup"; fulfillment_status:string|null; tracking_number:string|null; updated_at:string; created_at:string };
type Conversation = { id:string; reference:string; subject:string; status:SupportStatus; lastMessageAt:string };
type ViewState = "loading" | "ready" | "error" | "signed-out";

export default function AccountOverviewPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [state, setState] = useState<ViewState>("loading");
  const [name, setName] = useState("there");
  const [orders, setOrders] = useState<Order[]>([]);
  const [support, setSupport] = useState<Conversation[]>([]);

  const load = useCallback(async () => {
    setState("loading");
    const auth = await supabase.auth.getSession();
    const user = auth.data.session?.user;
    if (!user) { setState("signed-out"); return; }
    const [profile, orderResult, supportResult] = await Promise.all([
      supabase.from("profiles").select("display_name,username").eq("id", user.id).maybeSingle<{display_name:string|null;username:string|null}>(),
      supabase.from("orders").select("id,order_number,product_name,status,payment_status,agreed_price_cents,amount_paid_cents,amount_refunded_cents,fulfillment_method,fulfillment_status,tracking_number,updated_at,created_at").eq("customer_id", user.id).order("updated_at", { ascending:false }).limit(8),
      fetch("/api/support/conversations", { headers:{ Authorization:`Bearer ${auth.data.session.access_token}` } }),
    ]);
    if (profile.error || orderResult.error || !supportResult.ok) { setState("error"); return; }
    const supportBody = await supportResult.json() as { conversations?:Conversation[] };
    setName(profile.data?.display_name || profile.data?.username || user.email?.split("@")[0] || "there");
    setOrders((orderResult.data ?? []) as Order[]);
    setSupport((supportBody.conversations ?? []).slice(0, 4));
    setState("ready");
  }, [supabase]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const closed = new Set(["completed", "declined", "cancelled"]);
  const active = orders.filter(order => !closed.has(order.status));
  const attentionOrders = active.filter(orderNeedsCustomerAction);
  const attentionSupport = support.filter(item => item.status === "waiting_on_customer");

  if (state !== "ready") return <main className="page-container py-12">{state === "loading" ? <p role="status">Loading your account…</p> : state === "signed-out" ? <Notice tone="warning"><p>Sign in to open your customer account.</p><Link href="/auth" className="ui-btn ui-btn-primary mt-4">Sign in</Link></Notice> : <Notice tone="danger" role="alert"><p>Unable to load your account right now. Your activity has not been counted as zero.</p><button className="ui-btn ui-btn-secondary mt-4" onClick={() => void load()}>Try again</button></Notice>}</main>;

  return <main className="page-container page-stack">
    <header><p className="ui-eyebrow">Your account</p><h1 className="mt-2 text-3xl font-semibold sm:text-4xl">Welcome back, {name}</h1><p className="mt-2 text-brand-textMuted">Orders, custom work, delivery, and support in one place.</p></header>

    {(attentionOrders.length || attentionSupport.length) ? <section aria-labelledby="attention-title" className="ui-card !border-brand-primary/45">
      <h2 id="attention-title" className="text-xl font-semibold">Needs your attention</h2>
      <ul className="mt-4 divide-y divide-zinc-800">
        {attentionOrders.map(order => <li key={order.id} className="flex flex-col justify-between gap-3 py-4 first:pt-0 sm:flex-row sm:items-center"><div><p className="font-medium">{order.product_name}</p><p className="mt-1 text-sm text-brand-primary">{orderNextStep(order)}</p></div><Link className="ui-btn ui-btn-primary text-center" href={`/orders/${order.id}`}>View order</Link></li>)}
        {attentionSupport.map(item => <li key={item.id} className="flex flex-col justify-between gap-3 py-4 sm:flex-row sm:items-center"><div><p className="font-medium">{item.subject}</p><p className="mt-1 text-sm text-brand-primary">Support is waiting for your reply</p></div><Link className="ui-btn ui-btn-primary text-center" href={`/account/support/${item.id}`}>Reply</Link></li>)}
      </ul>
    </section> : null}

    <section aria-labelledby="active-title"><div className="flex items-end justify-between gap-4"><div><p className="ui-eyebrow">Current activity</p><h2 id="active-title" className="mt-1 text-2xl font-semibold">Active orders & projects</h2></div><Link href="/orders" className="text-sm font-semibold text-brand-primary">View all →</Link></div>
      {active.length ? <div className="mt-4 grid gap-4 lg:grid-cols-2">{active.slice(0,4).map(order => <article className="ui-card" key={order.id}><div className="flex items-start justify-between gap-3"><div><p className="text-xs text-brand-textMuted">{order.order_number || "Request pending"}</p><h3 className="mt-1 text-lg font-semibold">{order.product_name}</h3></div><Badge>{orderCustomerStatus(order.status, order.fulfillment_status)}</Badge></div><p className="mt-4 text-sm"><span className="text-brand-textMuted">Next: </span>{orderNextStep(order)}</p><div className="mt-5 flex flex-wrap items-center justify-between gap-3"><span className="text-sm text-brand-textMuted">{order.agreed_price_cents == null ? "Quote pending" : moneyFromCents(order.agreed_price_cents)} · {order.fulfillment_method === "pickup" ? "Pickup" : order.tracking_number ? "Tracking available" : "Shipping"}</span><Link href={`/orders/${order.id}`} className="ui-btn ui-btn-secondary">View order</Link></div></article>)}</div> : <EmptyState><h3 className="font-semibold text-brand-text">No active orders</h3><p className="mt-2">Browse the catalog to start your next KeyMoura project.</p><Link href="/catalog" className="ui-btn ui-btn-primary mt-4">Browse catalog</Link></EmptyState>}
    </section>

    <section aria-labelledby="recent-title"><h2 id="recent-title" className="text-2xl font-semibold">Recent purchases</h2>{orders.length ? <ul className="ui-card mt-4 divide-y divide-zinc-800">{orders.slice(0,5).map(order => <li key={order.id} className="flex flex-col justify-between gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center"><div><p className="font-medium">{order.product_name}</p><p className="mt-1 text-sm text-brand-textMuted">{order.order_number || "Request pending"} · {new Date(order.created_at).toLocaleDateString()}</p></div><div className="flex items-center gap-3"><Badge>{orderCustomerStatus(order.status, order.fulfillment_status)}</Badge><Link href={`/orders/${order.id}`} aria-label={`View ${order.order_number || order.product_name}`} className="text-sm font-semibold text-brand-primary">View →</Link></div></li>)}</ul> : null}</section>

    <section aria-labelledby="shortcuts-title"><h2 id="shortcuts-title" className="text-2xl font-semibold">Account shortcuts</h2><div className="mt-4 grid gap-3 sm:grid-cols-3"><Link href="/account/support" className="ui-card ui-card-hover"><h3 className="font-semibold">Support</h3><p className="mt-1 text-sm text-brand-textMuted">{support.length ? `${support.filter(item => item.status !== "resolved" && item.status !== "closed").length} open conversations` : "Ask KeyMoura for help"}</p></Link><Link href="/account/profile" className="ui-card ui-card-hover"><h3 className="font-semibold">Profile & sign-in</h3><p className="mt-1 text-sm text-brand-textMuted">Manage your details and login methods</p></Link><Link href="/notifications" className="ui-card ui-card-hover"><h3 className="font-semibold">Notifications</h3><p className="mt-1 text-sm text-brand-textMuted">Order, support, payment, and account updates</p></Link></div></section>
    <aside className="rounded-2xl border border-zinc-800 p-5 text-sm text-brand-textMuted"><strong className="text-brand-text">Have a guest order?</strong> Open it with the secure link and verification details from your confirmation email. Matching an account email never attaches a guest order.</aside>
  </main>;
}
