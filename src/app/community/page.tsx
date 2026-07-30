// src/app/community/page.tsx
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { DonationBadge } from "@/components/DonationBadge";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { MenuSelect } from "@/components/ui/MenuSelect";

type LoadState = "idle" | "loading" | "loaded" | "error";

type ForumCategoryRow = {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  sort_order: number;
  is_archived: boolean;
  created_at: string;
  parent_id: number | null;
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
  tags: string[] | null;
};

type ProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  is_verified?: boolean | null;
  donation_rank?: string | null;
};

// --- fuzzy helpers (ranking only) ---
function isFuzzyMatch(a: string, b: string): boolean {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (s === t) return true;

  const lenDiff = Math.abs(s.length - t.length);
  if (lenDiff > 1) return false;

  let i = 0;
  let j = 0;
  let edits = 0;

  while (i < s.length && j < t.length) {
    if (s[i] === t[j]) {
      i++;
      j++;
    } else {
      edits++;
      if (edits > 1) return false;

      if (s.length > t.length) i++;
      else if (t.length > s.length) j++;
      else {
        i++;
        j++;
      }
    }
  }

  if (i < s.length || j < t.length) edits++;
  return edits <= 1;
}

function fieldMatchesToken(field: string, token: string): boolean {
  const f = (field || "").toLowerCase();
  const t = (token || "").toLowerCase();
  if (!f || !t) return false;

  if (f.includes(t)) return true;

  const parts = f.split(/\s+/);
  for (const part of parts) {
    if (!part) continue;
    if (isFuzzyMatch(part, t)) return true;
  }
  return false;
}

// --- highlight helpers (exact substring only) ---
type Range = { start: number; end: number };

function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Range[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1];
    const cur = sorted[i];
    if (cur.start <= prev.end) prev.end = Math.max(prev.end, cur.end);
    else out.push(cur);
  }
  return out;
}

function findTokenRanges(text: string, token: string): Range[] {
  const t = token.trim().toLowerCase();
  if (!t) return [];
  const lower = text.toLowerCase();

  const ranges: Range[] = [];
  let idx = 0;
  while (idx < lower.length) {
    const hit = lower.indexOf(t, idx);
    if (hit === -1) break;
    ranges.push({ start: hit, end: hit + t.length });
    idx = hit + t.length;
  }
  return ranges;
}

