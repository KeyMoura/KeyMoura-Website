"use client";

import { useEffect, useId, useRef, useState } from "react";

import { cx } from "@/components/ui/DesignSystem";
import {
  APPEARANCE_CLUSTERS,
  APPEARANCE_SECTIONS,
  searchAppearance,
  type AppearanceSearchEntry,
  type AppearanceSectionId,
} from "@/theme/appearanceSections";

/**
 * The editor's furniture: the section rail, the search, the section header and
 * the action bar.
 *
 * These are together because they are the parts that make the editor *an
 * editor* rather than a form, and because each of them is a place the old page
 * lost the plot in the same way — by explaining itself. The old rail printed a
 * full sentence under every one of its eight entries, which made a list you had
 * to read instead of one you could scan, and made the rail tall enough to need
 * its own scroll on a laptop. The description belongs on the section you have
 * opened, once, where it is answering a question you have already asked.
 */

/* ------------------------------------------------------------------------ */
/* Navigating to a control                                                   */
/* ------------------------------------------------------------------------ */

/** The DOM id a searchable control carries. One helper so the two ends agree. */
export function anchorId(anchor: string): string {
  return `appearance-${anchor}`;
}

/**
 * Scroll to a control, open anything hiding it, and put focus in it.
 *
 * Focus, not only scroll: scrolling alone leaves a keyboard user's caret back in
 * the search field, so their next Tab returns them to the result list they just
 * left rather than to the setting they chose.
 *
 * The highlight is an inline style rather than a class, deliberately. A new
 * `globals.css` rule is not served until `.next` is cleared, and a Tailwind
 * utility that appears in no scanned source file is never generated at all —
 * either way the cue silently does nothing, which is the worst possible failure
 * for a confirmation.
 */
export function focusControl(anchor: string) {
  const target = document.getElementById(anchorId(anchor));
  if (!target) return;
  target.closest("details")?.setAttribute("open", "");
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.focus({ preventScroll: true });
  target.style.outline = "2px solid var(--brand-primary)";
  target.style.outlineOffset = "3px";
  window.setTimeout(() => {
    target.style.outline = "";
    target.style.outlineOffset = "";
  }, 1800);
}

/**
 * A block of controls that search can reach.
 *
 * `tabIndex={-1}` is what lets `focusControl` focus it — a `<section>` is not
 * focusable otherwise, and `scroll-mt-4` keeps its heading clear of the
 * workspace's top edge once `scrollIntoView` lands.
 */
