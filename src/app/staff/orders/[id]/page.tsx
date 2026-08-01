"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { RequestSpecifications } from "@/components/RequestSpecifications";
import { StaffOrderWorkspace } from "@/components/staff/StaffOrderWorkspace";

type Order = {
  id: string;
  order_number: string | null;
  customer_id: string;
  product_name: string;
  status: string;
  quantity: number;
  specifications: Record<string, unknown>;
  customer_notes: string | null;
  staff_notes: string | null;
  agreed_price_cents: number | null;
  payment_status: string;
  amount_paid_cents: number;
  target_date: string | null;
  fulfillment_method: "shipping" | "pickup";
  shipping_address: Record<string, string> | null;
  shipping_carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  created_at: string;
  paid_at: string | null;
};
type Message = {
  id: number;
  sender_id: string;
  body: string;
  is_internal: boolean;
  created_at: string;
};
type EmailDelivery = { id:string; recipient:string; subject:string; status:"sent"|"failed"|"skipped"; error_message:string|null; created_at:string };
type History = { id:number; from_status:string|null; to_status:string; note:string|null; created_at:string };
const statuses = [
  "requested",
  "needs_information",
  "accepted",
  "awaiting_payment",
  "in_progress",
  "customer_review",
  "ready",
  "completed",
  "declined",
  "cancelled",
];
const pretty = (s: string) =>
  s.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
