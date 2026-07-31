"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { RequestSpecifications } from "@/components/RequestSpecifications";

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
};
type Message = {
  id: number;
  sender_id: string;
  body: string;
  is_internal: boolean;
  created_at: string;
};
type EmailDelivery = { id:string; recipient:string; subject:string; status:"sent"|"failed"|"skipped"; error_message:string|null; created_at:string };
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
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [price, setPrice] = useState("");
  const [paid, setPaid] = useState("");
  const [target, setTarget] = useState("");
  const [staffNotes, setStaffNotes] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const [o, m, e] = await Promise.all([
      supabase.from("orders").select("*").eq("id", id).maybeSingle(),
      supabase
        .from("order_messages")
        .select("*")
        .eq("order_id", id)
        .order("created_at"),
      supabase.from("email_deliveries").select("id,recipient,subject,status,error_message,created_at").eq("order_id",id).order("created_at",{ascending:false}),
    ]);
    const row = o.data as Order | null;
    setOrder(row);
    setMessages((m.data ?? []) as Message[]);
    setEmails((e.data ?? []) as EmailDelivery[]);
    if (row) {
      setPrice(
        row.agreed_price_cents == null
          ? ""
          : String(row.agreed_price_cents / 100),
      );
      setPaid(String(row.amount_paid_cents / 100));
      setTarget(row.target_date ?? "");
      setStaffNotes(row.staff_notes ?? "");
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
      }),
    });
    const result = await r.json();
    if (!r.ok) setError(result.error || "Could not save details");
    else await load();
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
