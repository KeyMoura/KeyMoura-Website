"use client";

import Image from "next/image";
import { useParams, useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { ProductModelViewer } from "@/components/ProductModelViewer";
import { CatalogProduct, money, ProductMedia, ProductOptionGroup } from "@/lib/commerceTypes";
import { supabaseBrowser } from "@/lib/supabaseClient";

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

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) { router.push(`/auth/login?next=${encodeURIComponent(`/catalog/${slug}`)}`); return; }
    if (!product) { setBusy(false); return; }

    const requestToken = crypto.randomUUID();
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
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${auth.user.id}/${requestToken}/${group.option_key}-${safeName}`;
        const { error: uploadError } = await supabase.storage.from("order-assets").upload(path, file, { upsert: false, contentType: file.type || undefined });
        if (uploadError) { setBusy(false); return setError(`Could not upload ${group.name}: ${uploadError.message}`); }
        snapshot[group.option_key] = { label: group.name, value: path, display_value: file.name, kind: "file" };
      }
    }
    snapshot.budget = budget.trim() || null;
    snapshot.estimated_total_cents = estimated;

    const { data, error: insertError } = await supabase.from("orders").insert({
      customer_id: auth.user.id, product_id: product.id, product_name: product.name, quantity,
      specifications: snapshot, customer_notes: notes.trim() || null, target_date: targetDate || null,
    }).select("id").single();
    if (insertError) { setError(insertError.message); setBusy(false); return; }
    router.push(`/orders/${data.id}`);
  }

  if (!product && !error) return <main className="mx-auto max-w-6xl px-4 py-10 text-brand-textMuted">Loading…</main>;
  if (!product) return <main className="mx-auto max-w-6xl px-4 py-10 text-rose-200">{error}</main>;
  const input = "w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2.5 outline-none focus:border-brand-primary";
  const images = media.filter(asset => asset.kind === "image");
  const modelUrl = media.find(asset => asset.kind === "model")?.url ?? product.model_url;

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <div className="grid gap-8 lg:grid-cols-[1fr_1fr]">
        <section>
          <div className="aspect-square overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
            {showModel && modelUrl ? <ProductModelViewer src={modelUrl} poster={product.model_poster_url || activeImage} alt={`3D view of ${product.name}`} /> :
              activeImage ? <Image src={activeImage} alt={product.name} width={1000} height={1000} className="h-full w-full object-cover" priority unoptimized /> :
                <div className="flex h-full items-center justify-center text-6xl text-brand-primary">KM</div>}
          </div>
          <div className="mt-3 flex gap-2 overflow-x-auto pb-2">
            {images.map(asset => <button key={asset.id} onClick={() => { setShowModel(false); setActiveImage(asset.url); }} className={`shrink-0 overflow-hidden rounded-xl border ${!showModel && activeImage === asset.url ? "border-brand-primary" : "border-zinc-800"}`}><Image src={asset.url} alt={asset.alt_text || product.name} width={88} height={88} className="h-20 w-20 object-cover" unoptimized /></button>)}
            {modelUrl ? <button onClick={() => setShowModel(true)} className={`h-20 w-24 shrink-0 rounded-xl border text-sm ${showModel ? "border-brand-primary bg-brand-primary/10 text-brand-primary" : "border-zinc-800"}`}>3D view</button> : null}
          </div>
          <h1 className="mt-5 text-3xl font-semibold">{product.name}</h1>
          <p className="mt-3 whitespace-pre-wrap text-brand-textMuted">{product.description}</p>
        </section>

        <form onSubmit={submit} className="h-fit rounded-2xl border border-zinc-800 bg-black/30 p-6">
          <h2 className="text-xl font-semibold">Request this item</h2>
          <p className="mt-1 text-sm text-brand-textMuted">{product.is_custom ? "Choose what you want. We can refine it together in the order chat." : "Send a request for this product. We’ll confirm availability and details in chat."}</p>
          <label className="mt-5 block text-sm">Quantity<input required className={`${input} mt-1`} type="number" min={1} max={1000} value={quantity} onChange={e => setQuantity(Number(e.target.value))} /></label>

          {product.is_custom ? <div className="mt-5 space-y-4">
            {groups.map(group => <fieldset key={group.id}>
              <legend className="text-sm font-medium">{group.name}{group.is_required ? <span className="text-brand-primary"> *</span> : null}</legend>
              {group.description ? <p className="mt-1 text-xs text-brand-textMuted">{group.description}</p> : null}
              {group.input_type === "select" ? <select required={group.is_required} className={`${input} mt-1`} value={String(selections[group.option_key] ?? "")} onChange={e => setSelections(current => ({ ...current, [group.option_key]: e.target.value }))}>
                {!group.is_required ? <option value="">No preference</option> : null}
                {(group.product_option_values ?? []).map(value => <option key={value.id} value={value.value}>{value.label}{value.price_adjustment_cents ? ` (${money(value.price_adjustment_cents)})` : ""}</option>)}
              </select> : null}
              {group.input_type === "radio" ? <div className="mt-2 grid gap-2 sm:grid-cols-2">{(group.product_option_values ?? []).map(value => <label key={value.id} className={`cursor-pointer rounded-xl border p-3 text-sm ${selections[group.option_key] === value.value ? "border-brand-primary bg-brand-primary/10" : "border-zinc-700"}`}><input className="mr-2" type="radio" required={group.is_required} name={group.option_key} checked={selections[group.option_key] === value.value} onChange={() => setSelections(current => ({ ...current, [group.option_key]: value.value }))} />{value.label}{value.price_adjustment_cents ? <span className="ml-1 text-brand-primary">{money(value.price_adjustment_cents)}</span> : null}</label>)}</div> : null}
              {group.input_type === "text" ? <input required={group.is_required} className={`${input} mt-1`} placeholder={group.placeholder || ""} value={String(selections[group.option_key] ?? "")} onChange={e => setSelections(current => ({ ...current, [group.option_key]: e.target.value }))} /> : null}
              {group.input_type === "textarea" ? <textarea required={group.is_required} className={`${input} mt-1 min-h-24`} placeholder={group.placeholder || ""} value={String(selections[group.option_key] ?? "")} onChange={e => setSelections(current => ({ ...current, [group.option_key]: e.target.value }))} /> : null}
              {group.input_type === "number" ? <input required={group.is_required} type="number" className={`${input} mt-1`} placeholder={group.placeholder || ""} value={String(selections[group.option_key] ?? "")} onChange={e => setSelections(current => ({ ...current, [group.option_key]: e.target.value ? Number(e.target.value) : null }))} /> : null}
              {group.input_type === "checkbox" ? <label className="mt-2 flex items-center gap-2 rounded-xl border border-zinc-700 p-3 text-sm"><input type="checkbox" checked={Boolean(selections[group.option_key])} onChange={e => setSelections(current => ({ ...current, [group.option_key]: e.target.checked }))} />{group.placeholder || `Yes, include ${group.name.toLowerCase()}`}</label> : null}
              {group.input_type === "file" ? <input required={group.is_required} type="file" className={`${input} mt-1`} onChange={e => setFiles(current => ({ ...current, [group.option_key]: e.target.files?.[0] ?? null }))} /> : null}
            </fieldset>)}
          </div> : null}

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="text-sm">Target date<input className={`${input} mt-1`} type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} /></label>
            <label className="text-sm">Budget<input className={`${input} mt-1`} value={budget} onChange={e => setBudget(e.target.value)} placeholder="Optional" /></label>
          </div>
          <label className="mt-4 block text-sm">Notes<textarea className={`${input} mt-1 min-h-28`} required value={notes} onChange={e => setNotes(e.target.value)} placeholder="Describe anything else I should know." /></label>
          <div className="mt-5 flex items-end justify-between gap-4 border-t border-zinc-800 pt-4"><div><div className="text-xs text-brand-textMuted">Estimated starting total</div><div className="text-xl font-semibold text-brand-primary">{estimated == null ? "Quoted after review" : `$${(estimated / 100).toFixed(2)}`}</div></div><span className="text-xs text-brand-textMuted">No charge now</span></div>
          {error ? <p className="mt-3 text-sm text-rose-200">{error}</p> : null}
          <button disabled={busy} className="mt-5 w-full rounded-xl border border-brand-primary/80 bg-brand-primary/20 px-4 py-3 font-semibold text-brand-primary transition hover:bg-brand-primary/30 disabled:opacity-50">{busy ? "Sending…" : "Send request"}</button>
        </form>
      </div>
    </main>
  );
}
