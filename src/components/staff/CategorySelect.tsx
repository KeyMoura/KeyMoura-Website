"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  buildCategoryTree,
  categoryTrail,
  UNCATEGORIZED_LABEL,
  visibleCategories,
  type CategoryRow,
} from "@/lib/commerce/categories";

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

export type CategoryOption = {
  id: string | null;
  label: string;
  parentLabel: string | null;
  depth: number;
  /**
   * True for a category that is archived or switched off and is only in the
   * list because this product is currently filed under it.
   */
  retired?: boolean;
};

/**
 * The choosable categories, plus — when it would otherwise vanish — the one
 * already stored on the record.
 *
 * `rows` is the **whole** table, not a pre-filtered list. That matters: only
 * active, unarchived categories may be *picked*, but a product filed under a
 * category that was archived afterwards still has to show what it is filed
 * under. Filtering before this function ran meant the picker silently displayed
 * "Uncategorized" for such a product, which is a different claim from the truth
 * and one that a careless save would have made real.
 */
export function categoryOptions(
  rows: readonly CategoryRow[],
  counts?: ReadonlyMap<string, number>,
  currentId?: string | null
): CategoryOption[] {
  const selectable = visibleCategories(rows);
  const tree = buildCategoryTree(selectable, counts ?? new Map());
  const options: CategoryOption[] = [{ id: null, label: UNCATEGORIZED_LABEL, parentLabel: null, depth: 0 }];

  for (const parent of tree) {
    options.push({ id: parent.id, label: parent.name, parentLabel: null, depth: 0 });
    for (const child of parent.children) {
      options.push({ id: child.id, label: child.name, parentLabel: parent.name, depth: 1 });
    }
  }

  if (currentId && !options.some((option) => option.id === currentId)) {
    const trail = categoryTrail(currentId, rows);
    const current = trail[trail.length - 1];
    if (current) {
      options.push({
        id: current.id,
        label: current.name,
        parentLabel: trail.length > 1 ? trail[0].name : null,
        depth: trail.length > 1 ? 1 : 0,
        retired: true,
      });
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
  /** Sits under the control, in the place a `Field`'s help text would. */
  help?: React.ReactNode;
};

export function CategorySelect({
  value,
  onChange,
  categories,
  productCounts,
  disabled = false,
  label = "Category",
  help,
}: CategorySelectProps) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  const options = useMemo(
    () => categoryOptions(categories, productCounts, value),
    [categories, productCounts, value]
  );
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

  const describe = (option: CategoryOption) => {
    const trail = option.parentLabel ? `${option.parentLabel} › ${option.label}` : option.label;
    // Said in words on the trigger, not shown as a colour or an icon: the fact
    // that the stored category is no longer offered is the whole reason this
    // row is in the list, and it is the thing somebody needs to act on.
    return option.retired ? `${trail} (archived)` : trail;
  };

  return (
    /*
     * A `div.ui-field`, not a `<label>`.
     *
     * This used to be dropped inside the shared `Field`, which *is* a `<label>`
     * — so the trigger was a button inside a label (clicking the word
     * "Category" opened the menu, which is not what a field label does) and the
     * word appeared twice, once from `Field` and once from here. The control now
     * owns its own label markup and names the button through `aria-labelledby`,
     * so a screen reader announces "Category, Interior › Knobs" rather than
     * reading the value with no idea what it is the value of.
     */
    <div className="ui-field" ref={containerRef}>
      <span className="ui-label" id={`${listId}-label`}>
        {label}
      </span>
      <div className="relative">
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
          aria-labelledby={`${listId}-label ${listId}-value`}
          className="ui-select-trigger w-full justify-between text-left disabled:opacity-50"
        >
          <span id={`${listId}-value`} className={selected?.id ? "" : "text-brand-textMuted"}>
            {selected ? describe(selected) : UNCATEGORIZED_LABEL}
          </span>
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
                          {option.retired ? (
                            <span className="ml-2 text-xs text-brand-textMuted">archived — pick another</span>
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
      {help ? <span className="ui-help">{help}</span> : null}
    </div>
  );
}