function highlightText(text: string, tokens: string[]) {
  if (!text) return text;
  const cleanTokens = Array.from(
    new Set(tokens.map((t) => t.trim()).filter((t) => t.length >= 2))
  );
  if (cleanTokens.length === 0) return text;

  const rawRanges: Range[] = [];
  for (const tok of cleanTokens) rawRanges.push(...findTokenRanges(text, tok));
  const ranges = mergeRanges(rawRanges);
  if (ranges.length === 0) return text;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const r of ranges) {
    if (cursor < r.start) parts.push(text.slice(cursor, r.start));
    parts.push(
      <mark
        key={`${r.start}-${r.end}`}
        className="rounded-sm bg-amber-400/20 px-0.5 text-amber-200"
      >
        {text.slice(r.start, r.end)}
      </mark>
    );
    cursor = r.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

export default function CommunityPage() {
  const [state, setState] = useState<LoadState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [categories, setCategories] = useState<ForumCategoryRow[]>([]);
  const [threads, setThreads] = useState<ForumThreadRow[]>([]);
  const [profilesById, setProfilesById] = useState<Map<string, ProfileRow>>(
    () => new Map()
  );

  // chip search state
  const [committedTerms, setCommittedTerms] = useState<string[]>([]);
  const [fragment, setFragment] = useState("");
  const chipContainerRef = useRef<HTMLDivElement | null>(null);

  // show more paging (6 at a time)
  const [visibleCount, setVisibleCount] = useState<number>(6);

  type ThreadSort = "hot" | "newest" | "top" | "active";
  const [threadSort, setThreadSort] = useState<ThreadSort>("hot");

  // help popup
  const [helpOpen, setHelpOpen] = useState(false);

  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const [leadScoreByThreadId, setLeadScoreByThreadId] = useState<Map<number, number>>(
    () => new Map()
  );

  // When searching, also boost threads that match inside replies/comments.
  // (Lower weight than titles/original fields.)
  const [replyMatchCountByThreadId, setReplyMatchCountByThreadId] = useState<
    Record<number, number>
  >({});

  const [replyMatchPreviewByThreadId, setReplyMatchPreviewByThreadId] = useState<
    Record<number, { postId: number; snippet: string }>
  >({});

  useEffect(() => {
    // Keep "Hot (7d)" fresh without re-render noise
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const hasActiveQuery =
    committedTerms.length > 0 || fragment.trim().length > 0;

  useEffect(() => {
    const load = async () => {
      setState("loading");
      setErrorMessage(null);

      try {
        // Provide the Supabase access token so the server route can identify the
        // logged-in viewer (our route auth helper reads Authorization: Bearer <token>).
        const supabase = supabaseBrowser();
        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData?.session?.access_token ?? null;

        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

        const res = await fetch("/api/forum/community-feed", {
          method: "GET",
          headers,
        });

        const json = (await res.json().catch(() => null)) as
          | {
              ok: true;
              categories: ForumCategoryRow[];
              threads: ForumThreadRow[];
              leadScores: Array<{ thread_id: number; lead_vote_score: number | null }>;
              profiles: ProfileRow[];
            }
          | { ok: false; error: string }
          | null;

        if (!res.ok || !json || !json.ok) {
          const msg = json && "error" in json ? String(json.error) : "Failed to load community.";
          console.error("Failed to load community-feed", msg);
          setErrorMessage(msg);
          setState("error");
          return;
        }

        setCategories(json.categories ?? []);
        setThreads(json.threads ?? []);

        const scoreRows = json.leadScores ?? [];
        if (scoreRows.length) {
          setLeadScoreByThreadId(
            new Map<number, number>(
              scoreRows.map((r) => [Number(r.thread_id), Number(r.lead_vote_score ?? 0)])
            )
          );
        } else {
          setLeadScoreByThreadId(new Map());
        }

        const profilesData = json.profiles ?? [];
        if (profilesData.length) {
          const map = new Map<string, ProfileRow>();
          for (const p of profilesData as ProfileRow[]) map.set(p.id, p);
          setProfilesById(map);
        } else {
          setProfilesById(new Map());
        }

        setState("loaded");
      } catch (err) {
        console.error("Unexpected error loading community page", err);
        setErrorMessage("Unexpected error loading community.");
        setState("error");
      }
    };

    void load();
  }, []);

  // derived helpers (stable)
  const getDisplayName = useCallback(
    (userId: string | null): string => {
      if (!userId) return "Unknown user";
      const profile = profilesById.get(userId);
      if (!profile) return userId;
      return profile.display_name || profile.username || userId;
    },
    [profilesById]
  );

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
    setVisibleCount(6);
    scrollChipsToBottom();
  };

  const handleRemoveTerm = (term: string) => {
    setCommittedTerms((prev) => prev.filter((t) => t !== term));
    setVisibleCount(6);
  };

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

    committedTerms.forEach(addTokensFrom);
    addTokensFrom(fragment);

    return Array.from(new Set(tokens));
  }, [committedTerms, fragment]);

  // When searching, fetch a lightweight set of matching replies to improve ranking.
  // This does NOT change what we display, it only influences ordering.
  useEffect(() => {
    const run = async () => {
      if (searchTokens.length === 0) {
        setReplyMatchCountByThreadId({});
        setReplyMatchPreviewByThreadId({});
        return;
      }

      try {
        const supabase = supabaseBrowser();
        const or = searchTokens
          .slice(0, 6)
          .map((t) => `body_markdown.ilike.%${t}%`)
          .join(",");

        const { data, error } = await supabase
          .from("forum_posts")
          .select("id, thread_id, body_markdown, created_at")
          .or(or)
          .order("created_at", { ascending: false })
          .limit(500);

        if (error) {
          console.error("[community] reply search failed", error);
          setReplyMatchCountByThreadId({});
          setReplyMatchPreviewByThreadId({});
          return;
        }

        const counts: Record<number, number> = {};
        const previews: Record<number, { postId: number; snippet: string }> = {};
        for (const row of data ?? []) {
          const r = row as { id?: unknown; thread_id?: unknown; body_markdown?: unknown };
          const tid = Number(r.thread_id);
          if (!Number.isFinite(tid)) continue;
          counts[tid] = (counts[tid] ?? 0) + 1;
          if (!previews[tid]) {
            const postId = Number(r.id);
            const body = typeof r.body_markdown === "string" ? r.body_markdown : "";
            const oneLine = body.replace(/\s+/g, " ").trim();
            const snippet = oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
            previews[tid] = { postId: Number.isFinite(postId) ? postId : 0, snippet };
          }
        }

        setReplyMatchCountByThreadId(counts);
        setReplyMatchPreviewByThreadId(previews);
      } catch (e) {
        console.error("[community] reply search error", e);
        setReplyMatchCountByThreadId({});
        setReplyMatchPreviewByThreadId({});
      }
    };

    void run();
  }, [searchTokens]);

  // highlight EXACT strings the user typed (chips + fragment words)
  const highlightTokens = useMemo(() => {
    const toks: string[] = [];

    const add = (t: string) => {
      const s = t.trim();
      if (!s) return;
      toks.push(s);
      for (const part of s.split(/\s+/)) {
        const p = part.trim();
        if (p) toks.push(p);
      }
    };

    committedTerms.forEach(add);
    add(fragment);

    return Array.from(new Set(toks));
  }, [committedTerms, fragment]);

  const categoriesById = useMemo(() => {
    const map = new Map<number, ForumCategoryRow>();
    for (const c of categories) map.set(c.id, c);
    return map;
  }, [categories]);

  const activeCategories = useMemo(
    () => categories.filter((c) => !c.is_archived),
    [categories]
  );

  const categoryGroups = useMemo(() => {
    const activeById = new Map<number, ForumCategoryRow>();
    for (const c of activeCategories) activeById.set(c.id, c);

    const childrenByParent = new Map<number, ForumCategoryRow[]>();
    const topLevel: ForumCategoryRow[] = [];

    for (const c of activeCategories) {
      if (c.parent_id && activeById.has(c.parent_id)) {
        const list = childrenByParent.get(c.parent_id) ?? [];
        list.push(c);
        childrenByParent.set(c.parent_id, list);
      } else {
        topLevel.push(c);
      }
    }

    const sortedTop = [...topLevel].sort((a, b) => a.sort_order - b.sort_order);
    const groups = sortedTop.map((parent) => ({
      parent,
      children: (childrenByParent.get(parent.id) ?? []).sort(
        (a, b) => a.sort_order - b.sort_order
      ),
    }));

    return groups;
  }, [activeCategories]);

  // ✅ Always show all results, just ranked (and then paged 6 at a time)
  const rankedThreads = useMemo(() => {
    if (!hasActiveQuery) {
      const weekAgo = nowMs - 7 * 24 * 60 * 60 * 1000;

      const pinned = threads.filter((t) => t.is_pinned);
      const rest = threads.filter((t) => !t.is_pinned);

      const getLastTime = (t: ForumThreadRow) =>
        new Date(t.last_post_at || t.updated_at || t.created_at).getTime();

      const byActive = [...rest].sort((a, b) => getLastTime(b) - getLastTime(a));

      const byNewest = [...rest].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );

      const byTop = [...rest].sort((a, b) => {
        if (b.reply_count !== a.reply_count) return b.reply_count - a.reply_count;
        return b.view_count - a.view_count;
      });

      const byHot = [...rest].sort((a, b) => {
        const aLast = getLastTime(a);
        const bLast = getLastTime(b);

        const aInWeek = aLast >= weekAgo ? 1 : 0;
        const bInWeek = bLast >= weekAgo ? 1 : 0;
        if (bInWeek !== aInWeek) return bInWeek - aInWeek;

        if (b.reply_count !== a.reply_count) return b.reply_count - a.reply_count;
        return bLast - aLast;
      });

      const sorted =
        threadSort === "newest"
          ? byNewest
          : threadSort === "top"
            ? byTop
            : threadSort === "active"
              ? byActive
              : byHot;

      return [...pinned, ...sorted];
    }

    const scored = threads.map((t) => {
      const cat = categoriesById.get(t.category_id);
      const catName = cat?.name ?? "";
      const author = getDisplayName(t.created_by);
      const lastBy = getDisplayName(t.last_post_by);
      const tags = (t.tags ?? []).map((tag) => tag.toLowerCase());

      let score = 0;

      for (const tok of searchTokens) {
        // Title strongest
        if (fieldMatchesToken(t.title, tok)) score += 6;
        // Category name
        if (fieldMatchesToken(catName, tok)) score += 3;
        // Slug
        if (fieldMatchesToken(t.slug, tok)) score += 2;
        // Tags
        if (tags.some((tag) => fieldMatchesToken(tag, tok))) score += 2;
        // Author / lastBy
        if (fieldMatchesToken(author, tok)) score += 2;
        if (fieldMatchesToken(lastBy, tok)) score += 2;
      }

      // Replies/comments match (lower weight than title/category)
      const replyHits = replyMatchCountByThreadId[t.id] ?? 0;
      if (replyHits > 0) score += Math.min(3, replyHits);

      // small tie-breakers (keep active threads a touch higher)
      const recency = t.last_post_at ? new Date(t.last_post_at).getTime() : 0;
      if (t.is_pinned) score += 3;

      return { t, score, recency };
    });

    return scored
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.recency - a.recency;
      })
      .map((s) => s.t);
  }, [
    threads,
    hasActiveQuery,
    threadSort,
    searchTokens,
    categoriesById,
    getDisplayName,
    nowMs,
    replyMatchCountByThreadId,
  ]);

  const totalCount = rankedThreads.length;
  const visibleThreads = useMemo(
    () => rankedThreads.slice(0, visibleCount),
    [rankedThreads, visibleCount]
  );

  const canShowMore = totalCount > visibleCount;

  // Help popup: ESC to close
  useEffect(() => {
    if (!helpOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHelpOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [helpOpen]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 text-sm text-brand-text">
      {/* Header */}
      <section className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">
              Community
            </p>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Forums &amp; discussions
            </h1>
            <p className="text-[12px] text-brand-textMuted sm:text-sm">
              Browse categories or search posts across the community.
            </p>
          </div>

          {/* ? Help button */}
          <button
            type="button"
            onClick={() => setHelpOpen((v) => !v)}
            className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-black/40 text-sm text-brand-textMuted transition hover:border-amber-400/70 hover:text-brand-text"
            aria-label="Search help"
            title="Search help"
          >
            ?
          </button>
        </div>

        {/* Search bar (posts) */}
        <div className="pt-2">
          <div
            ref={chipContainerRef}
            className="flex max-h-24 cursor-text flex-wrap items-center gap-1 overflow-y-auto rounded-full border border-zinc-700 bg-black/40 px-3 py-1.5"
            onClick={() => {
              const el = document.getElementById(
                "communitysearch-input"
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
                className="inline-flex items-center gap-1 rounded-full border border-amber-400/60 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200 transition-transform hover:-translate-y-px hover:bg-amber-500/20"
              >
                <span>{term}</span>
                <span className="text-[10px]">×</span>
              </button>
            ))}

            <input
              id="communitysearch-input"
              type="text"
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
                    setVisibleCount(6);
                    scrollChipsToBottom();
                    return;
                  }
                  setFragment("");
                  setVisibleCount(6);
                  return;
                }

                setFragment(value);
                setVisibleCount(6);
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
                  setVisibleCount(6);
                  scrollChipsToBottom();
                }
              }}
              placeholder="search posts… (ex: sr20, wiring, idle, alignment)"
              className="no-zoom-input min-w-[120px] flex-1 bg-transparent text-sm text-brand-text outline-none placeholder:text-zinc-500"
            />
          </div>

          {state === "loaded" && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-brand-textMuted">
              <div>
                {hasActiveQuery ? (
                  <>
                    Showing {Math.min(visibleCount, totalCount)} of {totalCount}{" "}
                    (ranked)
                  </>
                ) : (
                  <>Tip: use commas to add chips (ex: “sr20, turbo, oil”)</>
                )}
              </div>

              <div className="flex items-center gap-2">
                <span className="text-brand-textMuted">Sort</span>
                <MenuSelect
                  value={threadSort}
                  onChange={(next) => {
                    setThreadSort(next as ThreadSort);
                    setVisibleCount(6);
                  }}
                  disabled={hasActiveQuery}
                  ariaLabel="Sort threads"
                  className="flex h-8 items-center gap-2 rounded-full border border-zinc-700 bg-black/40 px-3 text-[11px] text-brand-textMuted outline-none transition hover:border-amber-400/70 disabled:opacity-50"
                  options={[
                    { value: "hot", label: "Hot (7d)" },
                    { value: "active", label: "Active" },
                    { value: "top", label: "Top" },
                    { value: "newest", label: "Newest" },
                  ]}
                />
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Help popup */}
      {helpOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          onMouseDown={() => setHelpOpen(false)}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" />
          <div
            className="relative w-full max-w-lg rounded-2xl border border-zinc-700 bg-black/90 p-4 text-sm text-brand-text shadow-xl"
            onMouseDown={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">
                  Community search help
                </div>
                <div className="mt-1 text-base font-semibold">
                  Search posts like a pro
                </div>
              </div>
              <button
                type="button"
                onClick={() => setHelpOpen(false)}
                className="inline-flex h-9 items-center justify-center rounded-full border border-zinc-700 bg-black/40 px-3 text-[12px] text-brand-textMuted transition hover:border-amber-400/70 hover:text-brand-text"
              >
                Got it
              </button>
            </div>

            <div className="mt-3 space-y-3 text-[12px] text-brand-textMuted">
              <p>
                <span className="mr-2 inline-flex items-center rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[11px] text-brand-text">
                  🔍 Type
                </span>
                to rank results by relevance. Posts never disappear—typing just
                brings the best matches to the top.
              </p>

              <div className="rounded-xl border border-zinc-800 bg-black/40 p-3">
                <div className="text-[11px] font-semibold text-brand-text">
                  Chips (comma-separated terms)
                </div>
                <p className="mt-1">
                  Add multiple ideas quickly by typing a comma. Each chip acts
                  like a “topic bucket” so the search can score posts across
                  multiple angles.
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="rounded-full border border-amber-400/60 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200">
                    sr20
                  </span>
                  <span className="rounded-full border border-amber-400/60 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200">
                    idle
                  </span>
                  <span className="rounded-full border border-amber-400/60 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200">
                    wiring
                  </span>
                </div>
                <div className="mt-2 text-[11px]">
                  Example:{" "}
                  <span className="rounded-md border border-zinc-700 bg-black/50 px-1.5 py-0.5 text-brand-text">
                    sr20, idle, tps
                  </span>
                </div>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-black/40 p-3">
                <div className="text-[11px] font-semibold text-brand-text">
                  What gets highlighted
                </div>
                <p className="mt-1">
                  Highlights show exact text hits across{" "}
                  <span className="text-brand-text">title</span>,{" "}
                  <span className="text-brand-text">category</span>,{" "}
                  <span className="text-brand-text">slug</span>, and author
                  fields (who posted / last replied).
                </p>
              </div>

              <p className="text-[11px]">
                Tip: press <span className="text-brand-text">Enter</span> to
                turn your current text into a chip.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Error / loading states */}
      {state === "error" && (
        <section>
          <p className="rounded-md border border-rose-500/60 bg-rose-950/40 px-3 py-2 text-[12px] text-rose-200">
            {errorMessage ?? "Failed to load community."}
          </p>
        </section>
      )}

      {state === "loading" && (
        <section>
          <p className="text-[12px] text-brand-textMuted">Loading community…</p>
        </section>
      )}

      {state === "loaded" && (
        <>
          {/* ✅ Categories first, but hide while typing/searching */}
          {!hasActiveQuery && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-brand-text">
                Browse categories
              </h2>
              <div className="grid gap-3 md:grid-cols-2">
                {categoryGroups.map(({ parent, children }) => (
                  <div
                    key={parent.id}
                    className="group rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-sm transition-colors hover:border-brand-primary/70 hover:bg-black/70"
                  >
                    <Link
                      href={`/community/${parent.slug}`}
                      className="block"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-semibold">{parent.name}</div>
                        <span className="text-[10px] uppercase tracking-wide text-brand-textMuted">
                          Enter →
                        </span>
                      </div>
                      {parent.description && (
                        <p className="mt-1 text-[12px] text-brand-textMuted">
                          {parent.description}
                        </p>
                      )}
                    </Link>

                    {children.length > 0 && (
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px]">
                        {children.map((child) => (
                          <Link
                            key={child.id}
                            href={`/community/${child.slug}`}
                            className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-brand-textMuted transition hover:border-brand-primary/60 hover:text-brand-text"
                          >
                            {child.name}
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Posts under categories (always shown; ranked if searching) */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-brand-text">Posts</h2>
              <span className="text-[11px] text-brand-textMuted">
                {threads.length} total
              </span>
            </div>

            <div className="overflow-hidden rounded-xl border border-zinc-800/80 bg-black/40">
              <div className="divide-y divide-zinc-800/80">
                {visibleThreads.map((t) => {
                  const cat = categoriesById.get(t.category_id);
                  const catSlug = cat?.slug ?? "unknown";
                  const catName = cat?.name ?? "Unknown";

                  const createdLabel = formatDateTime(t.created_at);
                  const lastReplyLabel = formatDateTime(t.last_post_at);

                  const authorProfile = t.created_by ? profilesById.get(t.created_by) ?? null : null;
                  const lastProfile = t.last_post_by ? profilesById.get(t.last_post_by) ?? null : null;
                  const author = getDisplayName(t.created_by);
                  const lastBy = getDisplayName(t.last_post_by);

                  const authorHref = t.created_by ? `/user/${t.created_by}` : null;
                  const lastByHref = t.last_post_by ? `/user/${t.last_post_by}` : null;

                  const leadScore = leadScoreByThreadId.get(t.id) ?? 0;
                  const tags = (t.tags ?? []).filter((tag) => tag && tag.trim().length > 0).slice(0, 4);
                  const karmaCls =
                    leadScore > 0
                      ? "border-emerald-500/70 bg-emerald-500/10 text-emerald-200"
                      : leadScore < 0
                      ? "border-rose-500/70 bg-rose-500/10 text-rose-200"
                      : "border-zinc-700 bg-black/40 text-brand-textMuted";

                  const lockedBadge = t.is_locked ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/60 bg-rose-500/15 px-1.5 py-0.5 text-[10px] text-rose-200">
                      🔒 Locked
                    </span>
                  ) : null;

                  const pinnedBadge = t.is_pinned ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/80 bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
                      📌 Pinned
                    </span>
                  ) : null;

                  return (
                    <div
                      key={t.id}
                      className="grid gap-3 px-3 py-3 text-[11px] text-brand-text md:grid-cols-[minmax(0,2.6fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,0.6fr)]"
                    >
                      <div className="space-y-1">
                        <Link
                          href={`/community/${catSlug}/${t.slug}`}
                          className="line-clamp-2 text-[13px] font-semibold text-brand-text hover:text-brand-primary"
                        >
                          {highlightText(t.title, highlightTokens)}
                        </Link>

                        {replyMatchPreviewByThreadId[t.id] && replyMatchPreviewByThreadId[t.id]!.snippet ? (
                          <Link
                            href={`/community/${catSlug}/${t.slug}#post-${replyMatchPreviewByThreadId[t.id]!.postId}`}
                            className="block rounded-md border border-zinc-800/80 bg-black/25 px-2 py-1 text-[10px] text-brand-textMuted hover:border-brand-primary/50"
                          >
                            <span className="mr-1 text-amber-200">Match:</span>
                            <span className="line-clamp-2 text-brand-textMuted">
                              {highlightText(replyMatchPreviewByThreadId[t.id]!.snippet, highlightTokens)}
                            </span>
                          </Link>
                        ) : null}

                        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-brand-textMuted">
                          <Link
                            href={`/community/${catSlug}`}
                            className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 hover:border-brand-primary/60 hover:text-brand-text"
                          >
                            {highlightText(catName, highlightTokens)}
                          </Link>

                          {tags.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1">
                              {tags.map((tag) => (
                                <span
                                  key={tag}
                                  className="rounded-full border border-zinc-700/80 bg-black/30 px-2 py-0.5 text-[10px] text-brand-textMuted"
                                >
                                  {highlightText(tag, highlightTokens)}
                                </span>
                              ))}
                            </div>
                          )}

                          <span>•</span>
                          <span className="inline-flex items-center gap-1">
                            <span>
                              Started by{" "}
                              {authorHref ? (
                                <Link href={authorHref} className="text-brand-text hover:text-brand-primary">
                                  {highlightText(author, highlightTokens)}
                                </Link>
                              ) : (
                                <span>{highlightText(author, highlightTokens)}</span>
                              )}
                            </span>
                            {authorProfile?.is_verified ? <VerifiedBadge className="ml-0.5 h-3 w-3" /> : null}
                            {authorProfile?.donation_rank ? (
                              <DonationBadge rank={authorProfile.donation_rank} className="ml-0.5 h-3 w-3" />
                            ) : null}
                          </span>

                          {highlightTokens.length > 0 && (
                            <>
                              <span>•</span>
                              <span className="truncate">/{highlightText(t.slug, highlightTokens)}</span>
                            </>
                          )}

                          <span>•</span>
                          <span>{createdLabel}</span>
                          {pinnedBadge}
                          {lockedBadge}
                        </div>
                      </div>

                      <div className="flex flex-col justify-center text-[11px] text-brand-text">
                        <div className="text-[13px] font-semibold">{t.reply_count}</div>
                        <div className="text-[10px] text-brand-textMuted">Replies</div>
                      </div>

                      <div className="flex flex-col justify-center text-[11px] text-brand-text">
                        <div className="text-[13px] font-semibold">{t.view_count}</div>
                        <div className="text-[10px] text-brand-textMuted">Views</div>
                      </div>

                      <div className="flex flex-col justify-center text-right text-[10px] text-brand-textMuted">
                        <div className="mb-1 inline-flex items-center justify-end">
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] ${karmaCls}`}>
                            <span className="opacity-80">Karma </span>
                            <span className="ml-1 font-semibold">{leadScore}</span>
                          </span>
                        </div>
                        {t.last_post_at ? (
                          <>
                            <span>{lastReplyLabel}</span>
                            <span className="mt-0.5">
                              by{" "}
                              <span className="inline-flex items-center gap-1">
                                {lastByHref ? (
                                  <Link href={lastByHref} className="text-brand-text hover:text-brand-primary">
                                    {highlightText(lastBy, highlightTokens)}
                                  </Link>
                                ) : (
                                  <span className="text-brand-text">{highlightText(lastBy, highlightTokens)}</span>
                                )}
                                {lastProfile?.is_verified ? <VerifiedBadge className="ml-0.5 h-3 w-3" /> : null}
                                {lastProfile?.donation_rank ? (
                                  <DonationBadge rank={lastProfile.donation_rank} className="ml-0.5 h-3 w-3" />
                                ) : null}
                              </span>
                            </span>
                          </>
                        ) : (
                          <span>No replies yet</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {canShowMore && (
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => setVisibleCount((v) => v + 6)}
                  className="w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-[12px] text-brand-textMuted transition hover:border-amber-400/70 hover:text-brand-text"
                >
                  Show more (+6)
                </button>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
