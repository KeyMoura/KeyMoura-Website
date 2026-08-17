"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useSiteSettings } from "@/components/SiteSettingsProvider";
import SearchHelpDialog from "@/components/ui/SearchHelpDialog";
import SearchFieldIcon from "@/components/ui/SearchFieldIcon";
import { clickBoost } from "@/lib/search/relevance";
import { trackSearch, trackSearchClick } from "@/lib/search/track";

function InfoCtaButton({
  href,
  children,
  variant = "primary",
}: {
  href: string;
  children: React.ReactNode;
  variant?: "primary" | "secondary";
}) {
  const classes = `ui-btn text-xs ${variant === "primary" ? "ui-btn-primary" : "ui-btn-ghost"}`;

  return (
    <Link href={href} className={classes}>
      {children}
    </Link>
  );
}

type RawInfoRow = {
  id: string;
  title: string;
  slug: string;
  created_at: string;
  updated_at: string | null;
  status: string;
  content_markdown?: string | null;
  tags?: string[] | null;
  category?: string | null;
  chassis?: string | null;
};

type InfoSummary = {
  id: string;
  title: string;
  slug: string;
  created_at: string;
  updated_at: string | null;
  tags: string[];
};

const CATEGORIES = [
  {
    slug: "cnc-machining",
    name: "CNC & Machining",
    description: "Machined parts, fixtures, tooling experiments, and production notes.",
  },
  {
    slug: "product-design",
    name: "Product Design",
    description: "Concepts, prototypes, revisions, materials, and finished products.",
  },
  {
    slug: "automation-tools",
    name: "Automation & Tools",
    description: "Custom machines, shop tools, controllers, and process improvements.",
  },
  {
    slug: "electronics-software",
    name: "Electronics & Software",
    description: "Embedded systems, interfaces, websites, apps, and connected builds.",
  },
  {
    slug: "automotive",
    name: "Automotive",
    description: "Vehicle parts, modifications, research, and installation projects.",
  },
  {
    slug: "business-brand",
    name: "KeyMoura Build Log",
    description: "Brand, business, shop, and behind-the-scenes development updates.",
  },
] as const;

function mapRowToSummary(row: RawInfoRow): InfoSummary {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    created_at: row.created_at,
    updated_at: row.updated_at ?? row.created_at,
    tags: row.tags ?? [],
  };
}

// --- fuzzy helpers for "Did you mean?" ---

function levenshtein(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const m = s.length;
  const n = t.length;

  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[m][n];
}

function normalizedSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / maxLen;
}

// --- highlight helpers ---

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightText(text: string, tokens: string[]): ReactNode {
  if (!text || tokens.length === 0) return text;

  const cleanedTokens = Array.from(
    new Set(
      tokens
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0)
    )
  );
  if (cleanedTokens.length === 0) return text;

  const pattern = cleanedTokens.map(escapeRegExp).join("|");
  if (!pattern) return text;

  const regex = new RegExp(`(${pattern})`, "gi");
  const parts = text.split(regex);

  return parts.map((part, idx) => {
    const lower = part.toLowerCase();
    const isMatch = cleanedTokens.some((t) => t === lower);

    if (isMatch) {
      return (
        <span
          key={idx}
          className="rounded-[3px] bg-brand-primary/15 px-0.5 text-brand-primary"
        >
          {part}
        </span>
      );
    }

    return <span key={idx}>{part}</span>;
  });
}

// --- logging helper for info index ---

type InfoSearchLogPayload = {
  source: "info-index";
  rawQuery: string;
  tokens: string[];
  resultsCount: number;
  topResultId?: string | null;
  topResultSlug?: string | null;
};

/**
 * Records the search through the validated server route.
 *
 * It used to insert straight into `info_search_events` with the browser's anon
 * key. That table's only permissive policy is `staff manage`, so every insert
 * from a customer was rejected by row-level security and the `catch` below
 * logged it to a console nobody was reading — which is why production holds
 * seven search events, all of them from staff sessions.
 *
 * The route writes with the service role after validating the payload, so the
 * feature works for the people it was built to measure and the ranking inputs
 * are checked somewhere the client cannot skip.
 */
async function logInfoSearchEvent(payload: InfoSearchLogPayload): Promise<string | null> {
  return trackSearch({
    source: "projects",
    query: payload.rawQuery,
    scope: "projects",
    resultCount: payload.resultsCount,
  });
}

