"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";

type Product={id:string;name:string;slug:string;short_description:string|null;category:string|null;starting_price_cents:number|null;is_published:boolean;sort_order:number};
const slugify=(s:string)=>s.toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");

export default function StaffCatalogPage(){
 const supabase=useMemo(()=>supabaseBrowser(),[]);const {data:access,isLoading}=useMeAccess();const perms=new Set(access?.permissions??[]);
 const canView=perms.has("catalog.view")||perms.has("catalog.manage");const canManage=perms.has("catalog.manage");
 const [products,setProducts]=useState<Product[]>([]);const [name,setName]=useState("");const [category,setCategory]=useState("");const [description,setDescription]=useState("");const [price,setPrice]=useState("");const [error,setError]=useState("");
 const load=useCallback(async()=>{const r=await supabase.from("products").select("id,name,slug,short_description,category,starting_price_cents,is_published,sort_order").order("sort_order").order("created_at",{ascending:false});setProducts((r.data??[])as Product[]);setError(r.error?.message??"")},[supabase]);
 useEffect(()=>{if(!canView)return;const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer)},[canView,load]);
 async function create(e:FormEvent){e.preventDefault();const cents=price.trim()?Math.round(Number(price)*100):null;const r=await supabase.from("products").insert({name:name.trim(),slug:slugify(name),category:category.trim()||null,short_description:description.trim()||null,description:description.trim()||null,starting_price_cents:cents,is_published:false}).select();if(r.error)setError(r.error.message);else{setName("");setCategory("");setDescription("");setPrice("");await load()}}
 async function toggle(p:Product){const r=await supabase.from("products").update({is_published:!p.is_published}).eq("id",p.id);if(r.error)setError(r.error.message);else await load()}
 async function remove(p:Product){if(!confirm(`Archive ${p.name}?`))return;const r=await supabase.from("products").delete().eq("id",p.id);if(r.error)setError(r.error.message);else await load()}
 if(isLoading)return <div className="ui-card">Loading…</div>;if(!canView)return <AccessDeniedCard message="You do not have access to catalog management."/>;
 const input="rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 outline-none focus:border-brand-primary";
 return <main><div><p className="text-xs uppercase tracking-[.2em] text-brand-primary">Commerce</p><h1 className="mt-1 text-3xl font-semibold">Product catalog</h1><p className="mt-2 text-sm text-brand-textMuted">Create products as drafts, then publish them when they are ready for requests.</p></div>
 {canManage?<form onSubmit={create} className="mt-6 grid gap-3 rounded-2xl border border-zinc-800 bg-black/30 p-5 sm:grid-cols-2"><input required className={input} value={name} onChange={e=>setName(e.target.value)} placeholder="Product name"/><input className={input} value={category} onChange={e=>setCategory(e.target.value)} placeholder="Category"/><input className={input} type="number" min="0" step=".01" value={price} onChange={e=>setPrice(e.target.value)} placeholder="Starting price (optional)"/><input className={input} value={description} onChange={e=>setDescription(e.target.value)} placeholder="Short description"/><button className="rounded-xl bg-brand-primary px-4 py-2 font-semibold text-black sm:col-span-2">Create draft product</button></form>:null}
 {error?<p className="mt-4 text-sm text-rose-200">{error}</p>:null}<div className="mt-6 space-y-3">{products.map(p=><div key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-black/30 p-4"><div><div className="font-semibold">{p.name}</div><div className="text-xs text-brand-textMuted">/{p.slug} · {p.category||"Uncategorized"} · {p.starting_price_cents==null?"No starting price":`$${(p.starting_price_cents/100).toFixed(2)}`}</div></div><div className="flex gap-2"><span className={`rounded-full border px-3 py-1 text-xs ${p.is_published?"border-emerald-500/50 text-emerald-200":"border-zinc-700 text-brand-textMuted"}`}>{p.is_published?"Published":"Draft"}</span>{canManage?<><button onClick={()=>void toggle(p)} className="rounded-full border border-zinc-700 px-3 py-1 text-xs hover:border-brand-primary">{p.is_published?"Unpublish":"Publish"}</button><button onClick={()=>void remove(p)} className="rounded-full border border-zinc-700 px-3 py-1 text-xs hover:border-rose-500">Delete</button></>:null}</div></div>)}</div></main>
}
