"use client";

import Link from "next/link";
import { useEffect,useMemo,useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";

type Order={id:string;order_number:string|null;customer_id:string;product_name:string;status:string;agreed_price_cents:number|null;payment_status:string;created_at:string;updated_at:string};
const pretty=(s:string)=>s.replaceAll("_"," ").replace(/\b\w/g,c=>c.toUpperCase());
export default function StaffOrdersPage(){
 const supabase=useMemo(()=>supabaseBrowser(),[]);const {data:access,isLoading}=useMeAccess();const perms=new Set(access?.permissions??[]);const canView=perms.has("orders.view")||perms.has("orders.manage");
 const [orders,setOrders]=useState<Order[]>([]);const [filter,setFilter]=useState("active");const [error,setError]=useState("");
 useEffect(()=>{if(!canView)return;void supabase.from("orders").select("id,order_number,customer_id,product_name,status,agreed_price_cents,payment_status,created_at,updated_at").order("updated_at",{ascending:false}).then(r=>{setOrders((r.data??[])as Order[]);setError(r.error?.message??"")})},[canView,supabase]);
 if(isLoading)return <div className="ui-card">Loading…</div>;if(!canView)return <AccessDeniedCard message="You do not have access to orders."/>;
 const shown=orders.filter(o=>filter==="all"||filter==="requested"?o.status===filter:filter==="active"?!["requested","declined","completed","cancelled"].includes(o.status):["completed","declined","cancelled"].includes(o.status));
 return <main><p className="text-xs uppercase tracking-[.2em] text-brand-primary">Commerce</p><h1 className="mt-1 text-3xl font-semibold">Requests & orders</h1><div className="mt-5 flex flex-wrap gap-2">{["requested","active","closed","all"].map(x=><button key={x} onClick={()=>setFilter(x)} className={`rounded-full border px-4 py-2 text-sm ${filter===x?"border-brand-primary text-brand-primary":"border-zinc-700 text-brand-textMuted"}`}>{pretty(x)}</button>)}</div>{error?<p className="mt-4 text-rose-200">{error}</p>:null}<div className="mt-5 space-y-3">{shown.map(o=><Link href={`/staff/orders/${o.id}`} key={o.id} className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-zinc-800 bg-black/30 p-5 hover:border-brand-primary/60"><div><div className="font-semibold">{o.product_name}</div><div className="mt-1 text-xs text-brand-textMuted">{o.order_number||"New request"} · {new Date(o.created_at).toLocaleDateString()}</div></div><div className="text-right"><div className="text-sm text-brand-primary">{pretty(o.status)}</div><div className="text-xs text-brand-textMuted">{o.agreed_price_cents==null?"Price pending":`$${(o.agreed_price_cents/100).toFixed(2)}`} · {pretty(o.payment_status)}</div></div></Link>)}</div>{shown.length===0?<p className="mt-8 text-center text-brand-textMuted">Nothing in this view.</p>:null}</main>
}
