"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";

type InfoPageSearch = {
  id: string;
  title: string;
  slug: string;
  status: string;
  created_at: string;
  updated_at?: string | null;
  content_markdown?: string | null;
  tags?: string[] | null;
  category?: string | null;
  chassis?: string | null;
};

type ForumCategoryRow = {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  is_archived: boolean;
  created_at: string;
};

type ForumThreadRow = {
  id: number;
  category_id: number;
  title: string;
  slug: string;
  created_at: string;
  updated_at: string | null;
  created_by: string;
  last_post_at: string | null;
  last_post_by: string | null;
  reply_count: number;
  view_count: number;
  is_locked: boolean;
  is_pinned: boolean;
  is_deleted: boolean;
};

type SearchItem =
  | {
      kind: "info";
      id: string;
      title: string;
      slug: string;
      created_at: string;
      updated_at?: string | null;
      tags?: string[] | null;
      category?: string | null;
      chassis?: string | null;
      content_markdown?: string | null;
      _raw: InfoPageSearch;
    }
  | {
      kind: "forum-thread";
      id: string; // stringified
      slug: string; // thread slug
      title: string;
      categorySlug: string;
      categoryName: string;
      created_at: string;
      updated_at: string | null;
      last_post_at: string | null;
      reply_count: number;
      view_count: number;
      is_locked: boolean;
      is_pinned: boolean;
      _raw: ForumThreadRow;
    };

function notNull<T>(v: T | null | undefined): v is T {
  return v != null;
}

// --- fuzzy helpers ---

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
    const si = s[i - 1];
    for (let j = 1; j <= n; j++) {
      const tj = t[j - 1];
      const cost = si === tj ? 0 : 1;
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

// includes + fuzzy for TEXT tokens
function fieldMatchesToken(field: string, token: string): boolean {
  const f = field.toLowerCase();
  const t = token.toLowerCase();
  if (!f || !t) return false;

  if (f.includes(t)) return true;

  const parts = f.split(/\s+/);
  for (const part of parts) {
    if (!part) continue;
    const lenDiff = Math.abs(part.length - t.length);
    if (lenDiff > 1) continue;
    const sim = normalizedSimilarity(part, t);
    if (sim >= 0.7) return true;
  }

  return false;
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
          className="rounded-[3px] bg-amber-500/20 px-0.5 text-amber-300"
        >
          {part}
        </span>
      );
    }

    return <span key={idx}>{part}</span>;
  });
}

// --- logging helper: search events (info only, unchanged) ---

type SearchLogPayload = {
  source: "command-palette";
  rawQuery: string;
  tokens: string[];
  resultsCount: number;
  topResultId?: string | null;
  topResultSlug?: string | null;
};

async function logSearchEvent(payload: SearchLogPayload): Promise<void> {
  try {
    const supabase = supabaseBrowser();
    await supabase.from("info_search_events").insert({
      source: payload.source,
      raw_query: payload.rawQuery,
      tokens: payload.tokens,
      results_count: payload.resultsCount,
      top_result_id: payload.topResultId ?? null,
      top_result_slug: payload.topResultSlug ?? null,
    });
  } catch (err: unknown) {
    console.error("Failed to log command palette search event", err);
  }
}

// --- logging helper for click events (info only, unchanged) ---

type InfoSearchClickPayload = {
  source: "command-palette";
  rawQuery?: string;
  tokens?: string[];
  clickedPageId: string;
  clickedPageSlug: string;
  position?: number;
  resultsCount?: number;
  meta?: Record<string, unknown>;
};

