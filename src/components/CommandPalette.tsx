"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";
import {
  availableDestinations,
  itemHref,
  KIND_LABELS,
  KIND_ORDER,
  rankSearchItems,
  suggestTerm,
  tokenize,
  type ProjectItem,
  type SearchItem,
} from "@/lib/siteSearch";

/**
 * Global site search.
 *
 * Dismissal rules, which the regression tests pin down:
 *
 * - Clicking anywhere outside the complete search interface closes the search
 *   menu. The help panel renders inside that interface, so a click on the page
 *   behind it closes the whole thing rather than leaving an orphaned panel.
 * - Clicking inside the search interface but outside the help panel does **not**
 *   close the help panel. The panel is a reference meant to be read while
 *   looking at the search controls.
 * - The help icon toggles the panel, and "Got it" closes it.
 * - Escape unwinds one layer at a time: it closes the help panel if that is
 *   open, otherwise it closes the search menu. That keeps a modal surface
 *   keyboard-dismissible without letting one keypress skip past the help panel.
 * - Closing returns focus to whatever opened the palette.
 */

// Enough rows to search well without pulling an unbounded table into the
// browser. Both queries take the most recently touched rows.
const PROJECT_LIMIT = 300;
const THREAD_LIMIT = 500;
const PRODUCT_LIMIT = 200;
const PAGE_SIZE = 6;

type Loaded = { items: SearchItem[]; signedIn: boolean };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightText(text: string, tokens: string[]): ReactNode {
  if (!text || tokens.length === 0) return text;
  const unique = Array.from(new Set(tokens.map((token) => token.trim().toLowerCase()).filter(Boolean)));
  if (unique.length === 0) return text;

  const pattern = unique.map(escapeRegExp).join("|");
  const parts = text.split(new RegExp(`(${pattern})`, "gi"));

  return parts.map((part, index) =>
    unique.includes(part.toLowerCase()) ? (
      <mark key={index} className="search-hit">
        {part}
      </mark>
    ) : (
      <span key={index}>{part}</span>
    )
  );
}

async function logSearch(rawQuery: string, tokens: string[], resultsCount: number, top: ProjectItem | null) {
  try {
    await supabaseBrowser().from("info_search_events").insert({
      source: "command-palette",
      raw_query: rawQuery,
      tokens,
      results_count: resultsCount,
      top_result_id: top?.id ?? null,
      top_result_slug: top?.slug ?? null,
    });
  } catch {
    // Search analytics must never interfere with searching.
  }
}

async function logProjectClick(payload: {
  rawQuery: string;
  tokens: string[];
  pageId: string;
  pageSlug: string;
  position: number;
  resultsCount: number;
}) {
  try {
    await supabaseBrowser().from("info_search_click_events").insert({
      source: "command-palette",
      raw_query: payload.rawQuery,
      tokens: payload.tokens,
      clicked_page_id: payload.pageId,
      clicked_page_slug: payload.pageSlug,
      position: payload.position,
      results_count: payload.resultsCount,
    });
  } catch {
    // Ignored for the same reason.
  }
}

