"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Badge } from "@/components/ui/DesignSystem";

export type PickedProduct = {
  id: string;
  name: string;
  slug: string;
  image: string | null;
  isPublished: boolean;
};

type Suggestion = { id: string; name: string; slug: string; image: string | null; category: string | null };

/**
 * Choose a product by searching for it.
 *
 * ## Not a UUID field
 *
 * The alternative this replaces is the one that writes itself: a text input
 * labelled "Featured product ID". It is faster to build and it asks the owner to
 * go to the catalog, open a product, read a UUID out of the address bar and
 * paste it — and it fails silently when they paste the wrong one, because one
 * UUID looks exactly like another.
 *
 * So the control searches. The endpoint is `/api/public/catalog-suggest`, the
 * same one behind the storefront's own search box, which matters for a reason
 * beyond reuse: it only ever returns **published** products. The owner cannot
 * pick something a customer could not see, so the "don't feature a draft" rule
 * is enforced by which options exist rather than by a check somewhere that has
 * to be remembered.
 *
 * ## The current selection is shown differently
 *
 * A stored pin is resolved by the *staff* endpoint, with the service client, so
 * it comes back even when the product has since been unpublished — and says so.
 * That is the one thing the public endpoint cannot tell the owner, and it is
 * exactly the thing they need to know: the homepage has quietly fallen back to
 * catalog order, and nothing on screen would otherwise say so.
 */
export function ProductPicker({
  label,
  description,
  selected,
  onSelect,
}: {
  label: string;
  description: string;
  selected: PickedProduct | null;
  onSelect: (product: PickedProduct | null) => void;
}) {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }

    // Debounced, because this fires per keystroke and the endpoint is a real
    // database query rather than a filter over something already loaded.
    setSearching(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const response = await fetch(`/api/public/catalog-suggest?q=${encodeURIComponent(term)}`);
        const body = await response.json();
        setResults((body.products ?? []) as Suggestion[]);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 220);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query]);

  return (
    <div className="rounded-[var(--control-radius)] border border-brand-border p-3">
      <p className="text-sm font-semibold">{label}</p>
      <p className="mt-1 text-xs text-brand-textMuted">{description}</p>

      {selected ? (
        <div className="mt-3 flex items-center gap-3 rounded-[var(--control-radius)] border border-brand-border bg-[var(--panel-strong)] p-2">
          {selected.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={selected.image} alt="" className="h-12 w-12 rounded object-cover" />
          ) : (
            <span className="flex h-12 w-12 items-center justify-center rounded bg-[var(--panel)] text-[10px] text-brand-textMuted">
              No image
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{selected.name}</p>
            {/* The warning that justifies resolving this through the staff
                endpoint. Without it, unpublishing the featured product changes
                the homepage and leaves this panel looking correct. */}
            {selected.isPublished ? (
              <p className="mt-0.5 truncate text-xs text-brand-textMuted">/catalog/{selected.slug}</p>
            ) : (
              <p className="mt-0.5 text-xs text-amber-300">
                Not published — the homepage is using catalog order instead.
              </p>
            )}
          </div>
          <button type="button" onClick={() => onSelect(null)} className="ui-btn ui-btn-ghost !py-1.5 text-xs">
            Clear
          </button>
        </div>
      ) : (
        <p className="mt-3 text-xs text-brand-textMuted">
          <Badge>Automatic</Badge>{" "}
          <span className="align-middle">Using the first product in catalog order.</span>
        </p>
      )}

      <label htmlFor={inputId} className="ui-label mt-3 block">
        {selected ? "Choose a different product" : "Search products"}
      </label>
      <input
        id={inputId}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Start typing a product name…"
        className="ui-input"
      />

      <p aria-live="polite" className="mt-1 text-xs text-brand-textMuted">
        {query.trim().length >= 2
          ? searching
            ? "Searching…"
            : `${results.length} published ${results.length === 1 ? "product" : "products"} match.`
          : "Only published products can be featured."}
      </p>

      {results.length ? (
        <ul className="mt-2 grid gap-1.5">
          {results.map((product) => (
            <li key={product.id}>
              <button
                type="button"
                onClick={() => {
                  onSelect({ ...product, isPublished: true });
                  setQuery("");
                  setResults([]);
                }}
                className="ui-card ui-card-hover flex w-full items-center gap-2.5 !p-2 text-left"
              >
                {product.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={product.image} alt="" className="h-9 w-9 rounded object-cover" />
                ) : (
                  <span className="h-9 w-9 rounded bg-[var(--panel-strong)]" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{product.name}</span>
                  {product.category ? (
                    <span className="block truncate text-xs text-brand-textMuted">{product.category}</span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
