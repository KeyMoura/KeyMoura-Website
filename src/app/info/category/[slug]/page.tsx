"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { InfoCard, InfoCardItem } from "@/components/info/InfoCard";

type InfoCategoryRow = {
  id: string;
  title: string;
  slug: string;
  created_at: string;
  updated_at: string | null;
  status: string;
  category: string | null;
  chassis: string | null;
  tags: string[] | null;
};

type InfoCategoryItem = InfoCardItem;

const CATEGORY_META: Record<string, { name: string; description: string }> = {
  "chassis-suspension": {
    name: "Chassis & Suspension",
    description:
      "Alignment setups, bushing replacements, coilovers, arms, subframes, and handling tweaks.",
  },
  "engine-drivetrain": {
    name: "Engine & Drivetrain",
    description:
      "SR/KA builds, turbos, fueling, cooling, clutches, diffs, and drivetrain reliability.",
  },
  "wiring-electronics": {
    name: "Wiring & Electronics",
    description:
      "ECUs, digital dashes, harness work, sensors, CAN bus, and diagnostics.",
  },
  "body-aero": {
    name: "Body & Aero",
    description: "Body kits, aero, wings, diffusers, vents, and cooling airflow.",
  },
  "maintenance-general": {
    name: "Maintenance & General",
    description: "Base maintenance, torque specs, common issues, and general reference.",
  },
};

// fuzzy helper used for TEXT tokens
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

function fieldMatchesToken(field: string, token: string): boolean {
  const f = field.toLowerCase();
  const t = token.toLowerCase();
  if (!f || !t) return false;

  if (f.includes(t)) return true;

  const parts = f.split(/\s+/);
  for (const part of parts) {
    if (!part) continue;
    if (isFuzzyMatch(part, t)) return true;
  }

  return false;
}

// stricter matching for CHIP fields: no fuzzy
function fieldMatchesChipField(field: string, token: string): boolean {
  const f = field.toLowerCase();
  const t = token.toLowerCase();
  if (!f || !t) return false;
  return f.includes(t);
}

