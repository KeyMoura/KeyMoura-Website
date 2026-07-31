"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { RequestSpecifications } from "@/components/RequestSpecifications";

type Order = {
  id: string;
  order_number: string | null;
  product_name: string;
  status: string;
  quantity: number;
  specifications: Record<string, unknown>;
  customer_notes: string | null;
  agreed_price_cents: number | null;
  payment_status: string;
  amount_paid_cents: number;
  target_date: string | null;
  created_at: string;
  fulfillment_method: "shipping" | "pickup";
  shipping_address: Record<string,string> | null;
  shipping_carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
};
type Message = {
  id: number;
  sender_id: string;
  body: string;
  is_internal: boolean;
  created_at: string;
};
const pretty = (s: string) =>
  s.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [order, setOrder] = useState<Order | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [userId, setUserId] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const auth = await supabase.auth.getUser();
    setUserId(auth.data.user?.id ?? "");
    const [o, m] = await Promise.all([
      supabase.from("orders").select("*").eq("id", id).maybeSingle(),
      supabase
        .from("order_messages")
        .select("id,sender_id,body,is_internal,created_at")
        .eq("order_id", id)
        .order("created_at"),
    ]);
    setOrder(o.data as Order | null);
    setMessages((m.data ?? []) as Message[]);
    setError(o.error?.message ?? m.error?.message ?? "");
  }, [id, supabase]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!body.trim() || !userId) return;
    setBusy(true);
    const session = await supabase.auth.getSession();
    const response = await fetch(`/api/orders/${id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(session.data.session?.access_token
          ? { Authorization: `Bearer ${session.data.session.access_token}` }
          : {}),
      },
      body: JSON.stringify({ body: body.trim() }),
    });
    const result = await response.json();
    if (!response.ok) setError(result.error || "Could not send message");
    else {
      setBody("");
      await load();
    }
    setBusy(false);
  }
  async function checkout() {
    setBusy(true);
    setError("");
    const { data } = await supabase.auth.getSession();
    const response = await fetch(`/api/orders/${id}/checkout`, {
      method: "POST",
      headers: data.session?.access_token
        ? { Authorization: `Bearer ${data.session.access_token}` }
        : {},
    });
    const result = await response.json();
    if (!response.ok || !result.url) {
      setError(result.error || "Could not start checkout.");
      setBusy(false);
      return;
    }
    window.location.assign(result.url);
  }
  if (!order)
    return (
      <main className="mx-auto max-w-4xl px-4 py-10 text-brand-textMuted">
        {error || "Loading order…"}
      </main>
    );
  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[.2em] text-brand-primary">
            {order.order_number || "Request pending"}
          </p>
          <h1 className="mt-2 text-3xl font-semibold">{order.product_name}</h1>
        </div>
        <span className="rounded-full border border-brand-primary/60 bg-brand-primary/10 px-4 py-2 text-sm text-brand-primary">
          {pretty(order.status)}
        </span>
      </div>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-zinc-800 p-4">
          <div className="text-xs text-brand-textMuted">Price</div>
          <div className="mt-1 font-medium">
            {order.agreed_price_cents == null
              ? "Pending"
              : `$${(order.agreed_price_cents / 100).toFixed(2)}`}
          </div>
        </div>
        <div className="rounded-xl border border-zinc-800 p-4">
          <div className="text-xs text-brand-textMuted">Payment</div>
          <div className="mt-1 font-medium">{pretty(order.payment_status)}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 p-4">
          <div className="text-xs text-brand-textMuted">Target</div>
          <div className="mt-1 font-medium">
            {order.target_date || "Not set"}
          </div>
        </div>
      </div>
      {order.agreed_price_cents &&
      order.payment_status !== "paid" &&
      ["accepted", "awaiting_payment"].includes(order.status) ? (
        <div className="mt-4 rounded-2xl border border-brand-primary/50 bg-brand-primary/10 p-5">
          <h2 className="font-semibold">Ready for payment</h2>
          <p className="mt-1 text-sm text-brand-textMuted">
            Pay securely through Stripe. KeyMoura never receives or stores your
            card number.
          </p>
          <button
            disabled={busy}
            onClick={() => void checkout()}
            className="mt-4 rounded-xl border border-brand-primary/80 bg-brand-primary/20 px-5 py-2.5 font-semibold text-brand-primary transition hover:bg-brand-primary/30 disabled:opacity-50"
          >
            {busy
              ? "Opening checkout…"
              : `Pay $${(order.agreed_price_cents / 100).toFixed(2)}`}
          </button>
        </div>
      ) : null}
      <section className="mt-6 rounded-2xl border border-zinc-800 bg-black/30 p-5">
        <h2 className="font-semibold">Request details</h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-brand-textMuted">Quantity</dt>
            <dd>{order.quantity}</dd>
          </div>
          <RequestSpecifications specifications={order.specifications || {}} />
        </dl>
        {order.customer_notes ? (
          <p className="mt-4 whitespace-pre-wrap border-t border-zinc-800 pt-4 text-sm">
            {order.customer_notes}
          </p>
        ) : null}
      </section>
      {(order.fulfillment_method === "pickup" || order.tracking_number || order.shipped_at) ? <section className="mt-6 rounded-2xl border border-zinc-800 bg-black/30 p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold">Fulfillment</h2><p className="mt-1 text-sm text-brand-textMuted">{order.delivered_at ? order.fulfillment_method === "pickup" ? "Pickup complete" : "Delivered" : order.shipped_at ? order.fulfillment_method === "pickup" ? "Ready for pickup" : "Shipped" : order.fulfillment_method === "pickup" ? "Customer pickup" : "Shipping details"}</p></div>{order.tracking_url ? <a className="ui-btn ui-btn-primary" href={order.tracking_url} target="_blank" rel="noreferrer">Track shipment</a> : null}</div>{order.tracking_number ? <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-brand-textMuted">Carrier</dt><dd>{order.shipping_carrier || "Carrier"}</dd></div><div><dt className="text-brand-textMuted">Tracking number</dt><dd className="break-all">{order.tracking_number}</dd></div></dl> : null}</section> : null}
      <section className="mt-6">
        <h2 className="text-xl font-semibold">Order chat</h2>
        <div className="mt-3 space-y-3">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`max-w-[85%] rounded-2xl border p-3 text-sm ${m.sender_id === userId ? "ml-auto border-brand-primary/40 bg-brand-primary/10" : "border-zinc-800 bg-black/30"}`}
            >
              <p className="whitespace-pre-wrap">{m.body}</p>
              <p className="mt-2 text-[10px] text-brand-textMuted">
                {new Date(m.created_at).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
        <form onSubmit={send} className="mt-4 flex gap-2">
          <textarea
            required
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Ask a question or send an update…"
            className="min-h-20 flex-1 rounded-xl border border-zinc-700 bg-black/40 p-3 outline-none focus:border-brand-primary"
          />
          <button
            disabled={busy}
            className="rounded-xl border border-brand-primary/80 bg-brand-primary/20 px-5 font-semibold text-brand-primary transition hover:bg-brand-primary/30 disabled:opacity-50"
          >
            Send
          </button>
        </form>
        {error ? <p className="mt-2 text-sm text-rose-200">{error}</p> : null}
      </section>
    </main>
  );
}