export default function CommandPalette() {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  const [committedTerms, setCommittedTerms] = useState<string[]>([]);
  const [fragment, setFragment] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [activeIndex, setActiveIndex] = useState(0);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const helpButtonRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const chipContainerRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const closeAll = useCallback(() => {
    setOpen(false);
    setHelpOpen(false);
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 640px)");
    const apply = () => setIsMobile(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  // Ctrl/Cmd+K toggles, and the header button dispatches the same event.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key === "k" || event.key === "K") && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    const onOpen = () => setOpen(true);

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("open-command-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("open-command-palette", onOpen);
    };
  }, []);

  // Escape unwinds one layer: help first, then the menu.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (helpOpen) setHelpOpen(false);
      else setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, helpOpen]);

  // A click outside the complete interface closes the menu. Clicks inside it —
  // including clicks beside the help panel — leave the help panel alone.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current && !rootRef.current.contains(target)) closeAll();
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [open, closeAll]);

  // Focus moves into the search box on open and back to the opener on close.
  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
      setVisibleCount(PAGE_SIZE);
      setActiveIndex(0);
      setHelpOpen(false);
      inputRef.current?.focus();
      return;
    }
    restoreFocusRef.current?.focus?.();
    restoreFocusRef.current = null;
  }, [open]);

  // Keep the page behind the palette from scrolling while it is open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;

    void (async () => {
      setLoading(true);
      setError(null);
      const supabase = supabaseBrowser();

      try {
        const [{ data: session }, projects, categories, threads, products] = await Promise.all([
          supabase.auth.getSession(),
          supabase
            .from("info_pages")
            .select("id,title,slug,category,chassis,tags,content_markdown,updated_at,created_at")
            .eq("status", "approved")
            .order("updated_at", { ascending: false })
            .limit(PROJECT_LIMIT),
          supabase.from("forum_categories").select("id,slug,name").eq("is_archived", false),
          supabase
            .from("forum_threads")
            .select("id,category_id,title,slug,reply_count,is_pinned,is_locked,last_post_at,updated_at,created_at")
            .eq("is_deleted", false)
            .order("last_post_at", { ascending: false, nullsFirst: false })
            .limit(THREAD_LIMIT),
          supabase
            .from("products")
            .select("id,name,slug,short_description,category,updated_at")
            .eq("is_published", true)
            .is("archived_at", null)
            .order("sort_order")
            .limit(PRODUCT_LIMIT),
        ]);

        if (cancelled) return;

        const categoryById = new Map<number, { slug: string; name: string }>();
        for (const row of categories.data ?? []) categoryById.set(row.id as number, { slug: row.slug as string, name: row.name as string });

        const items: SearchItem[] = [
          ...(products.data ?? []).map((row) => ({
            kind: "product" as const,
            id: String(row.id),
            title: String(row.name),
            slug: String(row.slug),
            category: (row.category as string | null) ?? null,
            summary: (row.short_description as string | null) ?? null,
            updatedAt: (row.updated_at as string | null) ?? null,
          })),
          ...(projects.data ?? []).map((row) => ({
            kind: "project" as const,
            id: String(row.id),
            title: String(row.title),
            slug: String(row.slug),
            category: (row.category as string | null) ?? null,
            platform: (row.chassis as string | null) ?? null,
            tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
            body: (row.content_markdown as string | null) ?? null,
            updatedAt: (row.updated_at as string | null) ?? (row.created_at as string | null) ?? null,
          })),
          ...(threads.data ?? []).flatMap((row) => {
            const category = categoryById.get(row.category_id as number);
            if (!category) return [];
            return [
              {
                kind: "thread" as const,
                id: String(row.id),
                title: String(row.title),
                slug: String(row.slug),
                categorySlug: category.slug,
                categoryName: category.name,
                replyCount: Number(row.reply_count ?? 0),
                isPinned: Boolean(row.is_pinned),
                isLocked: Boolean(row.is_locked),
                updatedAt: (row.last_post_at as string | null) ?? (row.updated_at as string | null) ?? (row.created_at as string | null) ?? null,
              },
            ];
          }),
          ...availableDestinations(Boolean(session.session)),
        ];

        setLoaded({ items, signedIn: Boolean(session.session) });
      } catch {
        if (!cancelled) setError("Search is unavailable right now.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, loaded]);

  const searchTokens = useMemo(
    () => Array.from(new Set([...tokenize(fragment), ...committedTerms.flatMap(tokenize)])),
    [fragment, committedTerms]
  );
  const hasQuery = searchTokens.length > 0;

  const ranked = useMemo(
    () => (loaded ? rankSearchItems(loaded.items, fragment, committedTerms) : []),
    [loaded, fragment, committedTerms]
  );
  const results = useMemo(() => ranked.map((entry) => entry.item), [ranked]);
  const visibleResults = useMemo(() => results.slice(0, visibleCount), [results, visibleCount]);

  const suggestion = useMemo(() => {
    if (!loaded || !hasQuery || results.length > 0) return null;
    const last = searchTokens[searchTokens.length - 1];
    return last ? suggestTerm(loaded.items, last) : null;
  }, [loaded, hasQuery, results.length, searchTokens]);

  const rawQuery = useMemo(
    () => [...committedTerms, fragment].map((value) => value.trim()).filter(Boolean).join(" "),
    [committedTerms, fragment]
  );

  useEffect(() => {
    if (!open || !loaded || !rawQuery) return;
    const timer = setTimeout(() => {
      const topProject = results.find((item): item is ProjectItem => item.kind === "project") ?? null;
      void logSearch(rawQuery, searchTokens, results.length, topProject);
    }, 600);
    return () => clearTimeout(timer);
  }, [open, loaded, rawQuery, results, searchTokens]);

  useEffect(() => {
    setActiveIndex(0);
    setVisibleCount(PAGE_SIZE);
  }, [rawQuery]);

  const select = useCallback(
    (item: SearchItem) => {
      const position = results.findIndex((entry) => entry.kind === item.kind && entry.id === item.id);
      if (item.kind === "project") {
        void logProjectClick({
          rawQuery,
          tokens: searchTokens,
          pageId: item.id,
          pageSlug: item.slug,
          position: Math.max(position, 0),
          resultsCount: results.length,
        });
      }
      closeAll();
      router.push(itemHref(item));
    },
    [closeAll, rawQuery, results, router, searchTokens]
  );

  const commitFragment = () => {
    const value = fragment.trim();
    if (!value) return;
    setCommittedTerms((current) => (current.includes(value) ? current : [...current, value]));
    setFragment("");
    requestAnimationFrame(() => {
      const node = chipContainerRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const active = visibleResults[activeIndex];
      // Enter picks the highlighted result once one is chosen with the arrow
      // keys; otherwise it turns the typed text into a chip.
      if (activeIndex > 0 && active) select(active);
      else commitFragment();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, Math.max(visibleResults.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Backspace" && fragment.length === 0 && committedTerms.length > 0) {
      event.preventDefault();
      setCommittedTerms((current) => current.slice(0, -1));
    }
  };

  if (!open) return null;

  const grouped = KIND_ORDER.map((kind) => ({
    kind,
    items: visibleResults.filter((item) => item.kind === kind),
  })).filter((group) => group.items.length > 0);

  const statusText = loading
    ? "Searching…"
    : error
      ? error
      : results.length === 0
        ? hasQuery
          ? "No matches."
          : "Nothing to show yet."
        : `Showing ${visibleResults.length} of ${results.length} result${results.length === 1 ? "" : "s"}`;

  return (
    <div className="search-overlay">
      <div
        ref={rootRef}
        className="search-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Search this site"
        data-testid="command-palette"
      >
        <div className="search-panel-head">
          <div className="flex items-center gap-2">
            <span className="text-xs text-brand-textMuted">Search site</span>
            <button
              ref={helpButtonRef}
              type="button"
              onClick={() => setHelpOpen((value) => !value)}
              aria-expanded={helpOpen}
              aria-controls="search-help-panel"
              className="search-help-toggle"
              data-testid="search-help-toggle"
            >
              <span aria-hidden="true">?</span>
              <span className="sr-only">Search help</span>
            </button>

            <span className="ml-auto flex items-center gap-1.5">
              <kbd className="search-kbd">Ctrl+K</kbd>
              {isMobile ? (
                <button type="button" onClick={closeAll} className="ui-btn ui-btn-ghost !px-2 !py-1 text-[11px]">
                  Close
                </button>
              ) : (
                <kbd className="search-kbd">Esc</kbd>
              )}
            </span>
          </div>

          {helpOpen ? (
            <div id="search-help-panel" className="search-help" data-testid="search-help-panel">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[12px] font-semibold text-brand-text">How search works</p>
                  <ul className="mt-2 space-y-1 text-[11px] text-brand-textMuted">
                    <li>
                      Searches the <span className="text-brand-text">Catalog</span>,{" "}
                      <span className="text-brand-text">Projects</span>,{" "}
                      <span className="text-brand-text">Community threads</span>, and site sections you can open.
                    </li>
                    <li>
                      Press <span className="text-brand-text">Enter</span> or type a{" "}
                      <span className="text-brand-text">comma</span> to turn what you typed into a chip. Each chip is
                      scored separately.
                    </li>
                    <li>
                      Click a chip to remove it, or press <span className="text-brand-text">Backspace</span> on an empty
                      box.
                    </li>
                    <li>
                      <span className="text-brand-text">↑ ↓</span> move through results,{" "}
                      <span className="text-brand-text">Enter</span> opens the highlighted one.
                    </li>
                    <li>
                      <span className="text-brand-text">Esc</span> closes this panel, then the search menu.
                    </li>
                    <li>Signed-in visitors also get links to Orders, Account, Messages, and Notifications.</li>
                  </ul>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setHelpOpen(false);
                    helpButtonRef.current?.focus();
                  }}
                  className="ui-btn ui-btn-ghost shrink-0 !px-2 !py-1 text-[11px]"
                  data-testid="search-help-dismiss"
                >
                  Got it
                </button>
              </div>
            </div>
          ) : null}

          <div ref={chipContainerRef} className="search-chips scrollbar-thin" onClick={() => inputRef.current?.focus()}>
            {committedTerms.map((term) => (
              <button
                key={term}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setCommittedTerms((current) => current.filter((value) => value !== term));
                }}
                className="ui-chip is-active text-[11px]"
                aria-label={`Remove search term ${term}`}
              >
                <span>{term}</span>
                <span aria-hidden="true">×</span>
              </button>
            ))}

            <input
              ref={inputRef}
              id="command-palette-input"
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls="search-results"
              aria-label="Search products, projects, and community threads"
              autoComplete="off"
              value={fragment}
              onChange={(event) => {
                const value = event.target.value;
                if (value.endsWith(",")) {
                  const trimmed = value.slice(0, -1).trim();
                  if (trimmed) setCommittedTerms((current) => (current.includes(trimmed) ? current : [...current, trimmed]));
                  setFragment("");
                  return;
                }
                setFragment(value);
              }}
              onKeyDown={onInputKeyDown}
              placeholder="Search products, projects, and threads…"
              className="no-zoom-input min-w-[140px] flex-1 bg-transparent text-sm text-brand-text outline-none placeholder:text-brand-textMuted"
            />
          </div>

          {suggestion ? (
            <button
              type="button"
              onClick={() => {
                setCommittedTerms([]);
                setFragment(suggestion);
              }}
              className="ui-chip is-active mt-2 text-[11px]"
            >
              Did you mean <span className="font-semibold">{suggestion}</span>?
            </button>
          ) : null}
        </div>

        <div className="search-results" id="search-results">
          <p className="px-2 pb-1 text-[10px] text-brand-textMuted" role="status" aria-live="polite">
            {statusText}
          </p>

          {grouped.map((group) => (
            <section key={group.kind} aria-label={KIND_LABELS[group.kind]}>
              <p className="search-group-label">{KIND_LABELS[group.kind]}</p>
              <ul>
                {group.items.map((item) => {
                  const index = visibleResults.indexOf(item);
                  return (
                    <li key={`${item.kind}-${item.id}`}>
                      <button
                        type="button"
                        onClick={() => select(item)}
                        onMouseEnter={() => setActiveIndex(index)}
                        aria-current={index === activeIndex ? "true" : undefined}
                        className={`search-result${index === activeIndex ? " is-active" : ""}`}
                      >
                        <span className="text-[13px] font-medium text-brand-text">
                          {highlightText(item.title, searchTokens)}
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-brand-textMuted">
                          <span className="search-path">{highlightText(itemHref(item), searchTokens)}</span>
                          <ResultMeta item={item} tokens={searchTokens} />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}

          {results.length > visibleCount ? (
            <div className="mt-2 flex justify-center">
              <button
                type="button"
                onClick={() => setVisibleCount((current) => current + PAGE_SIZE)}
                className="ui-btn ui-btn-ghost !px-3 !py-1 text-[11px]"
              >
                Show {Math.min(results.length - visibleCount, PAGE_SIZE)} more
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ResultMeta({ item, tokens }: { item: SearchItem; tokens: string[] }) {
  if (item.kind === "product") {
    return item.category ? <span className="ui-chip-static text-[10px]">{highlightText(item.category, tokens)}</span> : null;
  }
  if (item.kind === "project") {
    return (
      <>
        {item.category ? <span className="ui-chip-static text-[10px]">{highlightText(item.category, tokens)}</span> : null}
        {item.tags.slice(0, 2).map((tag) => (
          <span key={tag} className="ui-chip-static text-[10px]">
            {highlightText(tag, tokens)}
          </span>
        ))}
      </>
    );
  }
  if (item.kind === "thread") {
    return (
      <>
        <span className="ui-chip-static text-[10px]">{highlightText(item.categoryName, tokens)}</span>
        <span>
          {item.replyCount} {item.replyCount === 1 ? "reply" : "replies"}
        </span>
        {item.isLocked ? <span>Locked</span> : null}
      </>
    );
  }
  return <span>{item.description}</span>;
}
