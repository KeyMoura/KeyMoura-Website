"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";

type TrustStatus = "trusted" | "untrusted" | "unknown";

type ShopRow = {
  id: string;
  name: string;
  slug: string;
  url: string;
  description: string | null;
  tags: string[] | null;
  featured: boolean;
  is_published: boolean;
  trust_status: TrustStatus;
  warning_text: string | null;
  created_at: string;
};

function TrustBadge({ status }: { status: TrustStatus }) {
  if (status === "trusted") {
    return (
      <span className="rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-200">
        Trusted
      </span>
    );
  }
  if (status === "untrusted") {
    return (
      <span className="rounded-full border border-rose-400/40 bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-200">
        Untrusted
      </span>
    );
  }
  return (
    <span className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[10px] text-brand-textMuted">
      Unknown
    </span>
  );
}

export default function ShopDetailsPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const params = useParams<{ slug: string }>();
  const slug = typeof params?.slug === "string" ? params.slug : "";

  const [shop, setShop] = useState<ShopRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;

    void (async () => {
      setLoading(true);
      setErr(null);

      const { data, error } = await supabase
        .from("shops")
        .select(
          "id,name,slug,url,description,tags,featured,is_published,trust_status,warning_text,created_at",
        )
        .eq("slug", slug)
        .eq("is_published", true)
        .maybeSingle();

      if (error) {
        setErr(error.message);
        setShop(null);
        setLoading(false);
        return;
      }

      setShop((data ?? null) as ShopRow | null);
      setLoading(false);
    })();
  }, [slug, supabase]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      <div className="mt-1 text-[11px] text-brand-textMuted">
        <Link
          href="/shops"
          className="underline underline-offset-2 text-amber-300 hover:text-amber-200"
        >
          ← Back to shops
        </Link>
      </div>

      {loading ? (
        <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-[12px] text-brand-textMuted">
          Loading…
        </div>
      ) : err ? (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-[12px] text-rose-200">
          {err}
        </div>
      ) : !shop ? (
        <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-6">
          <h1 className="text-xl font-semibold text-brand-text">Not found</h1>
          <p className="mt-2 text-sm text-brand-textMuted">
            This shop either doesn&apos;t exist or isn&apos;t published.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-6 space-y-4">
          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">
              Shop
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold text-brand-text">{shop.name}</h1>
              {shop.featured && (
                <span className="rounded-full border border-amber-400/60 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-200">
                  Featured
                </span>
              )}
              <TrustBadge status={shop.trust_status} />
            </div>

            {shop.description && (
              <p className="text-sm text-brand-textMuted">{shop.description}</p>
            )}
          </div>

          {shop.warning_text && (
            <div
              className={`rounded-lg border p-3 text-[12px] ${
                shop.trust_status === "untrusted"
                  ? "border-rose-400/30 bg-rose-500/10 text-rose-200"
                  : "border-amber-400/25 bg-amber-500/5 text-amber-200/90"
              }`}
            >
              <p className="font-medium">Caution</p>
              <p className="mt-1">{shop.warning_text}</p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <a
              href={shop.url}
              target="_blank"
              rel="noopener noreferrer"
              className={`inline-flex items-center justify-center rounded-full border px-4 py-2 text-[12px] font-medium transition ${
                shop.trust_status === "untrusted"
                  ? "border-rose-400/40 bg-rose-500/10 text-rose-200 hover:border-rose-300/70"
                  : "border-amber-400/80 bg-amber-500/20 text-amber-200 hover:border-amber-300/90"
              }`}
            >
              Visit site →
            </a>
          </div>

          {Array.isArray(shop.tags) && shop.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-2">
              {shop.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[10px] text-brand-textMuted"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
