"use client";

import Image from "next/image";
import { useParams, useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { ProductModelViewer } from "@/components/ProductModelViewer";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { availabilityLabel, CatalogProduct, inventoryLabel, money, productCanBeRequested, ProductMedia, ProductOptionGroup } from "@/lib/commerceTypes";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { emptyShippingAddress, type FulfillmentMethod, type ShippingAddress, validateUpload } from "@/lib/checkout";

type Selection = string | number | boolean | null;

export default function ProductRequestPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [product, setProduct] = useState<CatalogProduct | null>(null);
  const [media, setMedia] = useState<ProductMedia[]>([]);
  const [groups, setGroups] = useState<ProductOptionGroup[]>([]);
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [activeImage, setActiveImage] = useState<string | null>(null);
  const [showModel, setShowModel] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [targetDate, setTargetDate] = useState("");
  const [budget, setBudget] = useState("");
  const [notes, setNotes] = useState("");
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [fulfillmentMethod, setFulfillmentMethod] = useState<FulfillmentMethod>("shipping");
  const [shippingAddress, setShippingAddress] = useState<ShippingAddress>(emptyShippingAddress);
  const [checkoutToken] = useState(() => crypto.randomUUID());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const { data, error: productError } = await supabase.from("products").select("*").eq("slug", slug).eq("is_published", true).maybeSingle();
      if (productError || !data) { setError(productError?.message || "Product not found."); return; }
      const item = data as CatalogProduct;
      setProduct(item);
      const [mediaResult, groupResult] = await Promise.all([
        supabase.from("product_media").select("*").eq("product_id", item.id).order("sort_order"),
        item.is_custom ? supabase.from("product_option_groups").select("*,product_option_values(*)").eq("product_id", item.id).order("sort_order") : Promise.resolve({ data: [], error: null }),
      ]);
      const assets = (mediaResult.data ?? []) as ProductMedia[];
      const options = ((groupResult.data ?? []) as ProductOptionGroup[]).map(group => ({
        ...group, product_option_values: [...(group.product_option_values ?? [])].filter(value => value.is_active).sort((a, b) => a.sort_order - b.sort_order),
      }));
      setMedia(assets);
      setActiveImage(assets.find(asset => asset.kind === "image")?.url ?? item.image_url);
      setGroups(options);
      const defaults: Record<string, Selection> = {};
      for (const group of options) {
        const choice = group.product_option_values?.find(value => value.is_default) ?? group.product_option_values?.[0];
        defaults[group.option_key] = group.input_type === "checkbox" ? false : choice?.value ?? "";
      }
      setSelections(defaults);
      setError(mediaResult.error?.message ?? groupResult.error?.message ?? "");
    })();
  }, [slug, supabase]);

  const choicePrice = useMemo(() => groups.reduce((total, group) => {
    const chosen = group.product_option_values?.find(value => value.value === selections[group.option_key]);
    return total + (chosen?.price_adjustment_cents ?? 0);
  }, 0), [groups, selections]);
  const estimated = product?.starting_price_cents == null ? null : (product.starting_price_cents + choicePrice) * quantity;

  function validateStep(target: 1 | 2) {
    if (target === 1) {
      for (const group of groups) {
        const value = group.input_type === "file" ? files[group.option_key] : selections[group.option_key];
        if (group.is_required && (value === null || value === undefined || value === "" || value === false)) return `${group.name} is required.`;
        if (group.input_type === "file" && value instanceof File) { const message = validateUpload(value); if (message) return `${group.name}: ${message}`; }
      }
    }
    if (target === 2 && fulfillmentMethod === "shipping") {
      if (!shippingAddress.name.trim() || !shippingAddress.line1.trim() || !shippingAddress.city.trim() || !shippingAddress.state.trim() || !shippingAddress.postal_code.trim()) return "Enter a complete shipping address.";
    }
    return "";
  }

  function advance(target: 2 | 3) {
    const message = validateStep(target === 2 ? 1 : 2);
    if (message) { setError(message); return; }
    setError(""); setStep(target); window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) { router.push(`/auth/login?next=${encodeURIComponent(`/catalog/${slug}`)}`); return; }
    if (!product) { setBusy(false); return; }

    const requestToken = crypto.randomUUID();
    const uploadedPaths: string[] = [];
    const cleanupUploads = async () => { if (uploadedPaths.length) await supabase.storage.from("order-assets").remove(uploadedPaths); };
    const snapshot: Record<string, unknown> = {};
    for (const group of groups) {
      const selected = selections[group.option_key];
      const choice = group.product_option_values?.find(value => value.value === selected);
      snapshot[group.option_key] = {
        label: group.name, value: selected, display_value: choice?.label ?? selected,
        price_adjustment_cents: choice?.price_adjustment_cents ?? 0,
      };
      const file = files[group.option_key];
      if (group.input_type === "file" && file) {
        const fileError = validateUpload(file);
        if (fileError) { await cleanupUploads(); setBusy(false); return setError(`${group.name}: ${fileError}`); }
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${auth.user.id}/${requestToken}/${group.option_key}-${safeName}`;
        const { error: uploadError } = await supabase.storage.from("order-assets").upload(path, file, { upsert: false, contentType: file.type || undefined });
        if (uploadError) { await cleanupUploads(); setBusy(false); return setError(`Could not upload ${group.name}: ${uploadError.message}`); }
        uploadedPaths.push(path);
        snapshot[group.option_key] = { label: group.name, value: path, display_value: file.name, kind: "file" };
      }
    }
    snapshot.budget = budget.trim() || null;
    snapshot.estimated_total_cents = estimated;

    const { data: sessionData } = await supabase.auth.getSession();
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(sessionData.session?.access_token ? { Authorization: `Bearer ${sessionData.session.access_token}` } : {}),
      },
      body: JSON.stringify({
        product_id: product.id, quantity, specifications: snapshot, checkout_token: checkoutToken,
        customer_notes: notes.trim() || null, target_date: targetDate || null,
        fulfillment_method: fulfillmentMethod,
        shipping_address: fulfillmentMethod === "shipping" ? shippingAddress : null,
      }),
    });
    const data = await response.json() as { id?: string; error?: string };
    if (!response.ok || !data.id) { await cleanupUploads(); setError(data.error || "Could not create order request"); setBusy(false); return; }
    router.push(`/orders/${data.id}/confirmed`);
  }

  if (!product && !error) return <main className="mx-auto max-w-6xl px-4 py-10 text-brand-textMuted">Loading…</main>;
  if (!product) return <main className="mx-auto max-w-6xl px-4 py-10 text-rose-200">{error}</main>;
  const input = "w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2.5 outline-none focus:border-brand-primary";
  const images = media.filter(asset => asset.kind === "image");
  const galleryImages = images.length ? images : product.image_url ? [{ id: "primary", url: product.image_url, alt_text: product.name }] : [];
  const activeIndex = galleryImages.findIndex(asset => asset.url === activeImage);
  const moveImage = (direction: -1 | 1) => {
    if (galleryImages.length < 2) return;
    const next = (Math.max(activeIndex, 0) + direction + galleryImages.length) % galleryImages.length;
    setShowModel(false);
    setActiveImage(galleryImages[next].url);
  };
  const modelUrl = media.find(asset => asset.kind === "model")?.url ?? product.model_url;
  const canRequest = productCanBeRequested(product);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <div className="grid gap-8 lg:grid-cols-[1fr_1fr]">
        <section>
          <div className="group/gallery relative aspect-square overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
            {showModel && modelUrl ? <ProductModelViewer src={modelUrl} poster={product.model_poster_url || activeImage} alt={`3D view of ${product.name}`} /> :
              activeImage ? <Image src={activeImage} alt={product.name} width={1000} height={1000} className="h-full w-full object-cover" priority unoptimized /> :
                <div className="flex h-full items-center justify-center text-6xl text-brand-primary">KM</div>}
            {!showModel && galleryImages.length > 1 ? <>
              <button type="button" aria-label="Previous product image" onClick={() => moveImage(-1)} className="absolute left-3 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-white/20 bg-black/70 text-2xl text-white shadow-lg transition hover:border-brand-primary hover:text-brand-primary">‹</button>
              <button type="button" aria-label="Next product image" onClick={() => moveImage(1)} className="absolute right-3 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-white/20 bg-black/70 text-2xl text-white shadow-lg transition hover:border-brand-primary hover:text-brand-primary">›</button>
              <span className="absolute bottom-3 right-3 rounded-full bg-black/75 px-3 py-1 text-xs text-white">{Math.max(activeIndex, 0) + 1} / {galleryImages.length}</span>
            </> : null}
          </div>
          <div className="mt-3 flex gap-2 overflow-x-auto pb-2">
            {galleryImages.map(asset => <button type="button" key={asset.id} onClick={() => { setShowModel(false); setActiveImage(asset.url); }} className={`shrink-0 overflow-hidden rounded-xl border bg-zinc-950 text-brand-text transition hover:border-brand-primary/70 ${!showModel && activeImage === asset.url ? "border-brand-primary ring-1 ring-brand-primary/40" : "border-zinc-700"}`}><Image src={asset.url} alt={asset.alt_text || product.name} width={88} height={88} className="h-20 w-20 object-cover" unoptimized /></button>)}
            {modelUrl ? <button type="button" onClick={() => setShowModel(true)} className={`h-20 w-24 shrink-0 rounded-xl border text-sm font-medium transition hover:border-brand-primary/70 hover:text-brand-primary ${showModel ? "border-brand-primary bg-brand-primary/10 text-brand-primary" : "border-zinc-700 bg-zinc-950 text-brand-text"}`}>3D view</button> : null}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-2"><span className={`rounded-full border px-3 py-1 text-xs ${canRequest ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" : "border-rose-400/40 bg-rose-400/10 text-rose-200"}`}>{availabilityLabel(product.availability_status)}</span>{product.inventory_policy === "track" ? <span className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-brand-textMuted">{inventoryLabel(product)}</span> : null}{product.lead_time_text ? <span className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-brand-textMuted">{product.lead_time_text}</span> : null}</div>
          <h1 className="mt-3 text-3xl font-semibold">{product.name}</h1>
          <p className="mt-3 whitespace-pre-wrap text-brand-textMuted">{product.description}</p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-zinc-800 bg-black/30 p-4"><p className="text-xs uppercase tracking-wide text-brand-textMuted">Lead time</p><p className="mt-2 font-medium">{product.lead_time_text || "Confirmed with your quote"}</p></div>
            <div className="rounded-xl border border-zinc-800 bg-black/30 p-4"><p className="text-xs uppercase tracking-wide text-brand-textMuted">Pricing basis</p><p className="mt-2 font-medium">{product.starting_price_cents == null ? "Quoted after design review" : `Starts at $${(product.starting_price_cents / 100).toFixed(2)}`}</p></div>
            <div className="rounded-xl border border-zinc-800 bg-black/30 p-4"><p className="text-xs uppercase tracking-wide text-brand-textMuted">Customization</p><p className="mt-2 font-medium">{product.is_custom ? "Options and project details supported" : "Sold in the listed configuration"}</p></div>
            <div className="rounded-xl border border-zinc-800 bg-black/30 p-4"><p className="text-xs uppercase tracking-wide text-brand-textMuted">Before payment</p><p className="mt-2 font-medium">Scope, final price, and fulfillment are confirmed</p></div>
          </div>
          <p className="mt-4 text-sm leading-6 text-brand-textMuted">Need help choosing a material or tolerance? Read the <a href="/design-guide" className="font-medium text-brand-primary hover:underline">design guide</a> or <a href="/contact" className="font-medium text-brand-primary hover:underline">contact us</a>.</p>
        </section>

        <form onSubmit={submit} className="h-fit rounded-2xl border border-zinc-700 bg-zinc-950/70 p-5 shadow-xl sm:p-6 lg:sticky lg:top-24">
          <div className="mb-6 grid grid-cols-3 gap-2" aria-label="Checkout progress">{["Customize", "Delivery", "Review"].map((label, index) => <div key={label} className={`rounded-lg border px-2 py-2 text-center text-xs font-medium ${step === index + 1 ? "border-brand-primary bg-brand-primary/10 text-brand-primary" : step > index + 1 ? "border-emerald-500/40 text-emerald-200" : "border-zinc-800 text-brand-textMuted"}`}>{index + 1}. {label}</div>)}</div>
          <h2 className="text-xl font-semibold">{step === 1 ? "Customize your item" : step === 2 ? "Delivery details" : "Review your request"}</h2>
          <p className="mt-1 text-sm text-brand-textMuted">{step === 1 ? "Choose your options and see the estimated price update instantly." : step === 2 ? "Tell us where this order should go and when you need it." : "Confirm everything below. You will not be charged yet."}</p>
          {step === 1 ? <><label className="mt-5 block text-sm">Quantity<input required className={`${input} mt-1`} type="number" min={1} max={product.inventory_policy === "track" && !product.continue_selling_when_out_of_stock ? product.inventory_quantity : 1000} value={quantity} onChange={e => setQuantity(Math.max(1, Number(e.target.value)))} /></label>

          {product.is_custom ? <div className="mt-5 space-y-4">
            {groups.map(group => <fieldset key={group.id}>
              <legend className="text-sm font-medium">{group.name}{group.is_required ? <span className="text-brand-primary"> *</span> : null}</legend>
              {group.description ? <p className="mt-1 text-xs text-brand-textMuted">{group.description}</p> : null}
              {group.input_type === "select" ? <div className="mt-1">
                <MenuSelect
                  value={String(selections[group.option_key] ?? "")}
                  onChange={value => setSelections(current => ({ ...current, [group.option_key]: value }))}
                  ariaLabel={group.name}
                  align="left"
                  className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-zinc-700 bg-black/40 px-3 py-2.5 text-left text-sm text-brand-text outline-none transition hover:border-brand-primary/70 focus-visible:border-brand-primary disabled:cursor-not-allowed disabled:opacity-50"
                  menuClassName="overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 text-brand-text shadow-2xl shadow-black/60"
                  options={[
                    ...(!group.is_required ? [{ value: "", label: "No preference" }] : []),
                    ...(group.product_option_values ?? []).map(value => ({
                      value: value.value,
                      label: `${value.label}${value.price_adjustment_cents ? ` (${money(value.price_adjustment_cents)})` : ""}`,
                    })),
                  ]}
                />
              </div> : null}
              {group.input_type === "radio" ? <div className="mt-2 grid gap-2 sm:grid-cols-2">{(group.product_option_values ?? []).map(value => <label key={value.id} className={`cursor-pointer rounded-xl border p-3 text-sm text-brand-text transition hover:border-brand-primary/70 ${selections[group.option_key] === value.value ? "border-brand-primary bg-brand-primary/10" : "border-zinc-700 bg-black/30"}`}><input className="mr-2" type="radio" required={group.is_required} name={group.option_key} checked={selections[group.option_key] === value.value} onChange={() => setSelections(current => ({ ...current, [group.option_key]: value.value }))} />{value.label}{value.price_adjustment_cents ? <span className="ml-1 text-brand-primary">{money(value.price_adjustment_cents)}</span> : null}</label>)}</div> : null}
              {group.input_type === "text" ? <input required={group.is_required} className={`${input} mt-1`} placeholder={group.placeholder || ""} value={String(selections[group.option_key] ?? "")} onChange={e => setSelections(current => ({ ...current, [group.option_key]: e.target.value }))} /> : null}
              {group.input_type === "textarea" ? <textarea required={group.is_required} className={`${input} mt-1 min-h-24`} placeholder={group.placeholder || ""} value={String(selections[group.option_key] ?? "")} onChange={e => setSelections(current => ({ ...current, [group.option_key]: e.target.value }))} /> : null}
              {group.input_type === "number" ? <input required={group.is_required} type="number" className={`${input} mt-1`} placeholder={group.placeholder || ""} value={String(selections[group.option_key] ?? "")} onChange={e => setSelections(current => ({ ...current, [group.option_key]: e.target.value ? Number(e.target.value) : null }))} /> : null}
              {group.input_type === "checkbox" ? <label className="mt-2 flex items-center gap-2 rounded-xl border border-zinc-700 bg-black/30 p-3 text-sm text-brand-text transition hover:border-brand-primary/70"><input type="checkbox" checked={Boolean(selections[group.option_key])} onChange={e => setSelections(current => ({ ...current, [group.option_key]: e.target.checked }))} />{group.placeholder || `Yes, include ${group.name.toLowerCase()}`}</label> : null}
              {group.input_type === "file" ? <><input required={group.is_required} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className={`${input} mt-1`} onChange={e => setFiles(current => ({ ...current, [group.option_key]: e.target.files?.[0] ?? null }))} /><p className="mt-1 text-xs text-brand-textMuted">JPEG, PNG, WebP, or PDF · 20 MB max</p></> : null}
            </fieldset>)}
          </div> : null}
          <label className="mt-4 block text-sm">Notes<textarea className={`${input} mt-1 min-h-28`} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Describe anything else I should know (optional)." maxLength={5000} /></label></> : null}

          {step === 2 ? <><div className="mt-5 grid grid-cols-2 gap-3"><button type="button" onClick={() => setFulfillmentMethod("shipping")} className={`rounded-xl border p-4 text-left ${fulfillmentMethod === "shipping" ? "border-brand-primary bg-brand-primary/10" : "border-zinc-700"}`}><span className="block font-medium">Ship to me</span><span className="mt-1 block text-xs text-brand-textMuted">Shipping cost confirmed with your quote</span></button><button type="button" onClick={() => setFulfillmentMethod("pickup")} className={`rounded-xl border p-4 text-left ${fulfillmentMethod === "pickup" ? "border-brand-primary bg-brand-primary/10" : "border-zinc-700"}`}><span className="block font-medium">Local pickup</span><span className="mt-1 block text-xs text-brand-textMuted">Arrange pickup after completion</span></button></div>{fulfillmentMethod === "shipping" ? <div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-sm sm:col-span-2">Full name<input className={`${input} mt-1`} autoComplete="name" value={shippingAddress.name} onChange={e=>setShippingAddress({...shippingAddress,name:e.target.value})} /></label><label className="text-sm sm:col-span-2">Street address<input className={`${input} mt-1`} autoComplete="street-address" value={shippingAddress.line1} onChange={e=>setShippingAddress({...shippingAddress,line1:e.target.value})} /></label><label className="text-sm sm:col-span-2">Apartment, suite, etc.<input className={`${input} mt-1`} value={shippingAddress.line2} onChange={e=>setShippingAddress({...shippingAddress,line2:e.target.value})} /></label><label className="text-sm">City<input className={`${input} mt-1`} autoComplete="address-level2" value={shippingAddress.city} onChange={e=>setShippingAddress({...shippingAddress,city:e.target.value})} /></label><label className="text-sm">State / region<input className={`${input} mt-1`} autoComplete="address-level1" value={shippingAddress.state} onChange={e=>setShippingAddress({...shippingAddress,state:e.target.value})} /></label><label className="text-sm">Postal code<input className={`${input} mt-1`} autoComplete="postal-code" value={shippingAddress.postal_code} onChange={e=>setShippingAddress({...shippingAddress,postal_code:e.target.value})} /></label><label className="text-sm">Country<input className={`${input} mt-1`} value={shippingAddress.country} maxLength={2} onChange={e=>setShippingAddress({...shippingAddress,country:e.target.value.toUpperCase()})} /></label></div> : <div className="mt-4 rounded-xl border border-zinc-800 bg-black/30 p-4 text-sm text-brand-textMuted">We’ll send pickup instructions when your order is ready.</div>}
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="text-sm">Target date<input className={`${input} mt-1`} type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} /></label>
            <label className="text-sm">Budget<input className={`${input} mt-1`} value={budget} onChange={e => setBudget(e.target.value)} placeholder="Optional" /></label>
          </div></> : null}
          {step === 3 ? <div className="mt-5 space-y-4 text-sm"><div className="rounded-xl border border-zinc-800 bg-black/30 p-4"><div className="flex justify-between"><span className="text-brand-textMuted">Item</span><span>{product.name} × {quantity}</span></div>{groups.map(group => { const selected=selections[group.option_key]; const choice=group.product_option_values?.find(value=>value.value===selected); const file=files[group.option_key]; return selected || file ? <div key={group.id} className="mt-2 flex justify-between gap-4"><span className="text-brand-textMuted">{group.name}</span><span className="text-right">{file?.name || choice?.label || String(selected)}</span></div> : null; })}</div><div className="rounded-xl border border-zinc-800 bg-black/30 p-4"><div className="font-medium">{fulfillmentMethod === "shipping" ? "Shipping" : "Local pickup"}</div>{fulfillmentMethod === "shipping" ? <p className="mt-2 text-brand-textMuted">{shippingAddress.name}<br />{shippingAddress.line1}{shippingAddress.line2 ? <><br />{shippingAddress.line2}</> : null}<br />{shippingAddress.city}, {shippingAddress.state} {shippingAddress.postal_code}<br />{shippingAddress.country}</p> : <p className="mt-2 text-brand-textMuted">Pickup instructions will be sent when ready.</p>}</div>{notes ? <div className="rounded-xl border border-zinc-800 bg-black/30 p-4"><div className="font-medium">Notes</div><p className="mt-2 whitespace-pre-wrap text-brand-textMuted">{notes}</p></div> : null}</div> : null}
          <div className="mt-5 flex items-end justify-between gap-4 border-t border-zinc-800 pt-4"><div><div className="text-xs text-brand-textMuted">Estimated starting total</div><div className="text-xl font-semibold text-brand-primary">{estimated == null ? "Quoted after review" : `$${(estimated / 100).toFixed(2)}`}</div></div><span className="text-xs text-brand-textMuted">No charge now</span></div>
          {error ? <p className="mt-3 text-sm text-rose-200">{error}</p> : null}
          {!canRequest ? <p className="mt-5 rounded-xl border border-rose-400/40 bg-rose-400/10 p-4 text-sm text-rose-100">This item is not accepting requests right now. Check back soon.</p> : null}
          <div className="mt-5 flex gap-3">{step > 1 ? <button type="button" onClick={() => setStep(step === 3 ? 2 : 1)} className="rounded-xl border border-zinc-700 px-4 py-3 font-medium">Back</button> : null}{step === 1 ? <button type="button" disabled={!canRequest} onClick={() => advance(2)} className="catalog-action-primary flex-1 rounded-xl px-4 py-3 transition disabled:opacity-50">Continue to delivery</button> : step === 2 ? <button type="button" onClick={() => advance(3)} className="catalog-action-primary flex-1 rounded-xl px-4 py-3 transition">Review request</button> : <button disabled={busy || !canRequest} className="catalog-action-primary flex-1 rounded-xl px-4 py-3 transition disabled:cursor-not-allowed disabled:opacity-50">{busy ? "Reserving…" : canRequest ? "Submit request — no charge" : "Requests paused"}</button>}</div>
        </form>
      </div>
    </main>
  );
}