async function logInfoSearchClick(
  payload: InfoSearchClickPayload
): Promise<void> {
  try {
    const supabase = supabaseBrowser();
    const { error } = await supabase.from("info_search_click_events").insert({
      source: payload.source,
      raw_query: payload.rawQuery ?? null,
      tokens: payload.tokens ?? null,
      clicked_page_id: payload.clickedPageId,
      clicked_page_slug: payload.clickedPageSlug,
      position: payload.position ?? null,
      results_count: payload.resultsCount ?? null,
      meta: payload.meta ?? null,
    });

    if (error) {
      console.error("Failed to log info search click event", error);
    }
  } catch (err) {
    console.error("Failed to log info search click event", err);
  }
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);

  // mobile detector
  const [isMobile, setIsMobile] = useState(false);

  // help popup
  const [helpOpen, setHelpOpen] = useState(false);
  const helpRef = useRef<HTMLDivElement | null>(null);

  // chip-style query state
  const [committedTerms, setCommittedTerms] = useState<string[]>([]);
  const [fragment, setFragment] = useState("");

  const [loading, setLoading] = useState(false);

  // info data
  const [allPagesLoaded, setAllPagesLoaded] = useState(false);
  const [allPages, setAllPages] = useState<InfoPageSearch[]>([]);

  // forum lookup + threads
  const [allForumsLoaded, setAllForumsLoaded] = useState(false);
  const [forumCategoryById, setForumCategoryById] = useState<
    Map<number, ForumCategoryRow>
  >(new Map());
  const [allForumThreads, setAllForumThreads] = useState<ForumThreadRow[]>([]);

  // results
  const [results, setResults] = useState<SearchItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(5);
  const [suggestion, setSuggestion] = useState<string | null>(null);

  // how many actually matched tokens (for analytics)
  const [matchedResultsCount, setMatchedResultsCount] = useState(0);

  const router = useRouter();
  const chipContainerRef = useRef<HTMLDivElement | null>(null);

  const hasActiveQuery =
    committedTerms.length > 0 || fragment.trim().length > 0;

  // mobile detection (sm breakpoint)
  useEffect(() => {
    if (typeof window === "undefined") return;

    const mq = window.matchMedia("(max-width: 640px)");

    const apply = () => setIsMobile(mq.matches);
    apply();

    // Safari < 14 fallback
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }

    mq.addListener(apply);
    return () => mq.removeListener(apply);
  }, []);

  // close help on outside click
  useEffect(() => {
    if (!open || !helpOpen) return;

    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (helpRef.current && !helpRef.current.contains(target)) {
        setHelpOpen(false);
      }
    };

    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, helpOpen]);

  // tokens for highlighting
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

  // keyboard & global trigger
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
        setHelpOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("open-command-palette", onOpen as EventListener);
    return () =>
      window.removeEventListener("open-command-palette", onOpen as EventListener);
  }, []);

  useEffect(() => {
    if (!open) return;
    setVisibleCount(4);
    setHelpOpen(false);
  }, [open]);

  // load all approved info pages once
  useEffect(() => {
    if (!open || allPagesLoaded) return;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const supabase = supabaseBrowser();

        const { data, error } = await supabase
          .from("info_pages")
          .select(
            "id, title, slug, status, created_at, updated_at, content_markdown, tags, category, chassis"
          )
          .eq("status", "approved");

        if (error) {
          console.error("Command palette load error", error);
          setError("Failed to load info pages.");
          setAllPages([]);
        } else {
          setAllPages((data ?? []) as InfoPageSearch[]);
          setAllPagesLoaded(true);
        }
      } catch (e) {
        console.error("Command palette load error", e);
        setError("Failed to load info pages.");
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [open, allPagesLoaded]);

  // load forum categories (lookup only) + threads once
  useEffect(() => {
    if (!open || allForumsLoaded) return;

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const supabase = supabaseBrowser();

        const [
          { data: catData, error: catErr },
          { data: threadData, error: thErr },
        ] = await Promise.all([
          supabase
            .from("forum_categories")
            .select("id, slug, name, description, is_archived, created_at")
            .eq("is_archived", false),
          supabase
            .from("forum_threads")
            .select(
              "id, category_id, title, slug, created_at, updated_at, created_by, last_post_at, last_post_by, reply_count, view_count, is_locked, is_pinned, is_deleted"
            )
            .eq("is_deleted", false)
            .order("last_post_at", { ascending: false, nullsFirst: false }),
        ]);

        if (catErr) console.error("Command palette forum categories load error", catErr);
        if (thErr) console.error("Command palette forum threads load error", thErr);

        const byId = new Map<number, ForumCategoryRow>();
        for (const c of (catData ?? []) as ForumCategoryRow[]) byId.set(c.id, c);

        setForumCategoryById(byId);
        setAllForumThreads((threadData ?? []) as ForumThreadRow[]);
        setAllForumsLoaded(true);
      } catch (e) {
        console.error("Command palette forum load error", e);
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [open, allForumsLoaded]);

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
    setCommittedTerms((prev) => (prev.includes(raw) ? prev : [...prev, raw]));
    setFragment("");
    scrollChipsToBottom();
  };

  const handleRemoveTerm = (term: string) => {
    setCommittedTerms((prev) => prev.filter((t) => t !== term));
  };

  // build combined dataset (INFO + FORUM THREADS ONLY)
  const combinedItems = useMemo((): SearchItem[] => {
    const infoItems: SearchItem[] = allPages.map((p) => ({
      kind: "info",
      id: p.id,
      title: p.title,
      slug: p.slug,
      created_at: p.created_at,
      updated_at: p.updated_at ?? null,
      tags: p.tags ?? null,
      category: p.category ?? null,
      chassis: p.chassis ?? null,
      content_markdown: p.content_markdown ?? null,
      _raw: p,
    }));

    const forumThreadItems: SearchItem[] = allForumThreads
      .map((t): SearchItem | null => {
        const c = forumCategoryById.get(t.category_id);
        if (!c) return null;

        const threadItem: SearchItem = {
          kind: "forum-thread",
          id: String(t.id),
          slug: t.slug,
          title: t.title,
          categorySlug: c.slug,
          categoryName: c.name,
          created_at: t.created_at,
          updated_at: t.updated_at ?? null,
          last_post_at: t.last_post_at ?? null,
          reply_count: t.reply_count,
          view_count: t.view_count,
          is_locked: t.is_locked,
          is_pinned: t.is_pinned,
          _raw: t,
        };

        return threadItem;
      })
      .filter(notNull);

    return [...infoItems, ...forumThreadItems];
  }, [allPages, allForumThreads, forumCategoryById]);

  // local fuzzy ranking + suggestion + logging (info analytics still based on info matches)
  useEffect(() => {
    if (!open) return;
    if (!allPagesLoaded || !allForumsLoaded) return;

    setLoading(true);
    setError(null);
    setSuggestion(null);

    const timeout = setTimeout(() => {
      try {
        const textTokens: string[] = [];
        const chipTokens: string[] = [];

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
        committedTerms.forEach((term) => addTokensFrom(term, chipTokens));

        const rawQuery = [...committedTerms, fragment]
          .map((s) => s.trim())
          .filter(Boolean)
          .join(" ")
          .trim();

        // No query → show recent-ish (threads by last_post_at, info by updated)
        // No query → show Info first, then Forum (still "recent-ish" within each group)
        if (!hasActiveQuery) {
          const ranked = [...combinedItems].sort((a, b) => {
            // ✅ hard-prioritize info on initial open
            if (a.kind !== b.kind) return a.kind === "info" ? -1 : 1;

            const aTime =
              a.kind === "forum-thread"
                ? new Date(a.last_post_at || a.updated_at || a.created_at).getTime()
                : new Date(a.updated_at || a.created_at).getTime();

            const bTime =
              b.kind === "forum-thread"
                ? new Date(b.last_post_at || b.updated_at || b.created_at).getTime()
                : new Date(b.updated_at || b.created_at).getTime();

            return bTime - aTime;
          });

          setResults(ranked);
          setMatchedResultsCount(0);
          setLoading(false);
          return;
        }

        type Annotated = {
          item: SearchItem;
          score: number;
          matchedTokens: number;
        };

        const annotated: Annotated[] = combinedItems.map((item) => {
          let score = 0;
          let matchedTextTokens = 0;
          let matchedChipTokens = 0;

          const addRecencyBoost = (dateStr: string | null | undefined) => {
            const t = dateStr ? new Date(dateStr).getTime() : 0;
            if (!t) return;
            score += t / 1000_000_000_000; // tiny
          };

          const scoreTextToken = (token: string): boolean => {
            let tokenScore = 0;
            let matched = false;

            if (item.kind === "info") {
              const title = (item.title ?? "").toLowerCase();
              const slug = (item.slug ?? "").toLowerCase();
              const content = (item.content_markdown ?? "").toLowerCase();
              const category = (item.category ?? "").toLowerCase();
              const chassis = (item.chassis ?? "").toLowerCase();
              const tagStrings = (item.tags ?? [])
                .map((t) => t.toLowerCase())
                .filter(Boolean);

              if (fieldMatchesToken(title, token)) {
                tokenScore += 12;
                matched = true;
              }
              if (fieldMatchesToken(slug, token)) {
                tokenScore += 8;
                matched = true;
              }
              if (tagStrings.some((tag) => fieldMatchesToken(tag, token))) {
                tokenScore += 10;
                matched = true;
              }
              if (fieldMatchesToken(chassis, token)) {
                tokenScore += 7;
                matched = true;
              }
              if (fieldMatchesToken(category, token)) {
                tokenScore += 6;
                matched = true;
              }
              if (fieldMatchesToken(content, token)) {
                tokenScore += 4;
                matched = true;
              }
            }

            if (item.kind === "forum-thread") {
              const title = (item.title ?? "").toLowerCase();
              const slug = (item.slug ?? "").toLowerCase();
              const cat = (item.categoryName ?? "").toLowerCase();
              const catSlug = (item.categorySlug ?? "").toLowerCase();

              if (fieldMatchesToken(title, token)) {
                tokenScore += 12;
                matched = true;
              }
              if (fieldMatchesToken(slug, token)) {
                tokenScore += 7;
                matched = true;
              }
              if (fieldMatchesToken(cat, token) || fieldMatchesToken(catSlug, token)) {
                tokenScore += 6;
                matched = true;
              }
            }

            if (tokenScore > 20) tokenScore = 20;
            if (matched) score += tokenScore;
            return matched;
          };

          const scoreChipToken = (token: string): boolean => {
            let tokenScore = 0;
            let matched = false;
            const t = token.toLowerCase();

            if (item.kind === "info") {
              const tags = (item.tags ?? []).map((x) => x.toLowerCase());
              const chassis = (item.chassis ?? "").toLowerCase();
              const category = (item.category ?? "").toLowerCase();
              const slug = (item.slug ?? "").toLowerCase();
              const fullPath = `/info/${slug}`;

              if (tags.some((tag) => tag.includes(t))) {
                tokenScore += 18;
                matched = true;
              }
              if (chassis && chassis.includes(t)) {
                tokenScore += 18;
                matched = true;
              }
              if (category && category.includes(t)) {
                tokenScore += 16;
                matched = true;
              }
              if (slug.includes(t) || fullPath.includes(t)) {
                tokenScore += 20;
                matched = true;
              }
            }

            if (item.kind === "forum-thread") {
              const title = (item.title ?? "").toLowerCase();
              const slug = (item.slug ?? "").toLowerCase();
              const cat = (item.categoryName ?? "").toLowerCase();
              const catSlug = (item.categorySlug ?? "").toLowerCase();
              const fullPath = `/community/${catSlug}/${slug}`;

              if (title.includes(t)) {
                tokenScore += 18;
                matched = true;
              }
              if (cat.includes(t)) {
                tokenScore += 16;
                matched = true;
              }
              if (slug.includes(t) || catSlug.includes(t)) {
                tokenScore += 18;
                matched = true;
              }
              if (fullPath.includes(t)) {
                tokenScore += 20;
                matched = true;
              }
            }

            if (tokenScore > 24) tokenScore = 24;
            if (matched) score += tokenScore;
            return matched;
          };

          for (const token of textTokens) {
            const matched = scoreTextToken(token);
            if (matched) matchedTextTokens += 1;
          }

          for (const token of chipTokens) {
            const matched = scoreChipToken(token);
            if (matched) matchedChipTokens += 1;
          }

          const totalMatchedTokens = matchedTextTokens + matchedChipTokens;
          score += totalMatchedTokens * 20;

          // small boosts
          if (item.kind === "forum-thread") {
            score += Math.min(item.reply_count, 50) * 0.15;
            if (item.is_pinned) score += 2;
            addRecencyBoost(item.last_post_at || item.updated_at || item.created_at);
          } else {
            addRecencyBoost(item.updated_at || item.created_at);
          }

          return { item, score, matchedTokens: totalMatchedTokens };
        });

        annotated.sort((a, b) => b.score - a.score);
        const ranked = annotated.map((a) => a.item);
        setResults(ranked);

        const matchedAnnotated = annotated.filter((a) => a.matchedTokens > 0);
        setMatchedResultsCount(matchedAnnotated.length);

        // info-only analytics
        if (rawQuery.length > 0) {
          const tokensForLog = Array.from(new Set([...textTokens, ...chipTokens]));
          const topInfo = matchedAnnotated.find((x) => x.item.kind === "info");
          void logSearchEvent({
            source: "command-palette",
            rawQuery,
            tokens: tokensForLog,
            resultsCount: matchedAnnotated.length,
            topResultId: topInfo && topInfo.item.kind === "info" ? topInfo.item.id : null,
            topResultSlug: topInfo && topInfo.item.kind === "info" ? topInfo.item.slug : null,
          });
        }

        // "Did you mean" across site (last token only)
        const pieces = [...committedTerms, fragment].map((s) => s.trim()).filter(Boolean);

        if (pieces.length === 0 || combinedItems.length === 0) {
          setSuggestion(null);
          setLoading(false);
          return;
        }

        const lastToken = pieces[pieces.length - 1]
          .split(/\s+/)
          .filter(Boolean)
          .slice(-1)[0]
          .toLowerCase();

        if (!lastToken) {
          setSuggestion(null);
          setLoading(false);
          return;
        }

        const candidateSet = new Set<string>();

        for (const it of combinedItems) {
          if (it.kind === "info") {
            candidateSet.add(it.title);
            candidateSet.add(it.slug);
            if (it.category) candidateSet.add(it.category);
            if (it.chassis) candidateSet.add(it.chassis);
            for (const t of it.tags ?? []) candidateSet.add(t);
          } else {
            // forum-thread
            candidateSet.add(it.title);
            candidateSet.add(it.slug);
            candidateSet.add(it.categoryName);
            candidateSet.add(it.categorySlug);
          }
        }

        const candidates = Array.from(candidateSet);
        const candidatesLower = candidates.map((c) => c.toLowerCase());

        if (candidatesLower.includes(lastToken)) {
          setSuggestion(null);
          setLoading(false);
          return;
        }

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

        if (bestTerm && bestSim >= 0.2) setSuggestion(bestTerm);
        else setSuggestion(null);

        setLoading(false);
      } catch (e) {
        console.error("Command palette search error", e);
        setError("Unexpected error searching.");
        setResults([]);
        setSuggestion(null);
        setMatchedResultsCount(0);
        setLoading(false);
      }
    }, 200);

    return () => clearTimeout(timeout);
  }, [
    open,
    allPagesLoaded,
    allForumsLoaded,
    combinedItems,
    committedTerms,
    fragment,
    hasActiveQuery,
  ]);

  const handleSelect = (item: SearchItem) => {
    const rawQuery = [...committedTerms, fragment]
      .map((s) => s.trim())
      .filter(Boolean)
      .join(" ")
      .trim();

    const position = results.findIndex((p) => p.id === item.id && p.kind === item.kind);
    const effectiveResultsCount = rawQuery.length > 0 ? matchedResultsCount : undefined;

    setOpen(false);
    setHelpOpen(false);

    if (item.kind === "info") {
      void logInfoSearchClick({
        source: "command-palette",
        rawQuery,
        tokens: searchTokens,
        clickedPageId: item.id,
        clickedPageSlug: item.slug,
        position: position >= 0 ? position : undefined,
        resultsCount: effectiveResultsCount,
        meta: { committed_terms: committedTerms, fragment },
      });

      router.push(`/info/${item.slug}`);
      return;
    }

    router.push(`/community/${item.categorySlug}/${item.slug}`);
  };

  const handleApplySuggestion = () => {
    if (!suggestion) return;
    setCommittedTerms([]);
    setFragment(suggestion);
    setSuggestion(null);
  };

  const visibleResults = useMemo(
    () => results.slice(0, visibleCount),
    [results, visibleCount]
  );

  const visibleInfo = useMemo(
    () => visibleResults.filter((r) => r.kind === "info"),
    [visibleResults]
  );

  const visibleForumThreads = useMemo(
    () => visibleResults.filter((r) => r.kind === "forum-thread"),
    [visibleResults]
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/60 px-4 pt-24">
      <div className="w-full max-w-xl rounded-xl border border-zinc-800 bg-brand-bgStart/95 shadow-xl backdrop-blur">
        <div className="border-b border-zinc-800 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-brand-textMuted">Search site</span>

            <button
              type="button"
              onClick={() => setHelpOpen((v) => !v)}
              className="ml-1 inline-flex h-6 w-6 items-center justify-center rounded-full border border-zinc-700 bg-black/60 text-[11px] font-semibold text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text focus:outline-none focus:ring-2 focus:ring-amber-400/30"
              aria-label="Search help"
              title="Search help"
            >
              ?
            </button>

            <span className="ml-auto rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-brand-textMuted">
              Ctrl+K
            </span>

            {!isMobile ? (
              <span className="rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-brand-textMuted">
                Esc
              </span>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setHelpOpen(false);
                }}
                className="inline-flex min-h-[28px] items-center justify-center rounded-md border border-zinc-700 bg-black/60 px-2 py-1 text-[11px] font-medium text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text focus:outline-none focus:ring-2 focus:ring-amber-400/30"
                aria-label="Close command palette"
              >
                Close ✕
              </button>
            )}
          </div>

          {helpOpen && (
            <div
              ref={helpRef}
              className="relative mt-2 rounded-lg border border-zinc-700 bg-black/70 p-3 text-[11px] text-brand-text"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-2">
                  <div className="text-[12px] font-semibold text-brand-text">
                    How search works
                  </div>

                  <ul className="space-y-1 text-brand-textMuted">
                    <li>
                      <span className="text-brand-text">Type</span> to search across{" "}
                      <span className="text-brand-text">info pages</span> +{" "}
                      <span className="text-brand-text">forum threads</span>.
                    </li>
                    <li>
                      Press <span className="text-brand-text">Enter</span> to turn what
                      you typed into a <span className="text-brand-text">pill</span>.
                    </li>
                    <li>
                      Or type <span className="text-brand-text">comma</span> to instantly
                      commit a pill: <span className="text-brand-text">s14, subframe,</span>
                    </li>
                    <li>
                      Pills help you split big searches into smaller chunks so results
                      rank better.
                    </li>
                    <li>
                      Click a pill to remove it. Hit{" "}
                      <span className="text-brand-text">Backspace</span> on an empty
                      input to remove the last pill.
                    </li>
                  </ul>

                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-brand-textMuted">
                    <span className="rounded bg-black/60 px-1.5 py-0.5">📄 Info</span>
                    <span className="rounded bg-black/60 px-1.5 py-0.5">💬 Threads</span>
                    <span className="rounded bg-black/60 px-1.5 py-0.5">
                      Highlight = matches
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setHelpOpen(false)}
                  className="shrink-0 rounded-md border border-zinc-700 bg-black/60 px-2 py-1 text-[11px] font-medium text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text focus:outline-none focus:ring-2 focus:ring-amber-400/30"
                >
                  Got it
                </button>
              </div>
            </div>
          )}

          <div
            ref={chipContainerRef}
            className="mt-2 flex max-h-24 cursor-text flex-wrap items-center gap-1 overflow-y-auto rounded-md border border-zinc-700 bg-black/60 px-2 py-1.5 scrollbar-thin scrollbar-track-black/40 scrollbar-thumb-zinc-700/80"
            onClick={() => {
              const el = document.getElementById(
                "command-palette-input"
              ) as HTMLInputElement | null;
              el?.focus();
            }}
          >
            <span className="mr-1 text-[13px] text-brand-textMuted">🔍</span>

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
              id="command-palette-input"
              autoFocus
              value={fragment}
              onChange={(e) => {
                const value = e.target.value;

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
              placeholder="s14, subframe, install..."
              className="no-zoom-input min-w-[120px] flex-1 bg-transparent text-sm text-brand-text outline-none placeholder:text-zinc-500"
            />
          </div>

          {suggestion && (
            <button
              type="button"
              onClick={handleApplySuggestion}
              className="mt-1 inline-flex items-center gap-1 rounded-full border border-amber-400/80 bg-amber-500/20 px-2 py-0.5 text-[11px] text-amber-200 hover:bg-amber-500/30 hover:border-amber-300/90"
            >
              <span className="text-[11px]">Did you mean:</span>
              <span className="font-medium">{suggestion}</span>
              <span className="text-[10px]">↵</span>
            </button>
          )}
        </div>

        <div className="max-h-80 overflow-auto p-2 text-xs">
          {loading && (!allPagesLoaded || !allForumsLoaded) ? (
            <p className="px-2 py-2 text-brand-textMuted">Loading…</p>
          ) : loading ? (
            <p className="px-2 py-2 text-brand-textMuted">Searching…</p>
          ) : error ? (
            <p className="px-2 py-2 text-rose-300/80">{error}</p>
          ) : results.length === 0 ? (
            <p className="px-2 py-2 text-brand-textMuted">No results.</p>
          ) : (
            <>
              <div className="mb-1 px-2 text-[10px] text-brand-textMuted">
                Showing {visibleResults.length} of {results.length} result
                {results.length === 1 ? "" : "s"}
              </div>

              <ul className="space-y-1">
                {visibleInfo.length > 0 && (
                  <li className="px-2 pt-2 text-[10px] font-semibold uppercase tracking-wide text-brand-textMuted">
                    📄 Info pages
                  </li>
                )}
                {visibleInfo.map((p) => {
                  const lastUpdated = p.updated_at || p.created_at;

                  const tagChips =
                    Array.isArray(p.tags) && p.tags.length > 0 ? p.tags.slice(0, 3) : [];

                  return (
                    <li key={`info-${p.id}`}>
                      <button
                        type="button"
                        onClick={() => handleSelect(p)}
                        className="flex w-full flex-col rounded-md px-2 py-2 text-left hover:bg-black/60"
                      >
                        <span className="text-[13px] font-medium text-brand-text">
                          {highlightText(p.title, searchTokens)}
                        </span>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-brand-textMuted">
                          <span className="rounded-full bg-black/60 px-1.5 py-0.5">
                            {highlightText(`/info/${p.slug}`, searchTokens)}
                          </span>
                          <span>
                            Updated: {new Date(lastUpdated).toLocaleString()}
                          </span>
                        </div>

                        {(p.chassis || tagChips.length > 0 || p.category) && (
                          <div className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-brand-textMuted">
                            {p.chassis && (
                              <span className="rounded-full border border-zinc-700 bg-black/40 px-1.5 py-0.5">
                                {highlightText(p.chassis, searchTokens)}
                              </span>
                            )}
                            {p.category && (
                              <span className="rounded-full border border-zinc-800 bg-black/40 px-1.5 py-0.5">
                                {highlightText(p.category, searchTokens)}
                              </span>
                            )}
                            {tagChips.map((tag) => (
                              <span
                                key={`${p.id}-${tag}`}
                                className="rounded-full border border-zinc-700 bg-black/40 px-1.5 py-0.5"
                              >
                                {highlightText(tag, searchTokens)}
                              </span>
                            ))}
                            {Array.isArray(p.tags) && p.tags.length > tagChips.length && (
                              <span>+{p.tags.length - tagChips.length} more</span>
                            )}
                          </div>
                        )}
                      </button>
                    </li>
                  );
                })}
                
                {visibleForumThreads.length > 0 && (
                  <li className="px-2 pt-2 text-[10px] font-semibold uppercase tracking-wide text-brand-textMuted">
                    💬 Forum threads
                  </li>
                )}
                {visibleForumThreads.map((t) => (
                  <li key={`thread-${t.id}`}>
                    <button
                      type="button"
                      onClick={() => handleSelect(t)}
                      className="flex w-full flex-col rounded-md px-2 py-2 text-left hover:bg-black/60"
                    >
                      <span className="text-[13px] font-medium text-brand-text">
                        {highlightText(t.title, searchTokens)}
                      </span>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-brand-textMuted">
                        <span className="rounded-full bg-black/60 px-1.5 py-0.5">
                          {highlightText(
                            `/community/${t.categorySlug}/${t.slug}`,
                            searchTokens
                          )}
                        </span>
                        <span className="rounded-full border border-zinc-700 bg-black/40 px-1.5 py-0.5">
                          {highlightText(t.categoryName, searchTokens)}
                        </span>
                        <span>
                          Replies: <span className="text-brand-text">{t.reply_count}</span>
                        </span>
                        <span>
                          Views: <span className="text-brand-text">{t.view_count}</span>
                        </span>
                        {t.is_pinned && <span>📌</span>}
                        {t.is_locked && <span>🔒</span>}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>

              {results.length > visibleCount && (
                <div className="mt-2 flex justify-center">
                  <button
                    type="button"
                    onClick={() => setVisibleCount((prev) => prev + 5)}
                    className="inline-flex items-center justify-center rounded-full border border-zinc-700 bg-black/60 px-3 py-1 text-[11px] text-brand-textMuted hover:border-brand-primary/70 hover:text-brand-text"
                  >
                    Show more ({Math.min(results.length - visibleCount, 5)} more)
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
