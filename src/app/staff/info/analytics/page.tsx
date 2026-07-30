"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import Link from "next/link";

import { AccessDenied } from "@/components/AccessDenied";
import { useMeAccess } from "@/lib/hooks/useMeAccess";

type SearchEvent = {
  id: string;
  created_at: string;
  source: string | null;
  raw_query: string | null;
  tokens: string[] | null;
  results_count: number | null;
  top_result_id: string | null;
  top_result_slug: string | null;
  meta: Record<string, unknown> | null;
};

type InfoClickEvent = {
  id: string;
  created_at: string;
  source: string | null;
  search_event_id: string | null;
  raw_query: string | null;
  tokens: string[] | null;
  clicked_page_id: string | null;
  clicked_page_slug: string | null;
  position: number | null;
  results_count: number | null;
  meta: Record<string, unknown> | null;
};

type LoadState = "idle" | "loading" | "loaded" | "error";

export default function InfoAnalyticsPage() {
  const [searchEvents, setSearchEvents] = useState<SearchEvent[]>([]);
  const [clickEvents, setClickEvents] = useState<InfoClickEvent[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { data: access, isLoading: accessLoading } = useMeAccess();
  const canView = Boolean(access?.permissions?.includes("analytics.view"));

  useEffect(() => {
    if (!canView) return;

    const load = async () => {
      setState("loading");
      setErrorMessage(null);

      try {
        const supabase = supabaseBrowser();
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) {
          setState("error");
          setErrorMessage("You must be logged in.");
          return;
        }

        const res = await fetch("/api/staff/analytics/info", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });

        const json = (await res.json().catch(() => null)) as unknown;
        if (!res.ok || !json || typeof json !== "object") {
          const msg = json && typeof (json as any).error === "string" ? (json as any).error : "Failed to load analytics.";
          setState("error");
          setErrorMessage(msg);
          setSearchEvents([]);
          setClickEvents([]);
          return;
        }

        setSearchEvents((((json as any).searchEvents ?? []) as unknown[]) as SearchEvent[]);
        setClickEvents((((json as any).clickEvents ?? []) as unknown[]) as InfoClickEvent[]);

        setState("loaded");
      } catch (err) {
        console.error("Unexpected error loading analytics", err);
        setErrorMessage("Unexpected error loading analytics.");
        setState("error");
        setSearchEvents([]);
        setClickEvents([]);
      }
    };

    void load();
  }, [canView]);

  if (accessLoading) {
    return (
      <div className="mx-auto w-full max-w-6xl p-4">
        <div className="ui-card p-6 text-sm text-brand-textMuted">Loading…</div>
      </div>
    );
  }

  if (!canView) {
    return (
      <div className="mx-auto w-full max-w-6xl p-4">
        <AccessDenied backHref="/staff" backLabel="Back" />
      </div>
    );
  }

  // --- Summary stats ---

  const totalSearches = searchEvents.length;
  const totalClicks = clickEvents.length;

  const uniqueQueriesCount = useMemo(() => {
    const set = new Set<string>();
    for (const ev of searchEvents) {
      const q = (ev.raw_query ?? "").trim().toLowerCase();
      if (!q) continue;
      set.add(q);
    }
    return set.size;
  }, [searchEvents]);

  const clickThroughRate = useMemo(() => {
    if (totalSearches === 0) return 0;
    return (totalClicks / totalSearches) * 100;
  }, [totalSearches, totalClicks]);

  // --- Helper maps to join searches <-> clicks ---

  // Map by raw_query (case-insensitive) → all clicks for that query (sorted newest → oldest)
  const clicksByQuery = useMemo(() => {
    const map = new Map<string, InfoClickEvent[]>();

    for (const ev of clickEvents) {
      const key = (ev.raw_query ?? "").trim().toLowerCase();
      if (!key) continue;
      const arr = map.get(key) ?? [];
      arr.push(ev);
      map.set(key, arr);
    }

    for (const [key, arr] of map.entries()) {
      arr.sort((a, b) => b.created_at.localeCompare(a.created_at));
      map.set(key, arr);
    }

    return map;
  }, [clickEvents]);

  // Map by search_event_id → all clicks attached to that specific search_event
  const clicksBySearchId = useMemo(() => {
    const map = new Map<string, InfoClickEvent[]>();
    for (const ev of clickEvents) {
      const id = ev.search_event_id;
      if (!id) continue;
      const arr = map.get(id) ?? [];
      arr.push(ev);
      map.set(id, arr);
    }
    for (const [key, arr] of map.entries()) {
      arr.sort((a, b) => b.created_at.localeCompare(a.created_at));
      map.set(key, arr);
    }
    return map;
  }, [clickEvents]);

  // --- Top queries (by count), now with click info ---

  type QueryAgg = {
    query: string;
    count: number;
    lastAt: string;
    clickCount: number;
    lastClickedSlug: string | null;
  };

  const topQueries = useMemo(() => {
    const map = new Map<string, QueryAgg>();

    for (const ev of searchEvents) {
      const raw = (ev.raw_query ?? "").trim();
      if (!raw) continue;

      const key = raw.toLowerCase();
      const clicksForQuery = clicksByQuery.get(key) ?? [];
      const clickCount = clicksForQuery.length;
      const lastClickedSlug =
        clicksForQuery.length > 0
          ? (clicksForQuery[0].clicked_page_slug ?? null)
          : null;

      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
        if (ev.created_at > existing.lastAt) {
          existing.lastAt = ev.created_at;
        }
        // keep the total click count + latest clicked slug across all events
        existing.clickCount = clicksByQuery.get(key)?.length ?? 0;
        existing.lastClickedSlug =
          clicksByQuery.get(key)?.[0]?.clicked_page_slug ?? null;
      } else {
        map.set(key, {
          query: raw,
          count: 1,
          lastAt: ev.created_at,
          clickCount,
          lastClickedSlug,
        });
      }
    }

    const list = Array.from(map.values());
    list.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.lastAt.localeCompare(a.lastAt);
    });

    return list.slice(0, 10);
  }, [searchEvents, clicksByQuery]);

  // --- Top clicked pages ---

  type PageClickAgg = {
    slug: string;
    count: number;
    avgPosition: number;
    lastAt: string;
  };

  const topClickedPages = useMemo(() => {
    const map = new Map<
      string,
      { slug: string; positions: number[]; lastAt: string }
    >();

    for (const ev of clickEvents) {
      const slug = (ev.clicked_page_slug ?? "").trim() || "(unknown)";
      const position = typeof ev.position === "number" ? ev.position : 0;

      const existing = map.get(slug);
      if (existing) {
        existing.positions.push(position);
        if (ev.created_at > existing.lastAt) {
          existing.lastAt = ev.created_at;
        }
      } else {
        map.set(slug, {
          slug,
          positions: [position],
          lastAt: ev.created_at,
        });
      }
    }

    const list: PageClickAgg[] = [];
    for (const value of map.values()) {
      const count = value.positions.length;
      const sum = value.positions.reduce((acc, pos) => acc + pos, 0);
      const avgPosition = count > 0 ? sum / count : 0;
      list.push({
        slug: value.slug,
        count,
        avgPosition,
        lastAt: value.lastAt,
      });
    }

    list.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.avgPosition - b.avgPosition;
    });

    return list.slice(0, 10);
  }, [clickEvents]);

  const isLoading = state === "loading";
  const hasData = totalSearches > 0 || totalClicks > 0;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
      {/* Header */}
      <section className="space-y-2">
        <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">
          Staff • Info
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-brand-text sm:text-3xl">
          Info search analytics
        </h1>
        <p className="text-[12px] text-brand-textMuted sm:text-sm">
          See how people are searching the info pages and which pages get
          clicked the most.
        </p>
        <div className="mt-1 text-[11px] text-brand-textMuted">
          <Link
            href="/staff"
            className="underline underline-offset-2 text-amber-300 hover:text-amber-200"
          >
            ← Back to admin overview
          </Link>
        </div>
      </section>

      {/* Summary cards */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-sm text-brand-text">
          <p className="text-[11px] text-brand-textMuted">Total searches</p>
          <p className="mt-1 text-2xl font-semibold">
            {isLoading ? "…" : totalSearches}
          </p>
          <p className="mt-1 text-[11px] text-brand-textMuted">
            Last 200 recorded events.
          </p>
        </div>

        <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-sm text-brand-text">
          <p className="text-[11px] text-brand-textMuted">Total clicks</p>
          <p className="mt-1 text-2xl font-semibold">
            {isLoading ? "…" : totalClicks}
          </p>
          <p className="mt-1 text-[11px] text-brand-textMuted">
            Last 200 recorded clicks.
          </p>
        </div>

        <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-sm text-brand-text">
          <p className="text-[11px] text-brand-textMuted">Unique queries</p>
          <p className="mt-1 text-2xl font-semibold">
            {isLoading ? "…" : uniqueQueriesCount}
          </p>
          <p className="mt-1 text-[11px] text-brand-textMuted">
            Distinct non-empty raw queries.
          </p>
        </div>

        <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-sm text-brand-text">
          <p className="text-[11px] text-brand-textMuted">Click-through rate</p>
          <p className="mt-1 text-2xl font-semibold">
            {isLoading ? "…" : `${clickThroughRate.toFixed(1)}%`}
          </p>
          <p className="mt-1 text-[11px] text-brand-textMuted">
            Clicks ÷ searches (approx).
          </p>
        </div>
      </section>

      {/* Error state */}
      {state === "error" && (
        <section>
          <p className="rounded-md border border-rose-500/60 bg-rose-950/40 px-3 py-2 text-[12px] text-rose-200">
            {errorMessage ?? "Failed to load analytics."}
          </p>
        </section>
      )}

      {/* No data / loading */}
      {state === "loaded" && !hasData && (
        <section>
          <p className="text-[12px] text-brand-textMuted">
            No search or click events found yet. Try performing a search on{" "}
            <Link
              href="/info"
              className="underline underline-offset-2 text-amber-300 hover:text-amber-200"
            >
              /info
            </Link>{" "}
            or using the command palette, then refresh this page.
          </p>
        </section>
      )}

      {/* Top queries & top clicked pages */}
      {hasData && (
        <section className="grid gap-4 lg:grid-cols-2">
          {/* Top queries */}
          <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-sm text-brand-text">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-brand-text">
                Top queries
              </h2>
              <span className="text-[11px] text-brand-textMuted">
                Last {searchEvents.length} search events
              </span>
            </div>

            {topQueries.length === 0 ? (
              <p className="text-[12px] text-brand-textMuted">
                No queries recorded yet.
              </p>
            ) : (
              <ul className="space-y-1 text-[12px]">
                {topQueries.map((q) => (
                  <li
                    key={q.query}
                    className="flex items-center justify-between rounded-md border border-zinc-800/70 bg-black/40 px-2 py-1.5"
                  >
                    <div className="flex flex-col">
                      <span className="font-medium text-brand-text">
                        {q.query}
                      </span>
                      <span className="text-[11px] text-brand-textMuted">
                        Last search:{" "}
                        {new Date(q.lastAt).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <span className="text-[11px] text-brand-textMuted">
                        {q.clickCount} click
                        {q.clickCount === 1 ? "" : "s"}
                        {q.lastClickedSlug
                          ? ` • Last clicked: /info/${q.lastClickedSlug}`
                          : " • No clicks yet"}
                      </span>
                    </div>
                    <span className="ml-3 text-[11px] text-amber-300">
                      {q.count}×
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Top clicked pages */}
          <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-sm text-brand-text">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-brand-text">
                Top clicked pages
              </h2>
            <span className="text-[11px] text-brand-textMuted">
                Last {clickEvents.length} click events
              </span>
            </div>

            {topClickedPages.length === 0 ? (
              <p className="text-[12px] text-brand-textMuted">
                No clicks logged yet.
              </p>
            ) : (
              <ul className="space-y-1 text-[12px]">
                {topClickedPages.map((p) => (
                  <li
                    key={p.slug}
                    className="flex items-center justify-between rounded-md border border-zinc-800/70 bg-black/40 px-2 py-1.5"
                  >
                    <div className="flex flex-col">
                      <span className="font-medium text-brand-text">
                        {p.slug}
                      </span>
                      <span className="text-[11px] text-brand-textMuted">
                        Avg. position: {p.avgPosition.toFixed(1)} • Last:{" "}
                        {new Date(p.lastAt).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <span className="ml-3 text-[11px] text-amber-300">
                      {p.count} clicks
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {/* Recent raw events */}
      {hasData && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-brand-text">
            Recent raw events
          </h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {/* Recent searches with linked clicks */}
            <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-3 text-[11px] text-brand-textMuted">
              <p className="mb-1 text-[11px] font-semibold text-brand-text">
                Recent searches
              </p>
              {searchEvents.slice(0, 8).map((ev) => {
                const qKey = (ev.raw_query ?? "").trim().toLowerCase();

                const clicksForSearchId = clicksBySearchId.get(ev.id);
                const clicksForQuery = qKey ? clicksByQuery.get(qKey) ?? [] : [];

                const sourceArray =
                  clicksForSearchId && clicksForSearchId.length > 0
                    ? clicksForSearchId
                    : clicksForQuery;

                const lastClick = sourceArray[0] ?? null;
                const clickCount = sourceArray.length;

                return (
                  <div
                    key={ev.id}
                    className="mb-1 rounded-md border border-zinc-800/70 bg-black/40 px-2 py-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[11px] text-brand-text">
                        {ev.raw_query || (
                          <span className="italic">[empty]</span>
                        )}
                      </span>
                      <span className="text-[10px] text-brand-textMuted">
                        {new Date(ev.created_at).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-brand-textMuted">
                      {ev.source && (
                        <span className="rounded-full border border-zinc-700 bg-black/40 px-1.5 py-0.5">
                          {ev.source}
                        </span>
                      )}
                      {Array.isArray(ev.tokens) &&
                        ev.tokens.slice(0, 4).map((t) => (
                          <span
                            key={ev.id + t}
                            className="rounded-full border border-zinc-700 bg-black/40 px-1.5 py-0.5"
                          >
                            {t}
                          </span>
                        ))}
                    </div>
                    <div className="mt-0.5 text-[10px] text-brand-textMuted">
                      {clickCount > 0 && lastClick?.clicked_page_slug ? (
                        <span>
                          {clickCount} click
                          {clickCount === 1 ? "" : "s"} • last clicked:{" "}
                          <span className="text-amber-300">
                            /info/{lastClick.clicked_page_slug}
                          </span>
                          {typeof lastClick.position === "number" && (
                            <> (pos {lastClick.position})</>
                          )}
                        </span>
                      ) : (
                        <span>No clicks recorded for this query yet.</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