export default function InfoCategoryPage() {
  const { slug } = useParams() as { slug: string };

  const supabase = supabaseBrowser();

  const [items, setItems] = useState<InfoCategoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [chassisFilter, setChassisFilter] = useState<string>("all");

  // chip + fragment search state
  const [committedTerms, setCommittedTerms] = useState<string[]>([]);
  const [fragment, setFragment] = useState("");
  const chipContainerRef = useRef<HTMLDivElement | null>(null);

  const [suggestion, setSuggestion] = useState<string | null>(null);

  // ✅ help popup (same behavior/style as other pages)
  const [helpOpen, setHelpOpen] = useState(false);

  // ESC closes help
  useEffect(() => {
    if (!helpOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHelpOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [helpOpen]);

  const meta =
    CATEGORY_META[slug] ?? {
      name: "Category",
      description:
        "Info pages grouped by this category. More structure will be added as content grows.",
    };

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const { data, error } = await supabase
          .from("info_pages")
          .select("id, title, slug, created_at, updated_at, status, category, chassis, tags")
          .eq("status", "approved")
          .eq("category", slug)
          .order("updated_at", { ascending: false });

        if (error) {
          console.error("Error loading category pages", error);
          setError("Failed to load pages for this category.");
        } else {
          const rows = (data ?? []) as InfoCategoryRow[];
          setItems(
            rows.map((row) => ({
              id: row.id,
              title: row.title,
              slug: row.slug,
              created_at: row.created_at,
              updated_at: row.updated_at,
              chassis: row.chassis,
              tags: row.tags ?? null,
              category: row.category,
            }))
          );
        }
      } catch {
        console.error("Unexpected error loading category");
        setError("Unexpected error loading this category.");
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [slug, supabase]);

  const chassisOptions = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) {
      if (item.chassis && item.chassis.trim().length > 0) {
        set.add(item.chassis.trim());
      }
    }
    return Array.from(set).sort();
  }, [items]);

  const chassisFiltered = useMemo(() => {
    if (chassisFilter === "all") return items;
    return items.filter((item) => (item.chassis ?? "").trim() === chassisFilter);
  }, [items, chassisFilter]);

  // tag suggestions from this category (tags + chassis + category)
  const allKnownTags = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) {
      for (const t of item.tags ?? []) set.add(t);
      if (item.chassis && item.chassis.trim().length > 0) set.add(item.chassis.trim());
      if (item.category && item.category.trim().length > 0) set.add(item.category.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [items]);

  const tagSuggestions = useMemo(() => {
    const frag = fragment.trim().toLowerCase();
    if (!frag) return [] as string[];

    return allKnownTags.filter((tag) => {
      const lower = tag.toLowerCase();
      return !committedTerms.includes(tag) && (lower.startsWith(frag) || lower.includes(frag));
    });
  }, [allKnownTags, committedTerms, fragment]);

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

  const hasActiveQuery = committedTerms.length > 0 || fragment.trim().length > 0;

  // "Did you mean" for category page (based on LAST TOKEN)
  useEffect(() => {
    const pieces = [...committedTerms, fragment].map((s) => s.trim()).filter(Boolean);

    if (pieces.length === 0 || items.length === 0) {
      setSuggestion(null);
      return;
    }

    const lastToken = pieces[pieces.length - 1]
      .split(/\s+/)
      .filter(Boolean)
      .slice(-1)[0]
      .toLowerCase();

    if (!lastToken) {
      setSuggestion(null);
      return;
    }

    const candidateSet = new Set<string>();
    for (const item of items) {
      candidateSet.add(item.title);
      if (item.chassis) candidateSet.add(item.chassis);
      if (item.category) candidateSet.add(item.category);
      for (const t of item.tags ?? []) candidateSet.add(t);
    }

    const candidates = Array.from(candidateSet);
    const candidatesLower = candidates.map((c) => c.toLowerCase());

    if (candidatesLower.includes(lastToken)) {
      setSuggestion(null);
      return;
    }

    let bestTerm: string | null = null;
    let bestSim = 0;

    for (let i = 0; i < candidates.length; i++) {
      const term = candidates[i];
      const sim = normalizedSimilarity(lastToken, candidatesLower[i]);
      if (sim > bestSim) {
        bestSim = sim;
        bestTerm = term;
      }
    }

    setSuggestion(bestTerm && bestSim >= 0.2 ? bestTerm : null);
  }, [committedTerms, fragment, items]);

  // Main filtered + ranked list + analytics metadata
  const { filteredItems }: { filteredItems: InfoCategoryItem[] } = useMemo(() => {
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

    const hasAnyTokens = textTokens.length > 0 || chipTokens.length > 0;

    if (!hasAnyTokens) return { filteredItems: chassisFiltered };

    type Annotated = { item: InfoCategoryItem; score: number };

    const annotated: Annotated[] = chassisFiltered.map((item) => {
      const title = item.title.toLowerCase();
      const slug = item.slug.toLowerCase();
      const chassis = (item.chassis ?? "").toLowerCase();
      const category = (item.category ?? "").toLowerCase();

      const tagsArray = [...(item.tags ?? []), item.chassis ?? "", item.category ?? ""]
        .map((t) => t.toLowerCase())
        .filter(Boolean);

      let score = 0;

      const scoreTextToken = (token: string) => {
        let tokenScore = 0;
        if (fieldMatchesToken(title, token)) tokenScore += 12;
        if (fieldMatchesToken(slug, token)) tokenScore += 8;
        if (tagsArray.some((tag) => fieldMatchesToken(tag, token))) tokenScore += 10;
        if (fieldMatchesToken(chassis, token)) tokenScore += 7;
        if (fieldMatchesToken(category, token)) tokenScore += 6;
        if (tokenScore > 20) tokenScore = 20;
        score += tokenScore;
      };

      const scoreChipToken = (token: string) => {
        let tokenScore = 0;
        if (tagsArray.some((tag) => fieldMatchesChipField(tag, token))) tokenScore += 18;
        if (fieldMatchesChipField(chassis, token)) tokenScore += 18;
        if (fieldMatchesChipField(category, token)) tokenScore += 16;
        if (tokenScore > 24) tokenScore = 24;
        score += tokenScore;
      };

      for (const token of textTokens) scoreTextToken(token);
      for (const token of chipTokens) scoreChipToken(token);

      return { item, score };
    });

    annotated.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aTime = new Date(a.item.updated_at || a.item.created_at).getTime();
      const bTime = new Date(b.item.updated_at || b.item.created_at).getTime();
      return bTime - aTime;
    });

    return { filteredItems: annotated.map((x) => x.item) };
  }, [chassisFiltered, committedTerms, fragment]);

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

  const handleApplySuggestion = (tag: string) => {
    setCommittedTerms((prev) => (prev.includes(tag) ? prev : [...prev, tag]));
    setFragment("");
    scrollChipsToBottom();
  };

  const handleApplyDidYouMean = () => {
    if (!suggestion) return;
    setCommittedTerms([]);
    setFragment(suggestion);
    setSuggestion(null);
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
      {/* Header */}
      <section className="space-y-3">
        <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">
          Info pages • {slug}
        </p>

        {/* ✅ Title row + ? button (matches the other pages) */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-brand-text sm:text-3xl">
              {meta.name}
            </h1>
            <p className="text-[12px] text-brand-textMuted sm:text-sm">
              {meta.description}
            </p>
          </div>

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

        <div className="mt-2 text-[11px] text-brand-textMuted">
          <Link
            href="/info"
            className="text-amber-300 hover:text-amber-200 underline underline-offset-2"
          >
            ← Back to all info
          </Link>
        </div>
      </section>

      {/* Category-scoped search */}
      <section className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex-1">
            <div
              ref={chipContainerRef}
              className="flex max-h-24 flex-wrap items-center gap-1 overflow-y-auto rounded-full border border-zinc-700 bg-black/40 px-3 py-1.5 cursor-text scrollbar-thin scrollbar-track-black/40 scrollbar-thumb-zinc-700/80"
              onClick={() => {
                const el = document.getElementById("category-infosearch-input") as
                  | HTMLInputElement
                  | null;
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
                id="category-infosearch-input"
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

                  if (e.key === "Backspace" && fragment.length === 0 && committedTerms.length > 0) {
                    e.preventDefault();
                    setCommittedTerms((prev) => prev.slice(0, -1));
                    scrollChipsToBottom();
                  }
                }}
                placeholder="s14, subframe, install"
                className="min-w-[120px] no-zoom-input flex-1 bg-transparent text-sm text-brand-text outline-none placeholder:text-zinc-500"
              />
            </div>

            {/* Tag suggestions */}
            {tagSuggestions.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {tagSuggestions.slice(0, 10).map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => handleApplySuggestion(tag)}
                    className="rounded-full border border-zinc-700 bg-black/60 px-2 py-0.5 text-[11px] text-brand-textMuted hover:border-amber-400/80 hover:text-brand-text"
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}

            {suggestion && (
              <button
                type="button"
                onClick={handleApplyDidYouMean}
                className="mt-1 inline-flex items-center gap-1 rounded-full border border-amber-400/80 bg-amber-500/20 px-2 py-0.5 text-[11px] text-amber-200 hover:bg-amber-500/30 hover:border-amber-300/90"
              >
                <span className="text-[11px]">Did you mean:</span>
                <span className="font-medium">{suggestion}</span>
                <span className="text-[10px]">↵</span>
              </button>
            )}
          </div>

          <div className="text-[11px] text-brand-textMuted sm:text-right">
            {items.length === 0 ? (
              <span>No pages in this category yet.</span>
            ) : (
              <span>
                {filteredItems.length} result{filteredItems.length === 1 ? "" : "s"} in this category
              </span>
            )}
          </div>
        </div>
      </section>

      {/* ✅ Help popup (same wrapper/styles/behavior as other pages) */}
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
                  Info search help
                </div>
                <div className="mt-1 text-base font-semibold">Search within this category</div>
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
                to rank pages inside this category by relevance.
              </p>

              <div className="rounded-xl border border-zinc-800 bg-black/40 p-3">
                <div className="text-[11px] font-semibold text-brand-text">
                  Chips (comma-separated terms)
                </div>
                <p className="mt-1">
                  Use chips to split your search into multiple ideas. It’s faster and helps the ranking pick up
                  different angles (parts, symptoms, chassis, etc.).
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="rounded-full border border-amber-400/60 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200">
                    s14
                  </span>
                  <span className="rounded-full border border-amber-400/60 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200">
                    subframe
                  </span>
                  <span className="rounded-full border border-amber-400/60 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200">
                    bushing
                  </span>
                </div>
                <div className="mt-2 text-[11px]">
                  Example:{" "}
                  <span className="rounded-md border border-zinc-700 bg-black/50 px-1.5 py-0.5 text-brand-text">
                    s14, subframe, bushing
                  </span>
                </div>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-black/40 p-3">
                <div className="text-[11px] font-semibold text-brand-text">
                  What gets highlighted
                </div>
                <p className="mt-1">
                  Matches can appear in the <span className="text-brand-text">title</span>,{" "}
                  <span className="text-brand-text">tags</span>,{" "}
                  <span className="text-brand-text">slug</span>,{" "}
                  <span className="text-brand-text">chassis</span>, and{" "}
                  <span className="text-brand-text">category</span> fields.
                </p>
              </div>

              <p className="text-[11px]">
                Tip: press <span className="text-brand-text">Enter</span> to turn your current text into a chip.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-[12px] text-brand-textMuted">
            {items.length === 0
              ? "No pages in this category yet."
              : `${items.length} total page${items.length === 1 ? "" : "s"} in this category.`}
          </div>

          {chassisOptions.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="text-brand-textMuted">Filter by chassis:</span>

              <button
                type="button"
                onClick={() => setChassisFilter("all")}
                className={
                  "rounded-full px-3 py-1 border text-[11px] transition " +
                  (chassisFilter === "all"
                    ? "border-amber-400 bg-amber-500/20 text-amber-300 shadow-sm shadow-black/40"
                    : "border-zinc-700 bg-black/40 text-brand-textMuted hover:text-brand-text")
                }
              >
                All
              </button>

              {chassisOptions.map((ch) => (
                <button
                  key={ch}
                  type="button"
                  onClick={() => setChassisFilter(ch)}
                  className={
                    "rounded-full px-3 py-1 border text-[11px] transition " +
                    (chassisFilter === ch
                      ? "border-amber-400 bg-amber-500/20 text-amber-300 shadow-sm shadow-black/40"
                      : "border-zinc-700 bg-black/40 text-brand-textMuted hover:text-brand-text")
                  }
                >
                  {ch}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Content */}
      <section className="space-y-3">
        {loading && (
          <p className="text-[12px] text-brand-textMuted">Loading pages for this category…</p>
        )}

        {error && <p className="text-[12px] text-rose-300/80">{error}</p>}

        {!loading && !error && filteredItems.length === 0 && (
          <p className="text-[12px] text-brand-textMuted">No pages match this filter yet.</p>
        )}

        {filteredItems.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2">
            {filteredItems.map((item) => (
              <InfoCard
                key={item.id}
                item={item}
                showCategory={false}
                showTags={true}
                maxTags={4}
                highlightTokens={searchTokens}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
