"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { Field } from "@/components/ui/DesignSystem";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StaffPage,
  StatusChip,
} from "@/components/staff/StaffPage";
import { useMeAccess } from "@/lib/hooks/useMeAccess";

/**
 * The inventory overview.
 *
 * ## What this pass changed
 *
 * Seven filter buttons of equal weight — All, Tracked, Untracked, Low stock,
 * Out of stock, Made to order, Backorder — expressed as primary/secondary
 * buttons rather than as the filter chips every other staff queue uses, above a
 * table with no threshold column and no way to act on a row. To adjust stock
 * you clicked the product name, which looked like a link to the product editor.
 *
 * Now: four views for the four inventory *tasks* — everything, what is running
 * out, what has run out, and what is currently held by a checkout — with the
 * rest behind Filters. Each row carries the threshold the state is derived from
 * and an explicit **Adjust** action, so the row says what it is and what you can
 * do about it.
 *
 * The view lives in the URL, which it did not before: the dashboard's "Adjust
 * inventory" quick action opens `?view=low_stock`, and a bookmarked view is
 * shareable between staff.
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

/** The four inventory tasks. Everything else is a refinement, not a task. */
const PRIMARY_VIEWS = [
  { key: "all", label: "All products" },
  { key: "low_stock", label: "Low stock" },
  { key: "out_of_stock", label: "Out of stock" },
  { key: "reserved", label: "Reservations" },
] as const;

const SECONDARY_VIEWS = [
  { key: "tracked", label: "Tracked only" },
  { key: "untracked", label: "Untracked only" },
  { key: "made_to_order", label: "Made to order" },
  { key: "backorder", label: "Backorder enabled" },
] as const;

const AVAILABILITY_LABELS: Record<string, string> = {
  in_stock: "In stock",
  low_stock: "Low stock",
  out_of_stock: "Out of stock",
  backorder: "On backorder",
  made_to_order: "Made to order",
  untracked: "Not tracked",
};

/** Mapped onto the shared chip tones so stock reads like every other state. */
const AVAILABILITY_TONE: Record<string, "neutral" | "accent" | "warning" | "danger" | "success"> = {
  in_stock: "success",
  low_stock: "warning",
  out_of_stock: "danger",
  backorder: "accent",
  made_to_order: "neutral",
  untracked: "neutral",
};

function InventoryContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: access, isLoading: accessLoading } = useMeAccess();
  const permissions = useMemo(() => new Set(access?.permissions ?? []), [access]);
  const canManage = permissions.has("inventory.manage");

  const filter = searchParams.get("view") ?? "all";
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /** Distinguishes "the query succeeded and matched nothing" from "the query failed". */
  const [loadFailed, setLoadFailed] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(
    () => SECONDARY_VIEWS.some((view) => view.key === filter)
  );

  const setView = (next: string) => {
    setPage(0);
    const params = new URLSearchParams(searchParams.toString());
    if (next === "all") params.delete("view");
    else params.set("view", next);
    const query = params.toString();
    router.replace(query ? `/staff/inventory?${query}` : "/staff/inventory", { scroll: false });
  };

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
             * this view." and a total of 0 underneath its own error banner.
             * Nothing is a claim the page can make about stock it could not
             * read.
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

  if (accessLoading) return <LoadingState>Loading inventory…</LoadingState>;

  // A permission-denied state that names the permission, rather than a red
  // retry box with a button that can never succeed.
  if (!permissions.has("inventory.view")) {
    return <AccessDeniedCard message="You need the inventory.view permission to see stock levels." />;
  }

  return (
    <StaffPage>
      <PageHeader
        title="Inventory"
        description="On hand is what is in the building. Reserved is held by a checkout in progress. Available is what the next customer can actually buy."
      />

      <nav aria-label="Inventory views" className="staff-views">
        {PRIMARY_VIEWS.map((view) => (
          <button
            key={view.key}
            type="button"
            onClick={() => setView(view.key)}
            aria-current={filter === view.key ? "page" : undefined}
            className="staff-view"
          >
            {view.label}
          </button>
        ))}
      </nav>

      <div className="staff-toolbar">
        <label className="staff-toolbar-search">
          <span className="sr-only">Search inventory by name or SKU</span>
          <input
            className="ui-input w-full"
            value={search}
            onChange={(event) => {
              setPage(0);
              setSearch(event.target.value);
            }}
            placeholder="Search by product name or SKU…"
          />
        </label>
        <button
          type="button"
          onClick={() => setFiltersOpen((open) => !open)}
          aria-expanded={filtersOpen}
          aria-controls="staff-inventory-filters"
          className="ui-btn ui-btn-ghost text-sm"
        >
          Filters
        </button>
      </div>

      {filtersOpen ? (
        <div id="staff-inventory-filters" className="staff-filter-panel">
          <Field label="Narrow by product setting" help="How stock behaves for this product, rather than its level.">
            <select
              className="ui-input w-full"
              value={SECONDARY_VIEWS.some((view) => view.key === filter) ? filter : ""}
              onChange={(event) => setView(event.target.value || "all")}
            >
              <option value="">No extra filter</option>
              {SECONDARY_VIEWS.map((view) => (
                <option key={view.key} value={view.key}>
                  {view.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : null}

      {error ? <ErrorState>{error}</ErrorState> : null}

      {loading ? (
        <LoadingState>Loading stock levels…</LoadingState>
      ) : loadFailed ? (
        // No table, and no "none match" — the answer is unknown, not empty.
        <EmptyState>
          Stock levels are not shown because they could not be loaded. This is not the same as there being none.
        </EmptyState>
      ) : !items.length ? (
        <EmptyState>No products match this view.</EmptyState>
      ) : (
        <div className="ui-table-wrap">
          <table className="w-full min-w-[52rem] text-sm">
            <caption className="sr-only">Products and their stock levels</caption>
            <thead>
              <tr className="border-b border-[var(--border)] text-left">
                <th scope="col" className="staff-fact-label p-3">Product</th>
                <th scope="col" className="staff-fact-label p-3">SKU</th>
                <th scope="col" className="staff-fact-label p-3 text-right">On hand</th>
                <th scope="col" className="staff-fact-label p-3 text-right">Reserved</th>
                <th scope="col" className="staff-fact-label p-3 text-right">Available</th>
                <th scope="col" className="staff-fact-label p-3 text-right">Threshold</th>
                <th scope="col" className="staff-fact-label p-3">State</th>
                <th scope="col" className="staff-fact-label p-3 text-right">
                  <span className="sr-only">Actions</span>
                </th>
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
                  {/* The number the state is derived from. Without it, "Low
                      stock" beside "4 available" is an assertion the reader
                      cannot check. */}
                  <td className="p-3 text-right tabular-nums text-brand-textMuted">
                    {item.tracked ? item.lowStockThreshold : "—"}
                  </td>
                  <td className="p-3">
                    <StatusChip
                      value={item.availability}
                      tone={AVAILABILITY_TONE[item.availability] ?? "neutral"}
                      label={AVAILABILITY_LABELS[item.availability] ?? item.availability}
                    />
                  </td>
                  <td className="p-3 text-right">
                    <Link
                      href={`/staff/inventory/${item.id}`}
                      className="text-xs font-semibold text-brand-accent hover:underline"
                    >
                      {canManage ? "Adjust" : "History"} →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <nav className="staff-toolbar justify-between" aria-label="Pagination">
        <button
          type="button"
          className="ui-btn ui-btn-secondary text-sm disabled:opacity-50"
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
          className="ui-btn ui-btn-secondary text-sm disabled:opacity-50"
          disabled={!hasMore}
          onClick={() => setPage((current) => current + 1)}
        >
          Next
        </button>
      </nav>
    </StaffPage>
  );
}

export default function StaffInventoryPage() {
  // `useSearchParams` needs a Suspense boundary; without one the route opts
  // into client-side rendering and the production build refuses to prerender it.
  return (
    <Suspense fallback={<LoadingState>Loading inventory…</LoadingState>}>
      <InventoryContent />
    </Suspense>
  );
}
