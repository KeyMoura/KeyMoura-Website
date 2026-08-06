"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { useMeAccess } from "@/lib/hooks/useMeAccess";

/**
 * The inventory overview.
 *
 * Filters live in the URL-free local state deliberately: unlike the production
 * queue, no dashboard card links to a specific inventory view yet, and a
 * bookmarkable filter that nothing links to is maintenance without a reader.
 */

type InventoryItem = {
  id: string;
  name: string;
  sku: string | null;
  tracked: boolean;
  madeToOrder: boolean;
  backordersAllowed: boolean;
  isPublished: boolean;
  onHand: number;
  reserved: number;
  reservationCount: number;
  available: number | null;
  lowStockThreshold: number;
  openAlert: string | null;
  availability: string;
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "tracked", label: "Tracked" },
  { key: "untracked", label: "Untracked" },
  { key: "low_stock", label: "Low stock" },
  { key: "out_of_stock", label: "Out of stock" },
  { key: "made_to_order", label: "Made to order" },
  { key: "backorder", label: "Backorder" },
] as const;

const AVAILABILITY_LABELS: Record<string, string> = {
  in_stock: "In stock",
  low_stock: "Low stock",
  out_of_stock: "Out of stock",
  backorder: "On backorder",
  made_to_order: "Made to order",
  untracked: "Not tracked",
};

const AVAILABILITY_TONE: Record<string, string> = {
  in_stock: "text-emerald-300",
  low_stock: "text-amber-200",
  out_of_stock: "text-red-300",
  backorder: "text-sky-300",
  made_to_order: "text-brand-textMuted",
  untracked: "text-brand-textMuted",
};

export default function StaffInventoryPage() {
  const { data: access, isLoading: accessLoading } = useMeAccess();
  const permissions = new Set(access?.permissions ?? []);

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /** Distinguishes "the query succeeded and matched nothing" from "the query failed". */
  const [loadFailed, setLoadFailed] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (accessLoading || !permissions.has("inventory.view")) return;
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const params = new URLSearchParams({ page: String(page), filter });
          if (search.trim()) params.set("q", search.trim());
          const response = await fetch(`/api/staff/inventory?${params}`, { credentials: "same-origin" });
          const payload = await response.json();
          if (cancelled) return;
          if (!response.ok) {
            /*
             * A refused load clears the rows and the total.
             *
             * Leaving them behind is how this page showed "No products match
             * this view." and a total of 0 underneath its own error banner —
             * the same defect fixed on the dashboard in pass 9 and on
             * /staff/orders in this one. Nothing is a claim the page can make
             * about stock it could not read.
             */
            setError(payload?.error || "Could not load inventory.");
            setItems([]);
            setTotal(0);
            setHasMore(false);
            setLoadFailed(true);
            return;
          }
          setError("");
          setLoadFailed(false);
          setItems(payload.items ?? []);
          setHasMore(Boolean(payload.hasMore));
          setTotal(Number(payload.total ?? 0));
        } catch {
          if (!cancelled) {
            setError("Inventory could not be reached. Check your connection and retry.");
            setItems([]);
            setTotal(0);
            setHasMore(false);
            setLoadFailed(true);
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, search ? 300 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, filter, search, accessLoading, access?.permissions]);

  if (accessLoading) return <div className="ui-card text-sm text-brand-textMuted">Loading inventory…</div>;

  // A permission-denied state that names the permission, rather than a red
  // retry box with a button that can never succeed.
  if (!permissions.has("inventory.view")) {
    return <AccessDeniedCard message="You need the inventory.view permission to see stock levels." />;
  }

  return (
    <main className="page-stack">
      <header>
        <p className="ui-eyebrow">Commerce</p>
        <h1 className="mt-1 text-3xl font-semibold">Inventory</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-brand-textMuted">
          On hand is what is in the building. Reserved is held by a checkout in progress. Available is what the next
          customer can actually buy.
        </p>
      </header>

      <section className="ui-card" aria-label="Filters">
        <label className="text-sm" htmlFor="inventory-search">
          Search by name or SKU
        </label>
        <input
          id="inventory-search"
          className="ui-input mt-1 w-full"
          value={search}
          onChange={(event) => {
            setPage(0);
            setSearch(event.target.value);
          }}
          placeholder="Shift knob, KM-001…"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {FILTERS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => {
                setPage(0);
                setFilter(entry.key);
              }}
              className={`ui-btn ${filter === entry.key ? "ui-btn-primary" : "ui-btn-secondary"} text-xs`}
              aria-pressed={filter === entry.key}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </section>

      {error ? (
        <p role="alert" className="ui-notice ui-notice-danger text-sm">
          {error}
        </p>
      ) : null}

      <section aria-label="Inventory">
        {loading ? (
          <p className="ui-card text-sm text-brand-textMuted">Loading…</p>
        ) : loadFailed ? (
          // No table, and no "none match" — the answer is unknown, not empty.
          <p className="ui-card text-sm text-brand-textMuted">
            Stock levels are not shown because they could not be loaded. This is not the same as there being none.
          </p>
        ) : !items.length ? (
          <p className="ui-card text-sm text-brand-textMuted">
            No products match this view.
          </p>
        ) : (
          <div className="ui-card overflow-x-auto p-0">
            <table className="w-full min-w-[46rem] text-sm">
              <caption className="sr-only">Products and their stock levels</caption>
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-brand-textMuted">
                  <th scope="col" className="p-3">Product</th>
                  <th scope="col" className="p-3">SKU</th>
                  <th scope="col" className="p-3 text-right">On hand</th>
                  <th scope="col" className="p-3 text-right">Reserved</th>
                  <th scope="col" className="p-3 text-right">Available</th>
                  <th scope="col" className="p-3">State</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-[var(--border)] last:border-0">
                    <th scope="row" className="p-3 text-left font-medium">
                      <Link href={`/staff/inventory/${item.id}`} className="hover:text-brand-accent">
                        {item.name}
                      </Link>
                      {!item.isPublished ? (
                        <span className="ml-2 text-xs text-brand-textMuted">(unpublished)</span>
                      ) : null}
                    </th>
                    <td className="p-3 text-brand-textMuted">{item.sku || "—"}</td>
                    <td className="p-3 text-right tabular-nums">{item.tracked ? item.onHand : "—"}</td>
                    <td className="p-3 text-right tabular-nums">
                      {item.reserved > 0 ? (
                        <span title={`${item.reservationCount} active hold${item.reservationCount === 1 ? "" : "s"}`}>
                          {item.reserved}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="p-3 text-right font-medium tabular-nums">
                      {item.available === null ? "—" : item.available}
                    </td>
                    <td className={`p-3 ${AVAILABILITY_TONE[item.availability] ?? ""}`}>
                      {AVAILABILITY_LABELS[item.availability] ?? item.availability}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <nav className="flex items-center justify-between text-sm" aria-label="Pagination">
        <button
          type="button"
          className="ui-btn ui-btn-secondary disabled:opacity-50"
          disabled={page === 0}
          onClick={() => setPage((current) => Math.max(0, current - 1))}
        >
          Previous
        </button>
        <span className="text-xs text-brand-textMuted">
          {/* Withheld rather than shown as 0: an unknown count is not a count. */}
          {loadFailed || loading ? "Count unavailable" : `${total} product${total === 1 ? "" : "s"}`}
        </span>
        <button
          type="button"
          className="ui-btn ui-btn-secondary disabled:opacity-50"
          disabled={!hasMore}
          onClick={() => setPage((current) => current + 1)}
        >
          Next
        </button>
      </nav>
    </main>
  );
}