export default function StaffOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { data: access, isLoading } = useMeAccess();
  const perms = new Set(access?.permissions ?? []);
  const canView = perms.has("orders.view") || perms.has("orders.manage");
  const canManage = perms.has("orders.manage");
  const [order, setOrder] = useState<Order | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [emails, setEmails] = useState<EmailDelivery[]>([]);
  const [history, setHistory] = useState<History[]>([]);
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [price, setPrice] = useState("");
  const [paid, setPaid] = useState("");
  const [target, setTarget] = useState("");
  const [staffNotes, setStaffNotes] = useState("");
  const [method, setMethod] = useState<"shipping"|"pickup">("shipping");
  const [address, setAddress] = useState({ name:"", line1:"", line2:"", city:"", state:"", postal_code:"", country:"US" });
  const [carrier, setCarrier] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [trackingUrl, setTrackingUrl] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const [o, m, e, h] = await Promise.all([
      supabase.from("orders").select("*").eq("id", id).maybeSingle(),
      supabase
        .from("order_messages")
        .select("*")
        .eq("order_id", id)
        .order("created_at"),
      supabase.from("email_deliveries").select("id,recipient,subject,status,error_message,created_at").eq("order_id",id).order("created_at",{ascending:false}),
      supabase.from("order_status_history").select("id,from_status,to_status,note,created_at").eq("order_id",id).order("created_at",{ascending:false}),
    ]);
    const row = o.data as Order | null;
    setOrder(row);
    setMessages((m.data ?? []) as Message[]);
    setEmails((e.data ?? []) as EmailDelivery[]);
    setHistory((h.data ?? []) as History[]);
    if (row) {
      setPrice(
        row.agreed_price_cents == null
          ? ""
          : String(row.agreed_price_cents / 100),
      );
      setPaid(String(row.amount_paid_cents / 100));
      setTarget(row.target_date ?? "");
      setStaffNotes(row.staff_notes ?? "");
      setMethod(row.fulfillment_method ?? "shipping");
      setAddress({ name:"", line1:"", line2:"", city:"", state:"", postal_code:"", country:"US", ...(row.shipping_address ?? {}) });
      setCarrier(row.shipping_carrier ?? "");
      setTrackingNumber(row.tracking_number ?? "");
      setTrackingUrl(row.tracking_url ?? "");
    }
    setError(o.error?.message ?? m.error?.message ?? "");
  }, [id, supabase]);
  useEffect(() => {
    if (!canView) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [canView, load]);
  async function authHeaders() {
    const session = await supabase.auth.getSession();
    return {
      "Content-Type": "application/json",
      ...(session.data.session?.access_token
        ? { Authorization: `Bearer ${session.data.session.access_token}` }
        : {}),
    };
  }
  async function updateStatus(status: string) {
    const r = await fetch(`/api/staff/orders/${id}`, {
      method: "PATCH",
      headers: await authHeaders(),
      body: JSON.stringify({ status }),
    });
    const result = await r.json();
    if (!r.ok) {
      setError(result.error || "Could not update status");
      return;
    }
    await load();
  }
  async function save() {
    const priceCents = price.trim() ? Math.round(Number(price) * 100) : null;
    const r = await fetch(`/api/staff/orders/${id}`, {
      method: "PATCH",
      headers: await authHeaders(),
      body: JSON.stringify({
        agreed_price_cents: priceCents,
        target_date: target || null,
        staff_notes: staffNotes || null,
        fulfillment_method: method,
        shipping_address: method === "shipping" ? address : null,
        shipping_carrier: carrier || null,
        tracking_number: trackingNumber || null,
        tracking_url: trackingUrl || null,
      }),
    });
    const result = await r.json();
    if (!r.ok) setError(result.error || "Could not save details");
    else await load();
  }
  async function fulfillmentAction(shipment_action: "mark_shipped"|"mark_delivered") {
    const r = await fetch(`/api/staff/orders/${id}`, { method:"PATCH", headers:await authHeaders(), body:JSON.stringify({ shipment_action, fulfillment_method:method, shipping_address:method === "shipping" ? address : null, shipping_carrier:carrier || null, tracking_number:trackingNumber || null, tracking_url:trackingUrl || null }) });
    const result = await r.json();
    if (!r.ok) setError(result.error || "Could not update fulfillment"); else { setError(""); await load(); }
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    const r = await fetch(`/api/orders/${id}/messages`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ body: body.trim(), internal }),
    });
    const result = await r.json();
    if (!r.ok) setError(result.error || "Could not send message");
    else {
      setBody("");
      await load();
    }
  }
  if (isLoading) return <div className="ui-card">Loading…</div>;
  if (!canView)
    return <AccessDeniedCard message="You do not have access to orders." />;
  if (!order)
    return <p className="text-rose-200">{error || "Order not found."}</p>;
  const input =
    "rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 outline-none focus:border-brand-primary";
  return (
    <main>
      <p className="text-xs uppercase tracking-[.2em] text-brand-primary">
        {order.order_number || "Request pending"}
      </p>
      <h1 className="mt-1 text-3xl font-semibold">{order.product_name}</h1>
      <p className="mt-1 text-sm text-brand-textMuted">
        Customer {order.customer_id} · Quantity {order.quantity}
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        {statuses.map((s) => (
          <button
            disabled={!canManage}
            onClick={() => void updateStatus(s)}
            key={s}
            className={`rounded-full border px-3 py-1.5 text-xs ${order.status === s ? "border-brand-primary bg-brand-primary/10 text-brand-primary" : "border-zinc-700 text-brand-textMuted"}`}
          >
            {pretty(s)}
          </button>
        ))}
      </div>
      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <div className="lg:col-span-2">
          <StaffOrderWorkspace orderId={id} canManage={canManage} />
        </div>
        <section className="rounded-2xl border border-zinc-800 bg-black/30 p-5">
          <h2 className="font-semibold">Order details</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              Agreed price ($)
              <input
                disabled={!canManage || order.payment_status === "paid"}
                className={`${input} mt-1 w-full`}
                type="number"
                step=".01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </label>
            <label className="text-sm">
              Amount paid ($)
              <input
                disabled
                className={`${input} mt-1 w-full opacity-70`}
                type="number"
                value={paid}
              />
              <span className="mt-1 block text-[10px] text-brand-textMuted">
                Updated automatically by Stripe
              </span>
            </label>
            <label className="text-sm">
              Target date
              <input
                disabled={!canManage}
                className={`${input} mt-1 w-full`}
                type="date"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
            </label>
            <label className="text-sm sm:col-span-2">
              Internal notes
              <textarea
                disabled={!canManage}
                className={`${input} mt-1 min-h-24 w-full`}
                value={staffNotes}
                onChange={(e) => setStaffNotes(e.target.value)}
              />
            </label>
          </div>
          <div className="mt-5 border-t border-zinc-800 pt-5">
            <h2 className="font-semibold">Fulfillment</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-sm">Delivery method<select disabled={!canManage} className={`${input} mt-1 w-full`} value={method} onChange={e=>setMethod(e.target.value as "shipping"|"pickup")}><option value="shipping">Ship to customer</option><option value="pickup">Customer pickup</option></select></label>
              <label className="text-sm">Carrier<input disabled={!canManage || method === "pickup"} className={`${input} mt-1 w-full`} value={carrier} onChange={e=>setCarrier(e.target.value)} placeholder="USPS, UPS, FedEx…" /></label>
              {method === "shipping" ? <><label className="text-sm sm:col-span-2">Recipient<input disabled={!canManage} className={`${input} mt-1 w-full`} value={address.name} onChange={e=>setAddress({...address,name:e.target.value})} /></label><label className="text-sm sm:col-span-2">Address<input disabled={!canManage} className={`${input} mt-1 w-full`} value={address.line1} onChange={e=>setAddress({...address,line1:e.target.value})} /></label><label className="text-sm">City<input disabled={!canManage} className={`${input} mt-1 w-full`} value={address.city} onChange={e=>setAddress({...address,city:e.target.value})} /></label><label className="text-sm">State / region<input disabled={!canManage} className={`${input} mt-1 w-full`} value={address.state} onChange={e=>setAddress({...address,state:e.target.value})} /></label><label className="text-sm">Postal code<input disabled={!canManage} className={`${input} mt-1 w-full`} value={address.postal_code} onChange={e=>setAddress({...address,postal_code:e.target.value})} /></label></> : null}
              <label className="text-sm">Tracking number<input disabled={!canManage || method === "pickup"} className={`${input} mt-1 w-full`} value={trackingNumber} onChange={e=>setTrackingNumber(e.target.value)} /></label>
              <label className="text-sm sm:col-span-2">Tracking link<input disabled={!canManage || method === "pickup"} type="url" className={`${input} mt-1 w-full`} value={trackingUrl} onChange={e=>setTrackingUrl(e.target.value)} placeholder="https://…" /></label>
            </div>
            {canManage ? <div className="mt-4 flex flex-wrap gap-2"><button onClick={()=>void save()} className="rounded-xl border border-brand-primary/80 bg-brand-primary/20 px-4 py-2 font-semibold text-brand-primary">Save fulfillment</button><button disabled={Boolean(order.shipped_at)} onClick={()=>void fulfillmentAction("mark_shipped")} className="rounded-xl border border-brand-accent/70 px-4 py-2 font-semibold text-brand-accent disabled:opacity-40">{order.shipped_at ? "Shipped" : method === "pickup" ? "Mark ready for pickup" : "Mark shipped + email"}</button><button disabled={!order.shipped_at || Boolean(order.delivered_at)} onClick={()=>void fulfillmentAction("mark_delivered")} className="rounded-xl border border-emerald-500/60 px-4 py-2 font-semibold text-emerald-300 disabled:opacity-40">{order.delivered_at ? "Completed" : "Mark delivered + email"}</button></div> : null}
          </div>
          {canManage ? (
            <button
              onClick={() => void save()}
              className="mt-3 rounded-xl border border-brand-primary/80 bg-brand-primary/20 px-4 py-2 font-semibold text-brand-primary transition hover:bg-brand-primary/30"
            >
              Save details
            </button>
          ) : null}
          <dl className="mt-5 grid gap-3 border-t border-zinc-800 pt-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-brand-textMuted">Quantity</dt>
              <dd>{order.quantity}</dd>
            </div>
            <RequestSpecifications
              specifications={order.specifications || {}}
            />
          </dl>
          <div className="mt-5 border-t border-zinc-800 pt-4 text-sm">
            <div className="text-brand-textMuted">Customer notes</div>
            <p className="mt-1 whitespace-pre-wrap">
              {order.customer_notes || "None"}
            </p>
          </div>
        </section>
        <section>
          <h2 className="font-semibold">Conversation</h2>
          <div className="mt-3 max-h-[480px] space-y-3 overflow-y-auto">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`rounded-xl border p-3 text-sm ${m.is_internal ? "border-sky-500/40 bg-sky-500/10" : "border-zinc-800 bg-black/30"}`}
              >
                <div className="text-[10px] text-brand-textMuted">
                  {m.is_internal
                    ? "INTERNAL NOTE"
                    : m.sender_id === order.customer_id
                      ? "CUSTOMER"
                      : "KEYMOURA"}{" "}
                  · {new Date(m.created_at).toLocaleString()}
                </div>
                <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
              </div>
            ))}
          </div>
          {canManage ? (
            <form onSubmit={send} className="mt-3">
              <textarea
                required
                className={`${input} min-h-24 w-full`}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Reply to customer or add an internal note…"
              />
              <label className="mt-2 flex items-center gap-2 text-xs text-brand-textMuted">
                <input
                  type="checkbox"
                  checked={internal}
                  onChange={(e) => setInternal(e.target.checked)}
                />{" "}
                Internal note (customer cannot see)
              </label>
              <button className="mt-3 rounded-xl border border-brand-primary/80 bg-brand-primary/20 px-4 py-2 font-semibold text-brand-primary transition hover:bg-brand-primary/30">
                Send
              </button>
            </form>
          ) : null}
        </section>
        <section className="md:col-span-2">
          <h2 className="font-semibold">Activity timeline</h2>
          <div className="mt-3 space-y-2 rounded-xl border border-zinc-800 p-4">
            {[...history.map(item=>({id:`h-${item.id}`,at:item.created_at,label:`Status changed to ${pretty(item.to_status)}`,detail:item.note})),...messages.map(item=>({id:`m-${item.id}`,at:item.created_at,label:item.is_internal?"Internal note added":item.sender_id===order.customer_id?"Customer message":"KeyMoura message",detail:item.body})),...(order.paid_at?[{id:"paid",at:order.paid_at,label:"Payment received",detail:`$${(order.amount_paid_cents/100).toFixed(2)}`}]:[]),...(order.shipped_at?[{id:"shipped",at:order.shipped_at,label:method==="pickup"?"Ready for pickup":"Order shipped",detail:trackingNumber || null}]:[]),...(order.delivered_at?[{id:"delivered",at:order.delivered_at,label:"Order delivered / completed",detail:null}]:[]),{id:"created",at:order.created_at,label:"Request submitted",detail:null}].sort((a,b)=>new Date(b.at).getTime()-new Date(a.at).getTime()).map(item=><div key={item.id} className="border-l-2 border-brand-accent/60 pl-4"><div className="text-sm font-medium">{item.label}</div><div className="text-[11px] text-brand-textMuted">{new Date(item.at).toLocaleString()}</div>{item.detail?<p className="mt-1 line-clamp-2 text-xs text-brand-textMuted">{item.detail}</p>:null}</div>)}
          </div>
        </section>
        <section className="md:col-span-2">
          <h2 className="font-semibold">Email history</h2>
          <div className="mt-3 overflow-hidden rounded-xl border border-zinc-800">
            {emails.map(email=><div key={email.id} className="grid gap-1 border-b border-zinc-800 bg-black/20 px-4 py-3 text-sm last:border-b-0 md:grid-cols-[1fr_1.4fr_auto]"><div><span className="text-brand-textMuted">To </span>{email.recipient}</div><div>{email.subject}</div><div className={email.status==="sent"?"text-emerald-300":email.status==="failed"?"text-rose-300":"text-amber-200"}>{pretty(email.status)} · {new Date(email.created_at).toLocaleString()}</div>{email.error_message?<div className="text-xs text-rose-200 md:col-span-3">{email.error_message}</div>:null}</div>)}
            {emails.length===0?<div className="px-4 py-6 text-center text-sm text-brand-textMuted">No email attempts for this order yet.</div>:null}
          </div>
        </section>
      </div>
      {error ? <p className="mt-4 text-rose-200">{error}</p> : null}
    </main>
  );
}
