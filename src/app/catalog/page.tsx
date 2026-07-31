"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";

type Product = {
  id: string; name: string; slug: string; short_description: string | null;
  image_url: string | null; category: string | null; starting_price_cents: number | null; is_custom: boolean;
};

const money = (cents: number | null) => cents == null ? "Price determined after review" : `Starting at $${(cents / 100).toFixed(2)}`;

export default function CatalogPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void supabase.from("products")
      .select("id,name,slug,short_description,image_url,category,starting_price_cents,is_custom")
      .eq("is_published", true).order("sort_order").order("created_at", { ascending: false })
      .then(({ data, error: queryError }) => {
        setProducts((data ?? []) as Product[]);
        setError(queryError?.message ?? "");
        setLoading(false);
      });
  }, [supabase]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[.2em] text-brand-primary">Made by KeyMoura</p>
          <h1 className="mt-2 text-4xl font-semibold">Catalog</h1>
          <p className="mt-3 max-w-2xl text-brand-textMuted">Browse what I can make, then send a request with the exact details you want. Nothing is charged until we agree on the job.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/shops" className="rounded-full border border-brand-primary/50 bg-brand-primary/10 px-4 py-2 text-sm text-brand-primary hover:bg-brand-primary/20">Trusted shops</Link>
          <Link href="/orders" className="rounded-full border border-brand-primary/60 bg-brand-primary/15 px-4 py-2 text-sm text-brand-primary hover:bg-brand-primary/25">My requests & orders</Link>
        </div>
      </div>
      {loading ? <p className="text-brand-textMuted">Loading catalog…</p> : null}
      {error ? <p className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-rose-200">{error}</p> : null}
      {!loading && !error && products.length === 0 ? (
        <div className="rounded-2xl border border-zinc-800 bg-black/30 p-8 text-center text-brand-textMuted">Products are being added. Check back soon.</div>
      ) : null}
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {products.map((product) => (
          <article key={product.id} className="overflow-hidden rounded-2xl border border-zinc-800 bg-black/30">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {product.image_url ? <img src={product.image_url} alt="" className="h-52 w-full object-cover" /> : <div className="flex h-52 items-center justify-center bg-zinc-900 text-4xl text-brand-primary">KM</div>}
            <div className="p-5">
              <div className="flex items-center justify-between gap-2 text-xs text-brand-textMuted"><span>{product.category || "Custom made"}</span>{product.is_custom ? <span>Customizable</span> : null}</div>
              <h2 className="mt-2 text-xl font-semibold">{product.name}</h2>
              <p className="mt-2 min-h-12 text-sm text-brand-textMuted">{product.short_description}</p>
              <p className="mt-4 text-sm font-medium text-brand-primary">{money(product.starting_price_cents)}</p>
              <Link href={`/catalog/${product.slug}`} className="mt-4 inline-flex rounded-full border border-brand-primary/70 bg-brand-primary/10 px-4 py-2 text-sm text-brand-primary hover:bg-brand-primary/20">View & request</Link>
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
