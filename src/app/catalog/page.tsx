"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import ProductCard, { type ProductCardProduct } from "@/components/ProductCard";
import { groupMediaByProduct } from "@/lib/productImages";

type Product = ProductCardProduct;
type Sort = "featured" | "name" | "price-low" | "price-high";

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
      const byProduct = groupMediaByProduct(media ?? []);
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
  const filtered = Boolean(query.trim()) || category !== "all" || availability !== "all" || customOnly || sort !== "featured";
  const clear = () => { setQuery(""); setCategory("all"); setAvailability("all"); setCustomOnly(false); setSort("featured"); };

  return <main className="page-container">
    <header className="max-w-3xl">
      <p className="ui-eyebrow">Made by KeyMoura</p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight md:text-5xl">Find a starting point.</h1>
      <p className="mt-4 leading-7 text-brand-textMuted">Browse ready designs and customizable products. Every request is reviewed before payment, so the exact material, dimensions, and finish are settled first.</p>
    </header>

    <section aria-label="Catalog filters" className="ui-card mt-8">
      <div className="grid gap-3 md:grid-cols-[1fr_auto_auto_auto]">
        <label className="sr-only" htmlFor="catalog-search">Search products</label>
        <input id="catalog-search" type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search products or categories…" className="ui-input" />
        <select aria-label="Category" value={category} onChange={e=>setCategory(e.target.value)}><option value="all">All categories</option>{categories.map(c=><option key={c}>{c}</option>)}</select>
        <select aria-label="Availability" value={availability} onChange={e=>setAvailability(e.target.value)}><option value="all">Any availability</option><option value="available">Available</option><option value="limited">Limited</option><option value="made_to_order">Made to order</option></select>
        <select aria-label="Sort products" value={sort} onChange={e=>setSort(e.target.value as Sort)}><option value="featured">Featured</option><option value="name">Name</option><option value="price-low">Price: low to high</option><option value="price-high">Price: high to low</option></select>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-brand-textMuted"><input type="checkbox" checked={customOnly} onChange={e=>setCustomOnly(e.target.checked)} /> Customizable only</label>
        <button type="button" onClick={clear} disabled={!filtered} className="ui-btn ui-btn-ghost !py-1.5 text-sm disabled:opacity-50">Clear filters</button>
      </div>
    </section>

    <p aria-live="polite" className="mt-5 text-sm text-brand-textMuted">{loading ? "Loading catalog…" : `${visible.length} ${visible.length === 1 ? "product" : "products"}`}</p>

    {error ? <p role="alert" className="ui-notice ui-notice-danger mt-4">{error}</p> : null}

    {loading ? <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">{[0,1,2].map(index => <div key={index} className="product-card"><div className="product-image" /><div className="product-card-body"><div className="h-4 w-24 rounded bg-[var(--panel-strong)]" /><div className="mt-3 h-6 w-3/4 rounded bg-[var(--panel-strong)]" /><div className="mt-3 h-4 w-full rounded bg-[var(--panel-strong)]" /></div></div>)}</div> : null}

    {!loading && !error && !visible.length ? <div className="ui-empty-state mt-6 !p-10">
      <h2 className="text-xl font-semibold text-brand-text">{products.length ? "No products match those filters." : "The catalog is being set up."}</h2>
      <p className="mt-2">{products.length ? "Try clearing a filter, or start a custom request instead." : "Nothing is published yet. A custom request is the fastest way to get started."}</p>
      <div className="ui-action-row mt-5 justify-center">
        {products.length ? <button type="button" onClick={clear} className="ui-btn ui-btn-secondary">Clear filters</button> : null}
        <Link href="/orders/new" className="ui-btn ui-btn-primary">Start a custom request</Link>
      </div>
    </div> : null}

    {visible.length ? <section className="mt-6" aria-labelledby="catalog-products">
      {/* Product names are h3 inside the shared card, so the grid needs an h2
          above them to keep the heading outline unbroken for screen readers. */}
      <h2 id="catalog-products" className="sr-only">Products</h2>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{visible.map((product, index) => <ProductCard key={product.id} product={product} priority={index < 3} />)}</div>
    </section> : null}
  </main>;
}
