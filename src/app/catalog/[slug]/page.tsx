"use client";

import { useParams, useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";

type Product = { id: string; name: string; description: string | null; image_url: string | null; starting_price_cents: number | null; };

export default function ProductRequestPage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [product, setProduct] = useState<Product | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [material, setMaterial] = useState("");
  const [dimensions, setDimensions] = useState("");
  const [color, setColor] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [budget, setBudget] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void supabase.from("products").select("id,name,description,image_url,starting_price_cents")
      .eq("slug", params.slug).eq("is_published", true).maybeSingle()
      .then(({ data, error }) => { setProduct(data as Product | null); setError(error?.message ?? ""); });
  }, [params.slug, supabase]);

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) { router.push(`/auth/login?next=${encodeURIComponent(`/catalog/${params.slug}`)}`); return; }
    if (!product) { setBusy(false); return; }
    const specifications = { material: material.trim() || null, dimensions: dimensions.trim() || null, color: color.trim() || null, budget: budget.trim() || null };
    const { data, error: insertError } = await supabase.from("orders").insert({
      customer_id: auth.user.id, product_id: product.id, product_name: product.name, quantity,
      specifications, customer_notes: notes.trim() || null, target_date: targetDate || null,
    }).select("id").single();
    if (insertError) { setError(insertError.message); setBusy(false); return; }
    router.push(`/orders/${data.id}`);
  }

  if (!product && !error) return <main className="mx-auto max-w-4xl px-4 py-10 text-brand-textMuted">Loading…</main>;
  if (!product) return <main className="mx-auto max-w-4xl px-4 py-10 text-rose-200">{error || "Product not found."}</main>;
  const input = "w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2.5 outline-none focus:border-brand-primary";
  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <div className="grid gap-8 md:grid-cols-[.8fr_1.2fr]">
        <section>{/* eslint-disable-next-line @next/next/no-img-element */}{product.image_url ? <img src={product.image_url} alt="" className="aspect-square w-full rounded-2xl object-cover" /> : null}<h1 className="mt-4 text-3xl font-semibold">{product.name}</h1><p className="mt-3 whitespace-pre-wrap text-brand-textMuted">{product.description}</p></section>
        <form onSubmit={submit} className="rounded-2xl border border-zinc-800 bg-black/30 p-6">
          <h2 className="text-xl font-semibold">Request this item</h2>
          <p className="mt-1 text-sm text-brand-textMuted">Tell me what you want. We can adjust everything in the order chat.</p>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="text-sm">Quantity<input className={`${input} mt-1`} type="number" min={1} max={1000} value={quantity} onChange={e => setQuantity(Number(e.target.value))} /></label>
            <label className="text-sm">Material<input className={`${input} mt-1`} value={material} onChange={e => setMaterial(e.target.value)} placeholder="Delrin, walnut, aluminum…" /></label>
            <label className="text-sm">Dimensions<input className={`${input} mt-1`} value={dimensions} onChange={e => setDimensions(e.target.value)} placeholder="Approximate is okay" /></label>
            <label className="text-sm">Color / finish<input className={`${input} mt-1`} value={color} onChange={e => setColor(e.target.value)} /></label>
            <label className="text-sm">Target date<input className={`${input} mt-1`} type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} /></label>
            <label className="text-sm">Budget<input className={`${input} mt-1`} value={budget} onChange={e => setBudget(e.target.value)} placeholder="Optional" /></label>
          </div>
          <label className="mt-4 block text-sm">Notes<textarea className={`${input} mt-1 min-h-32`} required value={notes} onChange={e => setNotes(e.target.value)} placeholder="Describe the part, customization, use, and anything else I should know." /></label>
          {error ? <p className="mt-3 text-sm text-rose-200">{error}</p> : null}
          <button disabled={busy} className="mt-5 w-full rounded-xl border border-brand-primary/80 bg-brand-primary/20 px-4 py-3 font-semibold text-brand-primary transition hover:bg-brand-primary/30 disabled:opacity-50">{busy ? "Sending…" : "Send request"}</button>
        </form>
      </div>
    </main>
  );
}
