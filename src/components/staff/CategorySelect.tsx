"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { buildCategoryTree, UNCATEGORIZED_LABEL, type CategoryRow } from "@/lib/commerce/categories";

/**
 * Searchable, hierarchical category picker.
 *
 * The catalog only ever goes two levels deep, so this is a flat list with
 * indented children rather than a collapsible tree — fewer interactions to
 * reach a leaf, and it stays usable with a keyboard and a screen reader.
 *
 * It is a listbox rather than a native <select> because the options carry a
 * second line of context (the parent trail) and a product count, which a
 * native option cannot render.
 */

export type CategoryOption = { id: string | null; label: string; parentLabel: string | null; depth: number };

export function categoryOptions(rows: readonly CategoryRow[], counts?: ReadonlyMap<string, number>): CategoryOption[] {
  const tree = buildCategoryTree(rows, counts ?? new Map());
  const options: CategoryOption[] = [{ id: null, label: UNCATEGORIZED_LABEL, parentLabel: null, depth: 0 }];

  for (const parent of tree) {
    options.push({ id: parent.id, label: parent.name, parentLabel: null, depth: 0 });
    for (const child of parent.children) {
      options.push({ id: child.id, label: child.name, parentLabel: parent.name, depth: 1 });
    }
  }
  return options;
}

/** Matches on the category name or its parent, so "Knobs" finds "Interior › Knobs". */
function matches(option: CategoryOption, term: string): boolean {
  if (!term) return true;
  const haystack = `${option.parentLabel ?? ""} ${option.label}`.toLowerCase();
  return haystack.includes(term);
}

type CategorySelectProps = {
  value: string | null;
  onChange: (categoryId: string | null) => void;
  categories: readonly CategoryRow[];
  productCounts?: ReadonlyMap<string, number>;
  disabled?: boolean;
  label?: string;
};

export function CategorySelect({
  value,
  onChange,
  categories,
  productCounts,
  disabled = false,
  label = "Category",
}: CategorySelectProps) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  const options = useMemo(() => categoryOptions(categories, productCounts), [categories, productCounts]);
  const visible = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return options.filter((option) => matches(option, needle));
  }, [options, term]);

  const selected = options.find((option) => option.id === value) ?? options[0];

  // Focus follows opening; the highlighted index is reset by whoever opens the
  // list, so this effect only syncs the DOM rather than cascading a render.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // Closing on outside click and on Escape are both required: a picker that can
  // only be dismissed by choosing something traps the user in a decision.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const commit = (option: CategoryOption) => {
    onChange(option.id);
    setOpen(false);
    setTerm("");
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      setOpen(false);
      setTerm("");
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!visible.length) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + delta + visible.length) % visible.length);
      return;
    }
    if (event.key === "Enter" && open) {
      event.preventDefault();
      const option = visible[activeIndex];
      if (option) commit(option);
    }
  };

  const describe = (option: CategoryOption) =>
    option.parentLabel ? `${option.parentLabel} › ${option.label}` : option.label;

  return (
    <div className="text-sm" ref={containerRef}>
      <span className="block">{label}</span>
      <div className="relative mt-1">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setActiveIndex(0);
            setOpen((current) => !current);
          }}
          onKeyDown={onKeyDown}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          className="ui-select-trigger w-full justify-between text-left disabled:opacity-50"
        >
          <span className={selected?.id ? "" : "text-brand-textMuted"}>{selected ? describe(selected) : UNCATEGORIZED_LABEL}</span>
          <span aria-hidden="true" className="ml-2 opacity-70">▾</span>
        </button>

        {open ? (
          <div className="ui-select-menu absolute z-30 mt-1 w-full p-2">
            <label className="sr-only" htmlFor={`${listId}-search`}>
              Search categories
            </label>
            <input
              id={`${listId}-search`}
              ref={searchRef}
              type="search"
              value={term}
              onChange={(event) => {
                setTerm(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search categories…"
              className="ui-input w-full"
            />

            <ul id={listId} role="listbox" aria-label="Categories" className="mt-2 max-h-64 overflow-y-auto">
              {visible.length ? (
                visible.map((option, index) => {
                  const isSelected = option.id === value;
                  const isActive = index === activeIndex;
                  return (
                    <li key={option.id ?? "none"} role="none">
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => commit(option)}
                        className={`ui-select-option ${isActive ? "is-active" : ""} ${
                          isSelected ? "font-semibold" : ""
                        }`}
                        style={{ paddingLeft: `${0.75 + option.depth * 1}rem` }}
                      >
                        <span>
                          {option.label}
                          {option.parentLabel ? (
                            <span className="ml-2 text-xs text-brand-textMuted">in {option.parentLabel}</span>
                          ) : null}
                        </span>
                        {option.id && productCounts?.get(option.id) != null ? (
                          <span className="text-xs text-brand-textMuted">{productCounts.get(option.id)}</span>
                        ) : null}
                      </button>
                    </li>
                  );
                })
              ) : (
                <li className="px-3 py-4 text-center text-sm text-brand-textMuted">No category matches “{term}”.</li>
              )}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