export function ControlGroup({
  anchor,
  title,
  description,
  children,
}: {
  anchor: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={anchorId(anchor)} tabIndex={-1} className="scroll-mt-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description ? <p className="mt-1 text-xs text-brand-textMuted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------------ */
/* Search                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Search across every setting in the editor, not only the colours.
 *
 * The old field filtered the colour list in place, which meant the six things
 * this pass was asked to make easy — the announcement message, the logo, the
 * featured product, the hero image, the site name toggle, Add to cart — matched
 * nothing at all, because none of them is a colour. This one searches
 * `APPEARANCE_SEARCH_INDEX`, and a result carries the section it lives in, so
 * choosing it opens that section and lands on the control.
 *
 * The results are a listbox with roving `aria-activedescendant` rather than a
 * list of buttons: arrow keys move through matches while the query stays
 * editable, which is what makes it usable without a mouse.
 */
export function AppearanceSearch({
  onGo,
}: {
  onGo: (entry: AppearanceSearchEntry) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const results = searchAppearance(query).slice(0, 8);
  const showing = open && Boolean(query.trim());

  // A click anywhere else closes the list. Without this the results hang over
  // the workspace after the pointer has moved on and look like part of it.
  useEffect(() => {
    if (!showing) return;
    const onDown = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showing]);

  const choose = (entry: AppearanceSearchEntry | undefined) => {
    if (!entry) return;
    setOpen(false);
    setQuery("");
    onGo(entry);
  };

  return (
    <div ref={boxRef} className="relative w-full sm:max-w-md">
      <label htmlFor={id} className="sr-only">
        Search appearance settings
      </label>
      <input
        id={id}
        type="search"
        role="combobox"
        aria-expanded={showing}
        aria-controls={`${id}-results`}
        aria-activedescendant={showing && results[cursor] ? `${id}-r${cursor}` : undefined}
        autoComplete="off"
        value={query}
        placeholder="Search settings — navbar, announcement, add to cart…"
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          // Reset the highlight here rather than in an effect on `query`: the
          // result list changes as a *consequence* of this keystroke, so the
          // cursor belongs in the same update rather than in a second render
          // that reacts to the first.
          setCursor(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (!showing) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setCursor((value) => Math.min(value + 1, results.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setCursor((value) => Math.max(value - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            choose(results[cursor]);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
        className="ui-input"
      />

      {showing ? (
        <div
          id={`${id}-results`}
          role="listbox"
          aria-label="Settings matching your search"
          className="ui-select-menu absolute inset-x-0 top-full z-40 mt-1 max-h-80 overflow-y-auto p-1"
        >
          {results.length === 0 ? (
            <p className="p-3 text-xs text-brand-textMuted">
              Nothing matches “{query.trim()}”. Try the name of something you can see — “cart”, “logo”,
              “announcement”, “price”.
            </p>
          ) : (
            results.map((entry, index) => (
              <button
                key={entry.anchor}
                id={`${id}-r${index}`}
                role="option"
                aria-selected={index === cursor}
                type="button"
                onMouseEnter={() => setCursor(index)}
                onClick={() => choose(entry)}
                className={cx("ui-select-option !block", index === cursor && "is-active")}
              >
                <span className="block text-sm font-semibold">{entry.label}</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-brand-textMuted">
                  {sectionLabel(entry.section)} · {entry.context}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function sectionLabel(id: AppearanceSectionId): string {
  return APPEARANCE_SECTIONS.find((section) => section.id === id)?.label ?? id;
}

/* ------------------------------------------------------------------------ */
/* The section rail                                                          */
/* ------------------------------------------------------------------------ */

/**
 * The section list, clustered.
 *
 * Thirteen flat entries is a list to read. Three headed clusters — what
 * customers see, how the system looks, how the business is described — is a
 * place to look, and it is the first branch an owner actually makes.
 *
 * One line per entry, no descriptions. The old rail printed a sentence under
 * each of its eight, which is 24 lines of prose you have to read past on every
 * visit to reach the one word you came for.
 */
export function SectionRail({
  section,
  onSelect,
}: {
  section: AppearanceSectionId;
  onSelect: (id: AppearanceSectionId) => void;
}) {
  return (
    <nav className="ui-card appearance-rail !p-2" aria-label="Appearance sections">
      {APPEARANCE_CLUSTERS.map((cluster) => (
        <div key={cluster.id} className="mb-2 last:mb-0">
          <p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[.12em] text-brand-textMuted">
            {cluster.label}
          </p>
          <ul>
            {APPEARANCE_SECTIONS.filter((entry) => entry.cluster === cluster.id).map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => onSelect(entry.id)}
                  aria-current={section === entry.id ? "page" : undefined}
                  className={cx(
                    "w-full rounded-[var(--control-radius)] px-2.5 py-1.5 text-left text-[13px] transition-colors",
                    section === entry.id
                      ? "bg-brand-primary/12 font-semibold text-brand-primary"
                      : "text-brand-text hover:bg-white/5"
                  )}
                >
                  {entry.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/**
 * The same list as a `<select>`, for widths where a rail would be a wall.
 *
 * A native select rather than a custom drawer: it is one control, it is already
 * keyboard- and screen-reader-correct, and on a phone it opens the platform's
 * own picker — which is a better list of thirteen things than anything that
 * could be built here.
 */
export function SectionPicker({
  section,
  onSelect,
}: {
  section: AppearanceSectionId;
  onSelect: (id: AppearanceSectionId) => void;
}) {
  const id = useId();
  return (
    <div className="lg:hidden">
      <label htmlFor={id} className="ui-label">
        Section
      </label>
      <select
        id={id}
        value={section}
        onChange={(event) => onSelect(event.target.value as AppearanceSectionId)}
        className="ui-input"
      >
        {APPEARANCE_CLUSTERS.map((cluster) => (
          <optgroup key={cluster.id} label={cluster.label}>
            {APPEARANCE_SECTIONS.filter((entry) => entry.cluster === cluster.id).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* The action bar                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Publish, discard, and whether anything is waiting.
 *
 * Not `position: fixed`. The old bar was, and it covered whatever scrolled
 * underneath it for the whole height of the page — `pb-24` reserves space at the
 * end of a document, not along it. This one is the last flex child of a shell
 * that is exactly viewport-high, so it is always visible *and* always below the
 * content rather than over it. `.appearance-shell` records the layout in full.
 *
 * `changed` is a count rather than a boolean because "you have unpublished
 * changes" answers a question nobody asked. The owner knows they changed
 * something; what they cannot see, three sections later, is how much.
 */
export function ActionBar({
  dirty,
  changed,
  busy,
  onPublish,
  onDiscard,
}: {
  dirty: boolean;
  changed: number;
  busy: boolean;
  onPublish: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="ui-card appearance-actions flex flex-wrap items-center justify-between gap-3 !py-2.5">
      <p className="text-xs text-brand-textMuted" aria-live="polite">
        {dirty ? (
          <>
            <span className="mr-1.5 inline-block size-2 rounded-full bg-brand-primary align-middle" aria-hidden="true" />
            <b className="font-semibold text-brand-text">
              {changed} unpublished {changed === 1 ? "change" : "changes"}
            </b>
          </>
        ) : (
          "Everything here is published."
        )}
      </p>
      <div className="ui-action-row">
        <button
          type="button"
          onClick={onDiscard}
          disabled={!dirty || busy}
          className="ui-btn ui-btn-ghost !py-1.5 text-xs disabled:opacity-40"
        >
          Discard changes
        </button>
        <button
          type="button"
          onClick={onPublish}
          disabled={!dirty || busy}
          className="ui-btn ui-btn-primary !py-1.5 text-xs disabled:opacity-40"
        >
          {busy ? "Publishing…" : "Publish appearance"}
        </button>
      </div>
    </div>
  );
}