// --- logging helper for click events on index ---

type InfoSearchClickPayload = {
  source: "info-index";
  rawQuery?: string;
  tokens?: string[];
  clickedPageId: string;
  clickedPageSlug: string;
  position?: number;
  resultsCount?: number;
  /** The search this click came from, so the two can be joined. */
  searchEventId?: string | null;
  meta?: Record<string, unknown>;
};

/** The click, through the same validated route and for the same reason. */
function logInfoSearchClick(payload: InfoSearchClickPayload): void {
  trackSearchClick({
    source: "projects",
    searchEventId: payload.searchEventId ?? null,
    resultType: "project",
    resultId: payload.clickedPageId,
    position: payload.position ?? 0,
    scope: "projects",
    query: payload.rawQuery ?? "",
  });
}

// --- click boost aggregation rows ---

type ClickAggRow = {
  clicked_page_id: string;
  position: number | null;
};

export default function ProjectsIndexClient() {
  const siteSettings = useSiteSettings();
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  const chipContainerRef = useRef<HTMLDivElement | null>(null);

  const [initializedFromUrl, setInitializedFromUrl] = useState(false);

  // Core query state: chips + current text fragment
  const [committedTerms, setCommittedTerms] = useState<string[]>([]);
  const [fragment, setFragment] = useState("");

  const [initialResults, setInitialResults] = useState<InfoSummary[]>([]);
  const [results, setResults] = useState<InfoSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [initialLoaded, setInitialLoaded] = useState(false);

  // How many results to show
  const [visibleCount, setVisibleCount] = useState(6);

  // "Did you mean …"
  const [suggestion, setSuggestion] = useState<string | null>(null);

  // For analytics: how many results actually matched (score > 0)
  const [lastMatchedCount, setLastMatchedCount] = useState<number | null>(null);

  // Click-based boost map: pageId -> bonus score
  const [clickBoosts, setClickBoosts] = useState<Record<string, number>>({});
  /** The search this page last recorded, so a click can be attributed to it. */
  const [searchEventId, setSearchEventId] = useState<string | null>(null);

  // NEW: site maintenance flag
  const [maintenanceMode, setMaintenanceMode] = useState(false);

  // NEW: only show "View my submissions" if logged in
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [canSubmitInfo, setCanSubmitInfo] = useState(false);

  // ✅ help popup (same as /community)
  const [helpOpen, setHelpOpen] = useState(false);


  const hasActiveQuery =
    committedTerms.length > 0 || fragment.trim().length > 0;

  // CHANGED: hide categories on ALL screen sizes when user starts typing / filtering
  const hideCategoriesWhenSearching = hasActiveQuery;

  // URL string version of the query (for ?q=)
  const urlQuery = useMemo(
    () =>
      [...committedTerms, fragment]
        .map((s) => s.trim())
        .filter(Boolean)
        .join(", "),
    [committedTerms, fragment]
  );

  // Tokens used for highlighting
  const searchTokens = useMemo(() => {
    const tokens: string[] = [];

    const addTokensFrom = (text: string) => {
      const trimmed = text.trim().toLowerCase();
      if (!trimmed) return;
      for (const part of trimmed.split(/\s+/)) {
        const p = part.trim();
        if (!p) continue;
        tokens.push(p);
      }
    };

    addTokensFrom(fragment);
    committedTerms.forEach((term) => addTokensFrom(term));

    return Array.from(new Set(tokens));
  }, [fragment, committedTerms]);

  // When query changes (chips or fragment), reset visibleCount
  useEffect(() => {
    setVisibleCount(6);
  }, [committedTerms, fragment, hasActiveQuery]);

  // Keep URL ?q= in sync
  useEffect(() => {
    if (!initializedFromUrl) return;

    const sp = new URLSearchParams(searchParams.toString());
    if (urlQuery.trim().length > 0) sp.set("q", urlQuery);
    else sp.delete("q");

    const qs = sp.toString();
    const next = qs ? `${pathname}?${qs}` : pathname;
    router.replace(next, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQuery, initializedFromUrl]);

  // Auth state (for "View my submissions")
  useEffect(() => {
    const supabase = supabaseBrowser();

    const loadCanSubmit = async () => {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData?.session?.access_token;
        if (!token) {
          setCanSubmitInfo(false);
          return;
        }
        const res = await fetch("/api/me/access", {
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => null);
        const json = await res?.json().catch(() => null);
        const perms = Array.isArray(json?.permissions) ? json.permissions : [];
        setCanSubmitInfo(perms.includes("info.submit"));
      } catch (e) {
        console.error("Failed to load permissions", e);
        setCanSubmitInfo(false);
      }
    };

    const init = async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        setIsLoggedIn(!!session);
        if (session) await loadCanSubmit();
        else setCanSubmitInfo(false);
      } catch (e) {
        console.error("Failed to check session", e);
        setIsLoggedIn(false);
        setCanSubmitInfo(false);
      }
    };

    void init();

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
      setIsLoggedIn(!!session);
      if (session) await loadCanSubmit();
      else setCanSubmitInfo(false);
    });

    return () => {
      sub.subscription.unsubscribe();
    };
  }, []);

  // Init from ?q= (once)
  useEffect(() => {
    if (initializedFromUrl) return;

    const qParam = searchParams.get("q");
    if (qParam && qParam.trim().length > 0) {
      const parts = qParam
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);

      if (parts.length === 1) {
        setCommittedTerms(parts);
        setFragment("");
      } else if (parts.length > 1) {
        const chips = parts.slice(0, parts.length - 1);
        const last = parts[parts.length - 1] ?? "";
        setCommittedTerms(chips);
        setFragment(last);
      }
    }

    setInitializedFromUrl(true);
  }, [searchParams, initializedFromUrl]);

  // Initial load: recent approved pages
  useEffect(() => {
    const loadInitial = async () => {
      setSearching(true);
      setSearchError(null);

      try {
        const supabase = supabaseBrowser();

        const { data, error } = await supabase
          .from("info_pages")
          .select(
            "id, title, slug, created_at, updated_at, status, content_markdown, tags"
          )
          .eq("status", "approved")
          .order("updated_at", { ascending: false })
          .limit(10);

        if (error) {
          console.error("Error loading initial info pages", error);
          setSearchError("Failed to load projects.");
        } else {
          const rows = (data ?? []) as RawInfoRow[];
          const summaries = rows.map(mapRowToSummary);
          setInitialResults(summaries);

          if (!hasActiveQuery) {
            setResults(summaries);
          }
        }
      } catch (e) {
        console.error("Unexpected error loading initial info pages", e);
        setSearchError("Unexpected error loading projects.");
      } finally {
        setSearching(false);
        setInitialLoaded(true);
      }
    };

    void loadInitial();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Click stats → clickBoosts
  useEffect(() => {
    const loadClickBoosts = async () => {
      try {
        const supabase = supabaseBrowser();
        const { data, error } = await supabase
          .from("info_search_click_events")
          .select("clicked_page_id, position")
          .limit(1000);

        if (error) {
          console.error("Failed to load click stats", error);
          return;
        }

        const rows = (data ?? []) as ClickAggRow[];

        /*
         * A bounded share of clicks, not an unbounded count.
         *
         * What was here computed `total * 4 + top3 * 3 + top1 * 3` with no
         * ceiling, against a textual scoring scheme whose whole range was about
         * thirty points. Eight clicks on one write-up therefore added more than
         * any query could earn by matching, and the arithmetic only ever ran one
         * way: the most-clicked result ranks first, ranking first earns more
         * clicks, and within a few weeks the same page is the top answer to
         * every query. That is precisely the runaway popularity loop this pass
         * was asked not to build, and it was already built.
         *
         * `clickBoost` replaces it with three defences — a minimum sample, a
         * ratio rather than a count, and a hard cap of `CLICK_BOOST_MAX` points
         * that is smaller than the gap between two relevance tiers. Behaviour
         * can now break a tie between comparable results and can never promote a
         * weak match over a strong one.
         *
         * The denominator is every click this page has recorded, so the ratio is
         * "of the choices customers made, what share went here" rather than a
         * true click-through rate. CTR needs impressions per result, which the
         * current tables cannot express — `docs/search-architecture.md` records
         * the migration that adds them.
         */
        const perPage = new Map<string, { clicks: number; positionTotal: number }>();
        let totalClicks = 0;

        for (const row of rows) {
          const pageId = row.clicked_page_id;
          if (!pageId) continue;
          const entry = perPage.get(pageId) ?? { clicks: 0, positionTotal: 0 };
          entry.clicks += 1;
          entry.positionTotal += Math.max(0, Math.min(row.position ?? 0, 200));
          perPage.set(pageId, entry);
          totalClicks += 1;
        }

        const boosts: Record<string, number> = {};
        for (const [pageId, entry] of perPage) {
          boosts[pageId] = clickBoost({
            impressions: totalClicks,
            clicks: entry.clicks,
            averagePosition: entry.clicks ? entry.positionTotal / entry.clicks : 0,
          });
        }

        setClickBoosts(boosts);
      } catch (e) {
        console.error("Failed to load click boosts", e);
      }
    };

    void loadClickBoosts();
  }, []);

  // All known tags (for suggestions)
  const allKnownTags = useMemo(() => {
    const set = new Set<string>();
    for (const row of initialResults) for (const t of row.tags || []) set.add(t);
    for (const row of results) for (const t of row.tags || []) set.add(t);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [initialResults, results]);

  const tagSuggestions = useMemo(() => {
    const frag = fragment.trim().toLowerCase();
    if (!frag) return [] as string[];

    return allKnownTags.filter((tag) => {
      const lower = tag.toLowerCase();
      return (
        !committedTerms.includes(tag) &&
        (lower.startsWith(frag) || lower.includes(frag))
      );
    });
  }, [allKnownTags, committedTerms, fragment]);

  // Maintenance flags
  useEffect(() => {
    const supabase = supabaseBrowser();

    const loadFlags = async () => {
      try {
        const { data, error } = await supabase.rpc("get_site_lockdown_flags");
        if (!error && data && data.length > 0) {
          const row = data[0] as { maintenance_mode: boolean };
          setMaintenanceMode(!!row.maintenance_mode);
        }
      } catch (e) {
        console.error("Failed to load maintenance flag", e);
      }
    };

    void loadFlags();
  }, []);

  // Search effect (FTS + local ranking + Did you mean + logging)
  useEffect(() => {
    if (!hasActiveQuery) {
      setSearchError(null);
      setSearching(false);
      setResults(initialResults);
      setSuggestion(null);
      setLastMatchedCount(null);
      return;
    }

    const timeout = setTimeout(() => {
      const runSearch = async () => {
        setSearching(true);
        setSearchError(null);
        setSuggestion(null);

        try {
          const supabase = supabaseBrowser();

          const rawQuery = [...committedTerms, fragment]
            .map((s) => s.trim())
            .filter(Boolean)
            .join(" ");

          const trimmedRaw = rawQuery.trim().toLowerCase();

          let rows: RawInfoRow[] = [];

          // 1) FTS path for normal queries
          if (trimmedRaw.length > 1) {
            const { data, error } = await supabase.rpc("search_info_pages", {
              q: rawQuery,
              limit_results: 100,
            });

            if (error) {
              console.error("Error searching info pages", error);
              setSearchError("Failed to search projects.");
              setResults([]);
              setLastMatchedCount(0);
              return;
            }

            const rpcRows = (data ?? []) as RawInfoRow[];

            if (rpcRows.length > 0) {
              const ids = rpcRows.map((r) => r.id);
              const { data: fullRows, error: fullErr } = await supabase
                .from("info_pages")
                .select(
                  "id, title, slug, created_at, updated_at, status, content_markdown, tags, category, chassis"
                )
                .in("id", ids);

              if (!fullErr && fullRows) {
                const fullMap = new Map<string, RawInfoRow>(
                  (fullRows as RawInfoRow[]).map((r) => [r.id, r])
                );
                rows = rpcRows.map((r) => fullMap.get(r.id) ?? r);
              } else {
                rows = rpcRows;
              }
            } else {
              rows = [];
            }
          }

          // 2) Fallback pool
          if (trimmedRaw.length <= 1 || rows.length < 5) {
            const { data: allRows, error: allErr } = await supabase
              .from("info_pages")
              .select(
                "id, title, slug, created_at, updated_at, status, content_markdown, tags, category, chassis"
              )
              .eq("status", "approved")
              .order("updated_at", { ascending: false })
              .limit(200);

            if (!allErr && allRows) {
              const all = allRows as RawInfoRow[];

              if (rows.length === 0) {
                rows = all;
              } else {
                const byId = new Map<string, RawInfoRow>();
                for (const r of all) byId.set(r.id, r);

                const merged: RawInfoRow[] = [];
                for (const r of rows) merged.push(byId.get(r.id) ?? r);
                for (const r of all) {
                  if (!merged.some((x) => x.id === r.id)) merged.push(r);
                }
                rows = merged;
              }
            }
          }

          // 3) Did you mean (last token)
          const pieces = [...committedTerms, fragment]
            .map((s) => s.trim())
            .filter(Boolean);

          if (pieces.length === 0 || rows.length === 0) {
            setSuggestion(null);
          } else {
            const lastTokenParts = pieces[pieces.length - 1]
              .split(/\s+/)
              .filter(Boolean);
            const lastToken =
              lastTokenParts[lastTokenParts.length - 1]?.toLowerCase() ?? "";

            if (!lastToken) {
              setSuggestion(null);
            } else {
              const candidateSet = new Set<string>();
              for (const row of rows) {
                if (row.title) candidateSet.add(row.title);
                if (row.slug) candidateSet.add(row.slug);
                if (row.category) candidateSet.add(row.category);
                if (row.chassis) candidateSet.add(row.chassis);
                for (const t of row.tags ?? []) candidateSet.add(t);
              }

              const candidates = Array.from(candidateSet);
              const candidatesLower = candidates.map((c) => c.toLowerCase());

              if (candidatesLower.includes(lastToken)) {
                setSuggestion(null);
              } else {
                let bestTerm: string | null = null;
                let bestSim = 0;

                for (let i = 0; i < candidates.length; i++) {
                  const term = candidates[i];
                  const termLower = candidatesLower[i];
                  const sim = normalizedSimilarity(lastToken, termLower);
                  if (sim > bestSim) {
                    bestSim = sim;
                    bestTerm = term;
                  }
                }

                setSuggestion(bestTerm && bestSim >= 0.2 ? bestTerm : null);
              }
            }
          }

          // 4) Local scoring / ranking + click boost + logging
          const textTokens: string[] = [];
          const tagTokens: string[] = [];

          const addTokensFrom = (text: string, target: string[]) => {
            const trimmed = text.trim().toLowerCase();
            if (!trimmed) return;
            for (const part of trimmed.split(/\s+/)) {
              const p = part.trim();
              if (!p) continue;
              target.push(p);
            }
          };

          addTokensFrom(fragment, textTokens);
          committedTerms.forEach((term) => addTokensFrom(term, tagTokens));

          type Annotated = {
            row: RawInfoRow;
            score: number;
            matchedTokens: number;
          };

          const annotated: Annotated[] = rows.map((row) => {
            const title = (row.title ?? "").toLowerCase();
            const slug = (row.slug ?? "").toLowerCase();
            const content = (row.content_markdown ?? "").toLowerCase();

            const tagsArray = [
              ...(row.tags ?? []),
              row.category ?? "",
              row.chassis ?? "",
            ]
              .filter(Boolean)
              .map((t) => t.toLowerCase());

            let score = 0;
            let matchedTextTokens = 0;
            let matchedTagTokens = 0;

            const scoreToken = (
              token: string,
              weights: {
                title: number;
                slug: number;
                tag: number;
                content: number;
                max: number;
              }
            ): boolean => {
              let tokenScore = 0;
              let matched = false;

              if (title.includes(token)) {
                tokenScore += weights.title;
                matched = true;
              }
              if (slug.includes(token)) {
                tokenScore += weights.slug;
                matched = true;
              }
              if (tagsArray.some((tag) => tag.includes(token))) {
                tokenScore += weights.tag;
                matched = true;
              }
              if (content.includes(token)) {
                tokenScore += weights.content;
                matched = true;
              }

              if (tokenScore > weights.max) tokenScore = weights.max;
              if (matched) score += tokenScore;

              return matched;
            };

            for (const token of textTokens) {
              const matched = scoreToken(token, {
                title: 12,
                slug: 8,
                tag: 10,
                content: 4,
                max: 18,
              });
              if (matched) matchedTextTokens += 1;
            }

            for (const token of tagTokens) {
              const matched = scoreToken(token, {
                title: 6,
                slug: 5,
                tag: 15,
                content: 3,
                max: 20,
              });
              if (matched) matchedTagTokens += 1;
            }

            const totalMatchedTokens = matchedTextTokens + matchedTagTokens;

            score += totalMatchedTokens * 20;

            const updatedTime = new Date(
              row.updated_at || row.created_at
            ).getTime();
            score += updatedTime / 1000_000_000_000;

            score += clickBoosts[row.id] ?? 0;

            return { row, score, matchedTokens: totalMatchedTokens };
          });

          const finalAnnotated = annotated.sort((a, b) => b.score - a.score);

          const finalResults = finalAnnotated.map((entry) =>
            mapRowToSummary(entry.row)
          );
          setResults(finalResults);

          const matchedAnnotated = finalAnnotated.filter(
            (entry) => entry.matchedTokens > 0
          );
          setLastMatchedCount(matchedAnnotated.length);

          const tokensForLog = Array.from(new Set([...textTokens, ...tagTokens]));
          const topMatched = matchedAnnotated[0];

          if (rawQuery.trim().length > 0) {
            // The id is kept so a click on one of these results can name the
            // search that produced it, which is what turns two event streams
            // into a click-through rate.
            void logInfoSearchEvent({
              source: "info-index",
              rawQuery,
              tokens: tokensForLog,
              resultsCount: matchedAnnotated.length,
              topResultId: topMatched?.row.id ?? null,
              topResultSlug: topMatched?.row.slug ?? null,
            }).then((id) => setSearchEventId(id));
          }
        } catch (e) {
          console.error("Unexpected error searching info pages", e);
          setSearchError("Unexpected error searching projects.");
          setResults([]);
          setLastMatchedCount(0);
        } finally {
          setSearching(false);
        }
      };

      void runSearch();
    }, 250);

    return () => clearTimeout(timeout);
  }, [initialResults, committedTerms, fragment, hasActiveQuery, clickBoosts]);

  // --- helpers for chip behavior ---

  const scrollChipsToBottom = () => {
    const el = chipContainerRef.current;
    if (!el) return;
    setTimeout(() => {
      el.scrollTop = el.scrollHeight;
    }, 0);
  };

  const commitFragmentAsChip = () => {
    const raw = fragment.trim();
    if (!raw) return;

    setCommittedTerms((prev) => {
      if (prev.includes(raw)) return prev;
      return [...prev, raw];
    });
    setFragment("");
    scrollChipsToBottom();
  };

  const handleRemoveTerm = (term: string) => {
    setCommittedTerms((prev) => prev.filter((t) => t !== term));
  };

  const handleApplySuggestionChip = (tag: string) => {
    setCommittedTerms((prev) => {
      if (prev.includes(tag)) return prev;
      return [...prev, tag];
    });
    setFragment("");
    scrollChipsToBottom();
  };

  const visibleResults = useMemo(
    () => results.slice(0, visibleCount),
    [results, visibleCount]
  );

  return (
    <div className="content-hub">
      {/* Header + search */}
      <section className="content-hero space-y-4">
        {/* ✅ Title row with EXACT same ? button placement/style as /community */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">
              Project hub
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-brand-text sm:text-3xl">
              {siteSettings.shortName} Projects
            </h1>
            <p className="mt-1 text-[12px] text-brand-textMuted sm:text-sm">
              Explore builds from first idea to finished result, including designs,
              decisions, files, progress, and lessons learned.
            </p>
          </div>

          {/* ? Help button (COPIED 1:1 from /community) */}
          <button
            type="button"
            onClick={() => setHelpOpen((v) => !v)}
            className="ui-btn ui-btn-ghost mt-0.5 h-9 w-9 shrink-0 !p-0 text-sm"
            aria-label="Search help"
            title="Search help"
          >
            ?
          </button>
        </div>

        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          {/* Search bar with chips INSIDE */}
          <div className="flex-1 min-w-0">
            <div
              ref={chipContainerRef}
              className="content-search flex max-h-24 cursor-text flex-wrap items-center gap-1 overflow-y-auto scrollbar-thin scrollbar-track-black/40 scrollbar-thumb-zinc-700/80"
              onClick={() => {
                const el = document.getElementById(
                  "infosearch-input"
                ) as HTMLInputElement | null;
                el?.focus();
              }}
            >
              {/*
                The same icon the navbar's search field draws, from the same
                source — and now from the same *component*, because this file
                was corrected on its own and the nested category route was not.
                See `SearchFieldIcon` for what the copies had drifted into.
              */}
              <SearchFieldIcon />

              {committedTerms.map((term) => (
                <button
                  key={term}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemoveTerm(term);
                  }}
                  className="inline-flex items-center gap-1 rounded-full border border-amber-400/60 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200 transition-transform hover:-translate-y-[1px] hover:bg-amber-500/20"
                >
                  <span>{term}</span>
                  <span className="text-[10px]">×</span>
                </button>
              ))}

              <input
                id="infosearch-input"
                type="text"
                value={fragment}
                onChange={(e) => {
                  const value = e.target.value;

                  // comma commits fragment as chip
                  if (value.endsWith(",")) {
                    const trimmed = value.slice(0, -1).trim();
                    if (trimmed.length > 0) {
                      setCommittedTerms((prev) =>
                        prev.includes(trimmed) ? prev : [...prev, trimmed]
                      );
                      setFragment("");
                      scrollChipsToBottom();
                      return;
                    }
                    setFragment("");
                    return;
                  }

                  setFragment(value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitFragmentAsChip();
                    return;
                  }

                  if (
                    e.key === "Backspace" &&
                    fragment.length === 0 &&
                    committedTerms.length > 0
                  ) {
                    e.preventDefault();
                    setCommittedTerms((prev) => prev.slice(0, -1));
                    scrollChipsToBottom();
                  }
                }}
                placeholder="Search projects… (e.g. cnc, enclosure, prototype)"
                className="min-w-[120px] no-zoom-input flex-1 bg-transparent text-sm text-brand-text outline-none placeholder:text-zinc-500"
              />
            </div>

            {/* Tag suggestions */}
            {tagSuggestions.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {tagSuggestions.slice(0, 12).map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => handleApplySuggestionChip(tag)}
                    className="rounded-full border border-zinc-700 bg-black/60 px-2 py-0.5 text-[11px] text-brand-textMuted hover:border-amber-400/80 hover:text-brand-text"
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}

            {/* Did you mean */}
            {suggestion && (
              <button
                type="button"
                onClick={() => {
                  setCommittedTerms([]);
                  setFragment(suggestion);
                }}
                className="mt-1 inline-flex items-center gap-1 rounded-full border border-amber-400/80 bg-amber-500/20 px-2 py-0.5 text-[11px] text-amber-200 hover:bg-amber-500/30 hover:border-amber-300/90"
              >
                <span className="text-[11px]">Did you mean:</span>
                <span className="font-medium">{suggestion}</span>
                <span className="text-[10px]">↵</span>
              </button>
            )}

            {hasActiveQuery ? (
              <p className="mt-1 text-[11px] text-brand-textMuted">
                Filtering by:{" "}
                {[...committedTerms, fragment]
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .join(", ")}
              </p>
            ) : (
              <p className="mt-1 text-[11px] text-brand-textMuted">
                Searching published projects. Use commas to combine topics like{" "}
                <code>cnc, enclosure</code>.
              </p>
            )}
          </div>

          {/* Contribute buttons */}
          <div className="mt-1 flex justify-end md:mt-0 md:items-start">
            <div className="flex flex-col items-end gap-1">
              <div className="flex flex-wrap items-center justify-end gap-2">
                {canSubmitInfo && (
                  maintenanceMode ? (
                    <span className="inline-flex items-center justify-center rounded-full border border-zinc-700 bg-black/40 px-4 py-2 text-[12px] font-medium text-zinc-500 cursor-not-allowed">
                      Submit a project (disabled)
                    </span>
                  ) : (
                    <InfoCtaButton href="/projects/submit" variant="primary">
                      Submit a project
                    </InfoCtaButton>
                  )
                )}

                {canSubmitInfo && (
                  <InfoCtaButton href="/projects/mine" variant="secondary">
                    My project submissions
                  </InfoCtaButton>
                )}
              </div>

              {maintenanceMode && (
                <p className="text-[10px] text-amber-200/80">
                  Submissions are temporarily disabled while the site is in
                  maintenance mode.
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Help popup (COPIED wrapper/style 1:1 from /community, info-specific copy) */}
      {helpOpen ? (
        <SearchHelpDialog
          open={helpOpen}
          onClose={() => setHelpOpen(false)}
          eyebrow="Project search help"
          title="Find the right project fast"
          intro=" to rank projects by relevance. The closest matches rise to the top as you add detail."
          examples={["cnc", "enclosure", "aluminum"]}
          exampleQuery="cnc, enclosure, aluminum"
          matchFields={["project title", "tags", "slug", "category", "platform"]}
        />
      ) : null}

      {/* Categories (hide on ALL screen sizes when typing/filtering) */}
      <section className={(hideCategoriesWhenSearching ? "hidden " : "") + "space-y-3"}>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-brand-textMuted">
          Project categories
        </h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {CATEGORIES.map((cat) => (
            <Link
              key={cat.slug}
              href={`/projects/category/${cat.slug}`}
              className="content-grid-card group text-sm text-brand-text"
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <h3 className="text-[13px] font-semibold text-brand-text">
                  {cat.name}
                </h3>
                <span className="text-[11px] text-brand-textMuted group-hover:text-amber-300">
                  View →
                </span>
              </div>
              <p className="text-[12px] text-brand-textMuted">
                {cat.description}
              </p>
            </Link>
          ))}
        </div>
      </section>

      {/* Search results / recent pages */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-brand-textMuted">
              {hasActiveQuery ? "Project results" : "Recently updated projects"}
            </h2>
            {results.length > 0 && (
              <p className="text-[11px] text-brand-textMuted">
                Showing {visibleResults.length} of {results.length} result
                {results.length === 1 ? "" : "s"}
              </p>
            )}
          </div>
          {searching && (
            <span className="text-[11px] text-brand-textMuted">Searching…</span>
          )}
        </div>

        {searchError && (
          <p className="text-[12px] text-rose-300/80">{searchError}</p>
        )}

        {results.length === 0 && !searchError && initialLoaded && (
          <p className="text-[12px] text-brand-textMuted">
            No projects found yet.
          </p>
        )}

        {visibleResults.length > 0 && (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              {visibleResults.map((page, index) => {
                const updated = page.updated_at || page.created_at;
                const updatedLabel = new Date(updated).toLocaleDateString();

                const globalIndex = results.findIndex((r) => r.id === page.id);

                return (
                  <Link
                    key={page.id}
                    href={`/projects/${page.slug}`}
                    onClick={() => {
                      const rawQuery = [...committedTerms, fragment]
                        .map((s) => s.trim())
                        .filter(Boolean)
                        .join(" ")
                        .trim();

                      logInfoSearchClick({
                        source: "info-index",
                        rawQuery,
                        tokens: searchTokens,
                        clickedPageId: page.id,
                        clickedPageSlug: page.slug,
                        position: globalIndex >= 0 ? globalIndex : index,
                        resultsCount: lastMatchedCount ?? results.length,
                        searchEventId,
                        meta: {
                          committed_terms: committedTerms,
                          fragment,
                        },
                      });
                    }}
                    className="content-grid-card text-sm text-brand-text"
                  >
                    <h3 className="mb-1 text-[13px] font-semibold text-brand-text">
                      {highlightText(page.title, searchTokens)}
                    </h3>
                    <p className="text-[11px] text-brand-textMuted">
                      Last updated {updatedLabel}
                    </p>

                    {Array.isArray(page.tags) && page.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {page.tags.slice(0, 4).map((tag) => (
                          <span
                            key={`${page.id}-${tag}`}
                            className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[10px] text-brand-textMuted"
                          >
                            {highlightText(tag, searchTokens)}
                          </span>
                        ))}
                        {page.tags.length > 4 && (
                          <span className="text-[10px] text-brand-textMuted">
                            +{page.tags.length - 4} more
                          </span>
                        )}
                      </div>
                    )}
                  </Link>
                );
              })}
            </div>

            {results.length > visibleCount && (
              <div className="mt-3 flex justify-center">
                <button
                  type="button"
                  onClick={() => setVisibleCount((prev) => prev + 6)}
                  className="ui-btn ui-btn-secondary text-[12px]"
                >
                  Show more ({Math.min(results.length - visibleCount, 6)} more)
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
