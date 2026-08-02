"use client";

import { useEffect, useId, useRef } from "react";

/**
 * The one search-help panel used by every search surface.
 *
 * Dismissal is deliberately narrow and identical everywhere:
 * - the "Got it" button closes it,
 * - the help icon that opened it toggles it closed,
 * - Escape closes it, because a modal dialog must stay keyboard-dismissible.
 *
 * Clicking outside does **not** close it. The help panel is a reference the
 * reader is meant to consult while looking at the search UI behind it, so a
 * stray click on the page must not take it away.
 */
export type SearchHelpDialogProps = {
  open: boolean;
  onClose: () => void;
  eyebrow: string;
  title: string;
  intro: string;
  /** Example chip terms rendered in the chips explainer. */
  examples: string[];
  /** The comma-separated example query shown under the chips. */
  exampleQuery: string;
  /** Fields this search actually reads, in the order they are ranked. */
  matchFields: string[];
};

export default function SearchHelpDialog({
  open,
  onClose,
  eyebrow,
  title,
  intro,
  examples,
  exampleQuery,
  matchFields,
}: SearchHelpDialogProps) {
  const headingId = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    restoreRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" data-testid="search-help-dialog">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" aria-hidden="true" />
      <div
        className="ui-card relative w-full max-w-lg text-sm text-brand-text shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">{eyebrow}</p>
            <h2 id={headingId} className="mt-1 text-base font-semibold">
              {title}
            </h2>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className="ui-btn ui-btn-ghost h-9 text-[12px]">
            Got it
          </button>
        </div>

        <div className="mt-3 space-y-3 text-[12px] text-brand-textMuted">
          <p>
            <span className="ui-chip-static mr-2 text-[11px] text-brand-text">Type</span>
            {intro}
          </p>

          <div className="ui-card">
            <p className="text-[11px] font-semibold text-brand-text">Chips (comma-separated terms)</p>
            <p className="mt-1">
              Type a comma to turn what you have written into a chip. Each chip is scored separately, so
              splitting a long search into a few short ideas usually ranks better than one sentence.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {examples.map((example) => (
                <span key={example} className="ui-chip is-active text-[11px]">
                  {example}
                </span>
              ))}
            </div>
            <p className="mt-2 text-[11px]">
              Example: <span className="ui-chip-static font-mono text-[11px] text-brand-text">{exampleQuery}</span>
            </p>
          </div>

          <div className="ui-card">
            <p className="text-[11px] font-semibold text-brand-text">What gets searched</p>
            <p className="mt-1">
              Matches are ranked across{" "}
              {matchFields.map((field, index) => (
                <span key={field}>
                  <span className="text-brand-text">{field}</span>
                  {index < matchFields.length - 2 ? ", " : index === matchFields.length - 2 ? ", and " : "."}
                </span>
              ))}{" "}
              Highlighted text marks the exact terms that matched.
            </p>
          </div>

          <p className="text-[11px]">
            Press <span className="text-brand-text">Enter</span> to turn your current text into a chip,{" "}
            <span className="text-brand-text">Backspace</span> on an empty box to remove the last one, and{" "}
            <span className="text-brand-text">Esc</span> to close this panel.
          </p>
        </div>
      </div>
    </div>
  );
}
