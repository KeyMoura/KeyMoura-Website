"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";

type Order = { id:string; order_number:string|null; product_name:string; status:string; quantity:number; specifications:Record<string,string|null>; customer_notes:string|null; agreed_price_cents:number|null; payment_status:string; amount_paid_cents:number; target_date:string|null; created_at:string; };
type Message = { id:number; sender_id:string; body:string; is_internal:boolean; created_at:string; };
const pretty = (s:string) => s.replaceAll("_"," ").replace(/\b\w/g,c=>c.toUpperCase());

export default function OrderDetailPage() {
  const { id } = useParams<{id:string}>(); const supabase = useMemo(()=>supabaseBrowser(),[]);
  const [order,setOrder]=useState<Order|null>(null); const [messages,setMessages]=useState<Message[]>([]); const [userId,setUserId]=useState("");
  const [body,setBody]=useState(""); const [error,setError]=useState(""); const [busy,setBusy]=useState(false);
  const load=useCallback(async()=>{ const auth=await supabase.auth.getUser(); setUserId(auth.data.user?.id??""); const [o,m]=await Promise.all([supabase.from("orders").select("*").eq("id",id).maybeSingle(),supabase.from("order_messages").select("id,sender_id,body,is_internal,created_at").eq("order_id",id).order("created_at")]); setOrder(o.data as Order|null); setMessages((m.data??[]) as Message[]); setError(o.error?.message??m.error?.message??""); },[id,supabase]);
  useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer)},[load]);
  async function send(e:FormEvent){e.preventDefault();if(!body.trim()||!userId)return;setBusy(true);const {error}=await supabase.from("order_messages").insert({order_id:id,sender_id:userId,body:body.trim()});if(error)setError(error.message);else{setBody("");await load()}setBusy(false)}
  if(!order)return <main className="mx-auto max-w-4xl px-4 py-10 text-brand-textMuted">{error||"Loading order…"}</main>;
  return <main className="mx-auto max-w-4xl px-4 py-10">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs uppercase tracking-[.2em] text-brand-primary">{order.order_number||"Request pending"}</p><h1 className="mt-2 text-3xl font-semibold">{order.product_name}</h1></div><span className="rounded-full border border-brand-primary/60 bg-brand-primary/10 px-4 py-2 text-sm text-brand-primary">{pretty(order.status)}</span></div>
    <div className="mt-6 grid gap-4 sm:grid-cols-3"><div className="rounded-xl border border-zinc-800 p-4"><div className="text-xs text-brand-textMuted">Price</div><div className="mt-1 font-medium">{order.agreed_price_cents==null?"Pending":`$${(order.agreed_price_cents/100).toFixed(2)}`}</div></div><div className="rounded-xl border border-zinc-800 p-4"><div className="text-xs text-brand-textMuted">Payment</div><div className="mt-1 font-medium">{pretty(order.payment_status)}</div></div><div className="rounded-xl border border-zinc-800 p-4"><div className="text-xs text-brand-textMuted">Target</div><div className="mt-1 font-medium">{order.target_date||"Not set"}</div></div></div>
    <section className="mt-6 rounded-2xl border border-zinc-800 bg-black/30 p-5"><h2 className="font-semibold">Request details</h2><dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-brand-textMuted">Quantity</dt><dd>{order.quantity}</dd></div>{Object.entries(order.specifications||{}).filter(([,v])=>v).map(([k,v])=><div key={k}><dt className="capitalize text-brand-textMuted">{k}</dt><dd>{v}</dd></div>)}</dl>{order.customer_notes?<p className="mt-4 whitespace-pre-wrap border-t border-zinc-800 pt-4 text-sm">{order.customer_notes}</p>:null}</section>
    <section className="mt-6"><h2 className="text-xl font-semibold">Order chat</h2><div className="mt-3 space-y-3">{messages.map(m=><div key={m.id} className={`max-w-[85%] rounded-2xl border p-3 text-sm ${m.sender_id===userId?"ml-auto border-brand-primary/40 bg-brand-primary/10":"border-zinc-800 bg-black/30"}`}><p className="whitespace-pre-wrap">{m.body}</p><p className="mt-2 text-[10px] text-brand-textMuted">{new Date(m.created_at).toLocaleString()}</p></div>)}</div>
      <form onSubmit={send} className="mt-4 flex gap-2"><textarea required value={body} onChange={e=>setBody(e.target.value)} placeholder="Ask a question or send an update…" className="min-h-20 flex-1 rounded-xl border border-zinc-700 bg-black/40 p-3 outline-none focus:border-brand-primary"/><button disabled={busy} className="rounded-xl border border-brand-primary/80 bg-brand-primary/20 px-5 font-semibold text-brand-primary transition hover:bg-brand-primary/30 disabled:opacity-50">Send</button></form>{error?<p className="mt-2 text-sm text-rose-200">{error}</p>:null}
    </section>
  </main>
}
