"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";

type Order = { id: string; order_number: string | null; product_name: string; status: string; agreed_price_cents: number | null; payment_status: string; updated_at: string; };
const label = (s: string) => s.replaceAll("_", " ").replace(/\b\w/g, c => c.toUpperCase());

export default function OrdersPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    void supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) { setError("Sign in to view your requests."); setLoading(false); return; }
      const result = await supabase.from("orders").select("id,order_number,product_name,status,agreed_price_cents,payment_status,updated_at").eq("customer_id", data.user.id).order("updated_at", { ascending: false });
      setOrders((result.data ?? []) as Order[]); setError(result.error?.message ?? ""); setLoading(false);
    });
  }, [supabase]);
  return <main className="mx-auto max-w-5xl px-4 py-10">
    <div className="flex items-end justify-between gap-4"><div><p className="text-xs uppercase tracking-[.2em] text-brand-primary">Your KeyMoura work</p><h1 className="mt-2 text-4xl font-semibold">Requests & orders</h1></div><Link href="/catalog" className="rounded-full border border-brand-primary/70 px-4 py-2 text-sm text-brand-primary">Browse catalog</Link></div>
    {loading ? <p className="mt-8 text-brand-textMuted">Loading…</p> : null}{error ? <p className="mt-8 text-rose-200">{error}</p> : null}
    <div className="mt-8 space-y-3">{orders.map(o => <Link key={o.id} href={`/orders/${o.id}`} className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-zinc-800 bg-black/30 p-5 hover:border-brand-primary/60">
      <div><div className="font-semibold">{o.product_name}</div><div className="mt-1 text-xs text-brand-textMuted">{o.order_number || "Request pending review"} · Updated {new Date(o.updated_at).toLocaleDateString()}</div></div>
      <div className="text-right"><div className="text-sm text-brand-primary">{label(o.status)}</div><div className="mt-1 text-xs text-brand-textMuted">{o.agreed_price_cents == null ? "Price pending" : `$${(o.agreed_price_cents / 100).toFixed(2)} · ${label(o.payment_status)}`}</div></div>
    </Link>)}</div>
    {!loading && !error && orders.length === 0 ? <div className="mt-8 rounded-2xl border border-zinc-800 p-8 text-center text-brand-textMuted">You haven’t requested anything yet.</div> : null}
  </main>;
}
