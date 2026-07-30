"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { MenuSelect } from "@/components/ui/MenuSelect";

type TrustStatus = "trusted" | "untrusted" | "unknown";

const trustFilterOptions = [
  { value: "all", label: "All" },
  { value: "trusted", label: "Trusted" },
  { value: "untrusted", label: "Untrusted" },
  { value: "unknown", label: "Unknown" },
] as const;

type ShopRow = {
  id: string;
  name: string;
  slug: string;
  url: string;
  description: string | null;
  tags: string[] | null;
  featured: boolean;
  sort_order: number;
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

function CtaButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center rounded-full border border-zinc-700 bg-black/40 px-4 py-2 text-[12px] font-medium text-brand-textMuted transition hover:border-amber-400/80 hover:text-brand-text ${
        disabled ? "cursor-not-allowed opacity-60" : ""
      }`}
    >
      {children}
    </button>
  );
}

function truncateText(s: string, max: number): string {
  const t = (s ?? "").trim();
  if (!t) return "";
  if (t.length <= max) return t;
  return t.slice(0, max).trimEnd() + "…";
}

function trustRank(status: TrustStatus): number {
  // lower = earlier
  if (status === "trusted") return 0;
  if (status === "unknown") return 1;
  return 2; // untrusted last
}

export default function ShopsPage() {
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [shops, setShops] = useState<ShopRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");

  // NEW: trust filter + sort
  const [trustFilter, setTrustFilter] = useState<"all" | TrustStatus>("all");
  const [trustedFirst, setTrustedFirst] = useState(true);

  async function fetchShops() {
    setLoading(true);
    setLoadError(null);

    const { data, error } = await supabase
      .from("shops")
      .select(
        "id,name,slug,url,description,tags,featured,sort_order,is_published,trust_status,warning_text,created_at",
      )
      .eq("is_published", true)
      .order("featured", { ascending: false })
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false });

    if (error) {
      setLoadError(error.message);
      setShops([]);
      setLoading(false);
      return;
    }

    setShops((data ?? []) as ShopRow[]);
    setLoading(false);
  }

  useEffect(() => {
    void fetchShops();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();

    let list = shops;

    // trust filter
    if (trustFilter !== "all") {
      list = list.filter((s) => s.trust_status === trustFilter);
    }

    // search filter
    if (q) {
      list = list.filter((s) => {
        const hay = [
          s.name,
          s.slug,
          s.url,
          s.description ?? "",
          s.warning_text ?? "",
          ...(s.tags ?? []),
          s.trust_status,
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }

    // trust sorting (optional)
    if (trustedFirst) {
      list = [...list].sort((a, b) => {
        const tr = trustRank(a.trust_status) - trustRank(b.trust_status);
        if (tr !== 0) return tr;

        // preserve your existing ordering inside trust buckets
        if (a.featured !== b.featured) return Number(b.featured) - Number(a.featured);
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
        return b.created_at.localeCompare(a.created_at);
      });
    }

    return list;
  }, [shops, search, trustFilter, trustedFirst]);

  function goToShop(slug: string) {
    router.push(`/shops/${encodeURIComponent(slug)}`);
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8">
      <section className="space-y-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">
            Shops
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-brand-text sm:text-3xl">
            Sponsors &amp; links
          </h1>
          <p className="mt-1 text-[12px] text-brand-textMuted sm:text-sm">
            Trusted vendors — and also known sketchy sites, clearly labeled.
          </p>
        </div>

        {/* Controls */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          {/* Search */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 rounded-full border border-zinc-700 bg-black/40 px-3 py-2">
              <span className="text-[13px] text-brand-textMuted">🔎</span>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search shops (name, tags, url)"
                className="w-full no-zoom-input bg-transparent text-sm text-brand-text outline-none placeholder:text-zinc-500"
              />
            </div>
          </div>

          {/* Trust filter + sort */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="flex items-center gap-2 rounded-full border border-zinc-700 bg-black/40 px-3 py-2">
              <span className="text-[11px] text-brand-textMuted">Trust</span>
              <MenuSelect
                ariaLabel="Trust filter"
                value={trustFilter as any}
                onChange={(v) => setTrustFilter(v as any)}
                options={trustFilterOptions as any}
                className="flex h-7 items-center gap-2 rounded-md border border-zinc-700 bg-black/40 px-2 text-[11px] text-brand-text outline-none transition hover:border-amber-400/80"
                menuClassName="mt-2 w-48 overflow-hidden rounded-2xl border border-zinc-800 bg-black/95 shadow-2xl"
              />
            </div>

            <label className="flex items-center gap-2 rounded-full border border-zinc-700 bg-black/40 px-3 py-2 text-[12px] text-brand-textMuted">
              <input
                type="checkbox"
                checked={trustedFirst}
                onChange={(e) => setTrustedFirst(e.target.checked)}
                className="no-zoom-input"
              />
              Trusted first
            </label>

            <CtaButton onClick={() => void fetchShops()} disabled={loading}>
              Refresh
            </CtaButton>
          </div>
        </div>

        {loadError && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-[12px] text-rose-200">
            {loadError}
          </div>
        )}
      </section>
      {/* List */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-brand-textMuted">
            {loading
              ? "Loading…"
              : filtered.length === 0
                ? "No shops found"
                : "Shop list"}
          </h2>

          {!loading && shops.length > 0 && (
            <p className="text-[11px] text-brand-textMuted">
              Showing {filtered.length} of {shops.length}
            </p>
          )}
        </div>

        {loading ? (
          <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-[12px] text-brand-textMuted">
            Loading shops…
          </div>
        ) : filtered.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            {filtered.map((s) => (
              <div
                key={s.id}
                role="link"
                tabIndex={0}
                aria-label={`View details for ${s.name}`}
                onClick={() => goToShop(s.slug)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    goToShop(s.slug);
                    }
                }}
                className={`group cursor-pointer rounded-xl border bg-black/40 p-4 transition focus:outline-none focus:ring-2 ${
                    s.trust_status === "untrusted"
                    ? "border-rose-400/30 hover:border-rose-400/60"
                    : "border-zinc-800/80 hover:border-amber-400/80"
                }
                ${
                    s.featured
                    ? "ring-1 ring-amber-400/30 shadow-[0_0_18px_rgba(251,191,36,0.25)] hover:shadow-[0_0_26px_rgba(251,191,36,0.45)]"
                    : ""
                }`}
                >
                <div className="relative min-w-0">
                    {s.featured && (
                        <div className="pointer-events-none absolute right-2 top-0 text-amber-300/80 transition group-hover:text-amber-300 group-hover:drop-shadow-[0_0_6px_rgba(251,191,36,0.6)]">
                        ★
                        </div>
                    )}
                  <div className="flex items-center gap-2">
                    
                    <h3 className="text-[13px] font-semibold text-brand-text truncate">
                      {s.name}
                    </h3>
                    <TrustBadge status={s.trust_status} />
                  </div>

                  {s.description && (
                    <p className="mt-1 text-[12px] text-brand-textMuted">
                      {truncateText(s.description, 50)}
                    </p>
                  )}

                  {s.warning_text && (
                    <div
                      className={`mt-2 rounded-lg border p-2 text-[11px] ${
                        s.trust_status === "untrusted"
                          ? "border-rose-400/30 bg-rose-500/10 text-rose-200"
                          : "border-amber-400/25 bg-amber-500/5 text-amber-200/90"
                      }`}
                    >
                      <span className="font-medium">Caution:</span> {s.warning_text}
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`inline-flex items-center gap-1 text-[11px] underline-offset-2 hover:underline ${
                        s.trust_status === "untrusted"
                          ? "text-rose-200/90 hover:text-rose-200"
                          : "text-amber-200/90 hover:text-amber-200"
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                      }}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                      }}
                    >
                      Visit site →
                    </a>

                    <span className="text-[11px] text-brand-textMuted opacity-0 transition group-hover:opacity-100">
                      Click card for details
                    </span>
                  </div>

                  {Array.isArray(s.tags) && s.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {s.tags.slice(0, 10).map((tag) => (
                        <span
                          key={`${s.id}-${tag}`}
                          className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[10px] text-brand-textMuted"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
