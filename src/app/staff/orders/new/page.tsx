"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";

type Customer = { id:string; username:string|null; display_name:string|null };
type Product = { id:string; name:string; starting_price_cents:number|null; is_published:boolean; availability_status:string; inventory_policy:"unlimited"|"track"; inventory_quantity:number; continue_selling_when_out_of_stock:boolean };
const dollarsToCents = (value:string) => Math.round(Number(value) * 100);

export default function NewStaffOrderProposalPage() {
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { data:access, isLoading } = useMeAccess();
  const canManage = new Set(access?.permissions ?? []).has("orders.manage");
  const [customers,setCustomers] = useState<Customer[]>([]);
  const [products,setProducts] = useState<Product[]>([]);
  const [customerId,setCustomerId] = useState("");
  const [productId,setProductId] = useState("");
  const [productName,setProductName] = useState("");
  const [quantity,setQuantity] = useState("1");
  const [price,setPrice] = useState("");
  const [priceIsSuggested,setPriceIsSuggested] = useState(true);
  const [deposit,setDeposit] = useState("");
  const [notes,setNotes] = useState("");
  const [targetDate,setTargetDate] = useState("");
  const [fulfillment,setFulfillment] = useState<"shipping"|"pickup">("shipping");
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");

  useEffect(()=>{ if (!canManage) return; void (async()=>{
    const { data } = await supabase.auth.getSession();
    const response = await fetch("/api/staff/orders/proposals", { headers:data.session?.access_token ? { Authorization:`Bearer ${data.session.access_token}` } : {} });
    const result = await response.json();
    if (!response.ok) setError(result.error || "Could not load customers and products.");
    else { setCustomers(result.customers || []); setProducts(result.products || []); }
  })(); },[canManage,supabase]);

  function chooseProduct(id:string) {
    setProductId(id);
    const product = products.find(item=>item.id===id);
    setPriceIsSuggested(true);
    if (product) {
      setProductName(product.name);
      if (product.starting_price_cents != null) setPrice(((product.starting_price_cents * Math.max(1, Number(quantity) || 1))/100).toFixed(2));
    }
  }

  function changeQuantity(value:string) {
    setQuantity(value);
    const product = products.find(item=>item.id===productId);
    const count = Number(value);
    if (priceIsSuggested && product?.starting_price_cents != null && Number.isInteger(count) && count > 0) setPrice(((product.starting_price_cents * count)/100).toFixed(2));
  }

  async function submit(event:FormEvent) {
    event.preventDefault();
    if (!window.confirm("Send this proposal to the selected customer? They can accept, decline, or message you.")) return;
    setBusy(true); setError("");
    const { data } = await supabase.auth.getSession();
    const response = await fetch("/api/staff/orders/proposals", { method:"POST", headers:{ "Content-Type":"application/json", ...(data.session?.access_token ? { Authorization:`Bearer ${data.session.access_token}` } : {}) }, body:JSON.stringify({ customer_id:customerId, product_id:productId || null, product_name:productName, quantity:Number(quantity), agreed_price_cents:dollarsToCents(price), deposit_amount_cents:deposit ? dollarsToCents(deposit) : null, customer_notes:notes, target_date:targetDate || null, fulfillment_method:fulfillment }) });
    const result = await response.json();
    if (!response.ok) setError(result.error || "Could not send proposal."); else router.push(`/staff/orders/${result.id}`);
    setBusy(false);
  }

  if (isLoading) return <div className="ui-card">Loading…</div>;
  if (!canManage) return <AccessDeniedCard message="You do not have permission to create orders." />;
  const customer = customers.find(item=>item.id===customerId);
  const selectedProduct = products.find(item=>item.id===productId);
  const stockConflict = !!selectedProduct && selectedProduct.inventory_policy === "track" && selectedProduct.inventory_quantity < Number(quantity) && !selectedProduct.continue_selling_when_out_of_stock;
  return <main className="mx-auto max-w-4xl">
    <Link href="/staff/orders" className="text-sm text-brand-textMuted hover:text-brand-accent">← Back to orders</Link>
    <div className="mt-5"><p className="text-xs uppercase tracking-[.2em] text-brand-accent">Staff proposal</p><h1 className="mt-1 text-3xl font-semibold">Create an order for a customer</h1><p className="mt-2 text-sm text-brand-textMuted">Build the proposal, review it, then send it. Nothing enters production until the customer accepts.</p></div>
    {error ? <p className="mt-5 rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-rose-200">{error}</p> : null}
    <form onSubmit={submit} className="mt-6 grid gap-5 lg:grid-cols-[1fr_.8fr]">
      <div className="space-y-5">
        <section className="ui-card space-y-4"><div><p className="text-xs font-semibold uppercase tracking-[.15em] text-brand-accent">1 · Customer & item</p><h2 className="mt-1 text-xl font-semibold">What are you offering?</h2></div>
          <label className="block text-sm">Customer<select required value={customerId} onChange={e=>setCustomerId(e.target.value)} className="ui-input mt-2 w-full"><option value="">Choose a customer…</option>{customers.map(item=><option key={item.id} value={item.id}>{item.display_name || item.username || item.id}{item.username ? ` (@${item.username})` : ""}</option>)}</select></label>
          <label className="block text-sm">Catalog item (optional)<select value={productId} onChange={e=>chooseProduct(e.target.value)} className="ui-input mt-2 w-full"><option value="">Custom line item</option>{products.map(item=><option key={item.id} value={item.id} disabled={item.availability_status === "unavailable"}>{item.name}{item.is_published ? "" : " (draft)"}{item.availability_status === "unavailable" ? " (unavailable)" : item.inventory_policy === "track" ? ` (${item.inventory_quantity} in stock)` : ""}</option>)}</select>{selectedProduct?.inventory_policy === "track" ? <span className={`mt-2 block text-xs ${selectedProduct.inventory_quantity < Number(quantity) && !selectedProduct.continue_selling_when_out_of_stock ? "text-rose-300" : "text-brand-textMuted"}`}>{selectedProduct.inventory_quantity} currently in stock. Stock is reserved only when the customer accepts.</span> : null}</label>
          <label className="block text-sm">Item name<input required minLength={2} maxLength={120} value={productName} onChange={e=>setProductName(e.target.value)} className="ui-input mt-2 w-full" placeholder="Custom engraved sign" /></label>
          <label className="block text-sm">Customer-facing details<textarea value={notes} onChange={e=>setNotes(e.target.value)} maxLength={5000} className="ui-input mt-2 min-h-28 w-full" placeholder="Describe materials, dimensions, included work, and anything the customer should know." /></label>
        </section>
        <section className="ui-card space-y-4"><div><p className="text-xs font-semibold uppercase tracking-[.15em] text-brand-accent">2 · Price & delivery</p><h2 className="mt-1 text-xl font-semibold">Set the terms</h2></div>
          <div className="grid gap-4 sm:grid-cols-3"><label className="text-sm">Quantity<input required type="number" min="1" max="1000" value={quantity} onChange={e=>changeQuantity(e.target.value)} className="ui-input mt-2 w-full" /></label><label className="text-sm">Total customer price<input required type="number" min="0.50" step="0.01" value={price} onChange={e=>{setPrice(e.target.value);setPriceIsSuggested(false);}} className="ui-input mt-2 w-full" placeholder="125.00" />{selectedProduct?.starting_price_cents != null ? <span className="mt-1 block text-xs text-brand-textMuted">Starts at ${(selectedProduct.starting_price_cents/100).toFixed(2)} each.</span> : null}</label><label className="text-sm">Deposit (optional)<input type="number" min="0.50" step="0.01" value={deposit} onChange={e=>setDeposit(e.target.value)} className="ui-input mt-2 w-full" placeholder="50.00" /></label></div>
          <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm">Delivery<select value={fulfillment} onChange={e=>setFulfillment(e.target.value as "shipping"|"pickup")} className="ui-input mt-2 w-full"><option value="shipping">Shipping</option><option value="pickup">Pickup</option></select></label><label className="text-sm">Target date (optional)<input type="date" value={targetDate} onChange={e=>setTargetDate(e.target.value)} className="ui-input mt-2 w-full" /></label></div>
        </section>
      </div>
      <aside className="ui-card h-fit lg:sticky lg:top-24"><p className="text-xs font-semibold uppercase tracking-[.15em] text-brand-accent">3 · Review</p><h2 className="mt-1 text-xl font-semibold">Customer preview</h2><dl className="mt-5 space-y-4 text-sm"><div><dt className="text-brand-textMuted">Customer</dt><dd className="mt-1 font-medium">{customer?.display_name || customer?.username || "Not selected"}</dd></div><div><dt className="text-brand-textMuted">Item</dt><dd className="mt-1 font-medium">{productName || "Not entered"} × {quantity || "1"}</dd></div><div><dt className="text-brand-textMuted">Total</dt><dd className="mt-1 text-xl font-semibold text-brand-accent">{price && Number.isFinite(Number(price)) ? `$${Number(price).toFixed(2)}` : "Not set"}</dd>{deposit ? <dd className="mt-1 text-brand-textMuted">${Number(deposit).toFixed(2)} deposit</dd> : null}</div><div><dt className="text-brand-textMuted">Delivery</dt><dd className="mt-1 font-medium">{fulfillment === "pickup" ? "Pickup" : "Shipping"}</dd></div>{notes ? <div><dt className="text-brand-textMuted">Details</dt><dd className="mt-1 whitespace-pre-wrap">{notes}</dd></div> : null}</dl>{stockConflict ? <p className="mt-5 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">Only {selectedProduct?.inventory_quantity} in stock. Lower the quantity before sending.</p> : <p className="mt-5 text-xs text-brand-textMuted">The customer will receive an in-site notification and can message you before deciding.</p>}<button disabled={busy || stockConflict} className="catalog-action-primary mt-5 w-full rounded-xl px-5 py-3 font-semibold disabled:cursor-not-allowed disabled:opacity-50">{busy ? "Sending…" : "Send proposal"}</button></aside>
    </form>
  </main>;
}
