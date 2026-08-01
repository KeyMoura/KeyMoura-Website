"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { availabilityLabel, CatalogProduct, productCanBeRequested } from "@/lib/commerceTypes";

type Product = Pick<CatalogProduct, "id" | "name" | "slug" | "short_description" | "image_url" | "category" | "starting_price_cents" | "is_custom" | "availability_status" | "lead_time_text" | "inventory_policy" | "inventory_quantity" | "continue_selling_when_out_of_stock"> & { product_media?: { url: string; kind: string; sort_order: number }[] };
type Sort = "featured" | "name" | "price-low" | "price-high";
const money = (cents: number | null) => cents == null ? "Price after review" : `From $${(cents / 100).toFixed(2)}`;

export default function CatalogPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [products, setProducts] = useState<Product[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [query, setQuery] = useState(""), [category, setCategory] = useState("all"), [availability, setAvailability] = useState("all"), [customOnly, setCustomOnly] = useState(false), [sort, setSort] = useState<Sort>("featured");
  useEffect(() => { void (async () => {
    const { data, error: productError } = await supabase.from("products").select("id,name,slug,short_description,image_url,category,starting_price_cents,is_custom,availability_status,lead_time_text,inventory_policy,inventory_quantity,continue_selling_when_out_of_stock").eq("is_published", true).is("archived_at", null).order("sort_order").order("created_at", { ascending: false });
    if (productError) { setError(productError.message); setLoading(false); return; }
    const items = (data ?? []) as Product[];
    const ids = items.map(product => product.id);
    if (ids.length) {
      const { data: media } = await supabase.from("product_media").select("product_id,url,kind,sort_order").in("product_id", ids).eq("kind", "image").order("sort_order");
      const byProduct = new Map<string, Product["product_media"]>();
      for (const asset of media ?? []) byProduct.set(asset.product_id, [...(byProduct.get(asset.product_id) ?? []), asset]);
      for (const item of items) item.product_media = byProduct.get(item.id) ?? [];
    }
    setProducts(items); setError(""); setLoading(false);
  })(); }, [supabase]);
  const categories = useMemo(() => [...new Set(products.map(p => p.category).filter((v): v is string => Boolean(v)))].sort(), [products]);
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    const result = products.filter(p => (!term || `${p.name} ${p.short_description ?? ""} ${p.category ?? ""}`.toLowerCase().includes(term)) && (category === "all" || p.category === category) && (availability === "all" || p.availability_status === availability) && (!customOnly || p.is_custom));
    if (sort === "name") return result.sort((a,b) => a.name.localeCompare(b.name));
    if (sort === "price-low") return result.sort((a,b) => (a.starting_price_cents ?? Number.MAX_SAFE_INTEGER) - (b.starting_price_cents ?? Number.MAX_SAFE_INTEGER));
    if (sort === "price-high") return result.sort((a,b) => (b.starting_price_cents ?? -1) - (a.starting_price_cents ?? -1));
    return result;
  }, [products, query, category, availability, customOnly, sort]);
  const clear = () => { setQuery(""); setCategory("all"); setAvailability("all"); setCustomOnly(false); setSort("featured"); };

  return <main className="mx-auto max-w-6xl px-4 py-10 md:py-14">
    <header className="max-w-3xl"><p className="text-xs uppercase tracking-[.2em] text-brand-primary">Made by KeyMoura</p><h1 className="mt-2 text-4xl font-semibold md:text-5xl">Find a starting point.</h1><p className="mt-4 leading-7 text-brand-textMuted">Browse ready designs and customizable products. We confirm every request before payment, so you can settle the exact material, dimensions, and finish first.</p></header>
    <section aria-label="Catalog filters" className="mt-8 rounded-2xl border border-zinc-800 bg-black/30 p-4">
      <div className="grid gap-3 md:grid-cols-[1fr_auto_auto_auto]"><label className="sr-only" htmlFor="catalog-search">Search products</label><input id="catalog-search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search products or categories…" className="rounded-xl border border-zinc-700 bg-zinc-950 px-4 py-2.5" /><select aria-label="Category" value={category} onChange={e=>setCategory(e.target.value)}><option value="all">All categories</option>{categories.map(c=><option key={c}>{c}</option>)}</select><select aria-label="Availability" value={availability} onChange={e=>setAvailability(e.target.value)}><option value="all">Any availability</option><option value="available">Available</option><option value="limited">Limited</option><option value="made_to_order">Made to order</option></select><select aria-label="Sort products" value={sort} onChange={e=>setSort(e.target.value as Sort)}><option value="featured">Featured</option><option value="name">Name</option><option value="price-low">Price: low to high</option><option value="price-high">Price: high to low</option></select></div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><label className="flex items-center gap-2 text-sm text-brand-textMuted"><input type="checkbox" checked={customOnly} onChange={e=>setCustomOnly(e.target.checked)} /> Customizable only</label><button onClick={clear} className="text-sm text-brand-primary hover:underline">Clear filters</button></div>
    </section>
    <div className="mt-5 flex items-center justify-between text-sm text-brand-textMuted"><p>{loading ? "Loading catalog…" : `${visible.length} ${visible.length === 1 ? "product" : "products"}`}</p></div>
    {error ? <p className="mt-5 rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-rose-200">{error}</p> : null}
    {!loading && !error && !visible.length ? <div className="mt-6 rounded-2xl border border-zinc-800 bg-black/30 p-10 text-center"><h2 className="text-xl font-semibold">No products match those filters.</h2><p className="mt-2 text-brand-textMuted">Try clearing a filter, or start a custom request instead.</p><div className="mt-5 flex justify-center gap-3"><button onClick={clear} className="catalog-action-secondary rounded-full px-4 py-2">Clear filters</button><Link href="/orders/new" className="catalog-action-primary rounded-full px-4 py-2">Custom request</Link></div></div> : null}
    <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{visible.map(product => <article key={product.id} className="group overflow-hidden rounded-2xl border border-zinc-800 bg-black/30 transition hover:-translate-y-1 hover:border-brand-primary/40">
      <Link href={`/catalog/${product.slug}`} aria-label={`View ${product.name}`}>{(product.product_media?.[0]?.url || product.image_url) ? <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={product.product_media?.[0]?.url || product.image_url || ""} data-fallback-src={product.image_url || ""} onError={event => { const image = event.currentTarget; const fallback = image.dataset.fallbackSrc; if (fallback && image.getAttribute("src") !== fallback) { image.src = fallback; return; } image.hidden = true; image.nextElementSibling?.classList.remove("hidden"); }} alt={product.name} loading="lazy" className="aspect-[4/3] w-full object-cover transition duration-300 group-hover:scale-[1.02]" />
        <div className="hidden aspect-[4/3] flex items-center justify-center bg-zinc-900 text-4xl font-semibold text-brand-primary">KM</div>
      </> : <div className="flex aspect-[4/3] items-center justify-center bg-zinc-900 text-4xl font-semibold text-brand-primary">KM</div>}</Link>
      <div className="p-5"><div className="flex items-center justify-between gap-2 text-xs text-brand-textMuted"><span>{product.category || "Custom CNC"}</span>{product.is_custom ? <span className="rounded-full border border-brand-primary/40 bg-brand-primary/10 px-2 py-0.5 text-brand-primary">Customizable</span> : null}</div><h2 className="mt-2 text-xl font-semibold"><Link href={`/catalog/${product.slug}`} className="hover:text-brand-primary">{product.name}</Link></h2><p className="mt-2 line-clamp-2 min-h-12 text-sm leading-6 text-brand-textMuted">{product.short_description}</p><div className="mt-3 flex flex-wrap gap-2 text-xs"><span className={`rounded-full border px-2.5 py-1 ${productCanBeRequested(product) ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" : "border-rose-400/40 bg-rose-400/10 text-rose-200"}`}>{availabilityLabel(product.availability_status)}</span>{product.lead_time_text ? <span className="rounded-full border border-zinc-700 px-2.5 py-1 text-brand-textMuted">{product.lead_time_text}</span> : null}</div><div className="mt-5 flex items-center justify-between gap-3"><p className="text-sm font-semibold text-brand-primary">{money(product.starting_price_cents)}</p><Link href={`/catalog/${product.slug}`} className="catalog-action-primary rounded-full px-4 py-2 text-sm">{productCanBeRequested(product) ? "Customize" : "View"}</Link></div></div>
    </article>)}</div>
  </main>;
}
