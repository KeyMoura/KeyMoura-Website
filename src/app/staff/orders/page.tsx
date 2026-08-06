"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { Badge, EmptyState, Notice } from "@/components/ui/DesignSystem";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";
import {
  PAYMENT_STATUSES,
  FULFILLMENT_STATUSES,
  FULFILLMENT_METHODS,
  ORDER_KINDS,
  PRIORITIES,
  SAVED_VIEWS,
  clearFilter,
  describeActiveFilters,
  emptyFilters,
  hasActiveFilters,
  parseOrderFilters,
  savedView,
  serializeOrderFilters,
  type OrderFilters,
} from "@/lib/staff/orderFilters";
import {
  failed,
  isFailed,
  isReady,
  loading as loadingState,
  ready,
  type LoadState,
} from "@/lib/staff/loadState";

/**
 * The staff order queue.
 *
 * ## The defect this page was rebuilt for
 *
 * It selected every order into the browser, filtered them in JavaScript, and
 * derived its tab counts from `orderResult.data ?? []`. A refused query is
 * `[]`, so the page rendered **"Needs action (0)"** and **"Nothing in this
 * view."** underneath a red error banner. Pass 9 fixed exactly this shape of
 * bug on the dashboard and the fulfillment queue and recorded that it survived
 * here; this is that fix, plus the server-side filtering the counts need in
 * order to be true.
 *
 * ## The rules now
 *
 * - Nothing is derived from a load that has not succeeded. `LoadState` makes
 *   that structural: there is no way to reach `.data` without narrowing to
 *   `ready` first, so a count *cannot* come from a failure.
 * - A count that is not known renders as **nothing**, never as `0`.
 * - "No orders match" is shown only for a successful query that returned no
 *   rows. A failure gets a failure, and they do not look alike.
 * - Filtering, sorting and paging are the server's job. The browser receives
 *   one page.
 */

type OrderRow = {
  id: string;
  order_number: string | null;
  customer_id: string;
  product_name: string;
  status: string;
  order_kind: string;
  quantity: number;
  agreed_price_cents: number | null;
  payment_status: string;
  fulfillment_status: string;
  fulfillment_method: string;
  outstanding_cents: number;
  fulfillment_bucket: string;
  missing_tracking: boolean;
  is_overdue: boolean;
  has_failed_refund: boolean;
  has_inventory_issue: boolean;
  cancellation_open: boolean;
  return_open: boolean;
  production_status: string | null;
  priority: string | null;
  target_date: string | null;
  created_at: string;
  updated_at: string;
  customer: { display_name: string | null; username: string | null } | null;
};

type Payload = {
  orders: OrderRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  counts: Record<string, number> | null;
  degraded: { customerSearch: boolean; customerNames: boolean; counts: boolean };
};

const pretty = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
const prettyStatus = (value: string) =>
  value === "customer_review" ? "Quote review" : value === "final_review" ? "Finished product review" : pretty(value);
const money = (cents: number | null) => (cents == null ? "Price pending" : `$${(cents / 100).toFixed(2)}`);

function ageLabel(value: string) {
  const hours = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 3_600_000));
  if (hours < 1) return "Updated just now";
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.floor(hours / 24)}d ago`;
}

/** What this order is waiting on, from the server's derived bucket. */
function nextAction(order: OrderRow): string {
  if (order.cancellation_open) return "Decide the cancellation request";
  if (order.return_open) return "Progress the return";
  if (order.has_failed_refund) return "A refund failed — retry it";
  if (order.missing_tracking) return "Add the missing tracking number";
  if (order.status === "requested") return "Review request";
  if (order.status === "accepted" && order.agreed_price_cents == null) return "Prepare quote";
  if (order.status === "needs_information") return "Waiting on customer details";
  if (order.fulfillment_bucket === "awaiting_payment") return "Collect the balance";
  if (order.fulfillment_bucket === "to_prepare") return "Start preparing this order";
  if (order.fulfillment_bucket === "in_progress") return order.fulfillment_method === "pickup" ? "Mark ready for collection" : "Pack and ship";
  if (order.fulfillment_bucket === "ready") return order.fulfillment_method === "pickup" ? "Waiting for collection" : "Buy a label and ship";
  if (order.fulfillment_bucket === "in_transit") return "Confirm delivery when it lands";
  return "View order";
}

const CHIP = "rounded-full border px-3 py-1.5 text-xs font-semibold transition";

function StaffOrdersContent() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: access, isLoading: accessLoading } = useMeAccess();
  const permissions = useMemo(() => new Set(access?.permissions ?? []), [access]);
  const canView = permissions.has("orders.view") || permissions.has("orders.manage");

  /*
   * Filters live in the URL and nowhere else.
   *
   * No `useState` mirror: a second copy is what makes the back button
   * disagree with the list. The URL is the state, so browser history, a
   * bookmark and a dashboard deep link are all the same mechanism.
   */
  const filters = useMemo(() => parseOrderFilters(searchParams), [searchParams]);
  const queryString = useMemo(() => serializeOrderFilters(filters), [filters]);
  const [reloadToken, setReloadToken] = useState(0);
  /** What the stored result belongs to. A retry counts as a different load. */
  const loadKey = `${queryString}#${reloadToken}`;

  /*
   * Loading is *derived*, not assigned from an effect.
   *
   * Storing the key the result belongs to means a result for a previous filter
   * set is never presented as the current one — the stale-data window between
   * "the URL changed" and "the fetch resolved" simply does not exist, because a
   * mismatched key reads as loading. Setting `loading` from an effect would
   * produce the same picture one render later, with a cascading render for
   * every navigation.
   */
  const [result, setResult] = useState<{ key: string; state: LoadState<Payload> }>({
    key: "",
    state: loadingState<Payload>(),
  });
  const state: LoadState<Payload> = result.key === loadKey ? result.state : loadingState<Payload>();

  /*
   * The search box is the one control with local state, because a keystroke must
   * not push a history entry. It is re-synced from the URL during render — the
   * pattern React documents for adjusting state when an input changes — rather
   * than from an effect, which would render once with the stale text.
   */
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [syncedSearch, setSyncedSearch] = useState(filters.search);
  if (syncedSearch !== filters.search) {
    setSyncedSearch(filters.search);
    setSearchDraft(filters.search);
  }

  const navigate = useCallback(
    (next: OrderFilters) => router.push(`/staff/orders?${serializeOrderFilters(next)}`),
    [router]
  );

  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    void (async () => {
      try {
        const session = await supabase.auth.getSession();
        const token = session.data.session?.access_token;
        const response = await fetch(`/api/staff/orders?${queryString}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (cancelled) return;
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string; reference?: string; kind?: string };
          setResult({
            key: loadKey,
            state: failed<Payload>({
              message:
                body.kind === "permission"
                  ? "You do not have access to these orders, or your session has expired. Sign in again and retry."
                  : body.error || "The order list could not be loaded.",
              kind: body.kind === "permission" ? "permission" : "server",
              reference: body.reference,
            }),
          });
          return;
        }
        setResult({ key: loadKey, state: ready((await response.json()) as Payload) });
      } catch {
        if (!cancelled) {
          setResult({
            key: loadKey,
            state: failed<Payload>({
              message: "The order list could not be reached. Check your connection and retry.",
              kind: "network",
            }),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canView, loadKey, queryString, supabase]);

  const payload = isReady(state) ? state.data : null;
  const activeFilters = describeActiveFilters(filters);
  const currentView = savedView(filters.view);

  if (accessLoading) return <div className="ui-card" role="status">Loading…</div>;
  if (!canView) return <AccessDeniedCard message="You do not have access to orders." />;

  return (
    <main className="page-stack">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[.2em] text-brand-accent">Commerce</p>
          <h1 className="mt-1 text-3xl font-semibold">Order cockpit</h1>
          <p className="mt-2 max-w-2xl text-sm text-brand-textMuted">
            {currentView?.description ??
              "Every order, filtered the way the shop works. Pick a queue or narrow it yourself — the filters live in the address bar, so a view can be bookmarked and shared."}
          </p>
        </div>
        <Link href="/staff/orders/new" className="ui-btn ui-btn-primary w-full text-center text-sm sm:w-auto">
          Create proposal
        </Link>
      </div>

      {/* Saved views. A tab shows a count only when the server supplied one:
          "Refund failures (0)" beside a failure notice is the exact lie this
          page was rebuilt to stop telling. */}
      <nav aria-label="Order queues" className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => navigate({ ...emptyFilters(), sort: filters.sort })}
          aria-current={!filters.view && !activeFilters.length ? "page" : undefined}
          className={`${CHIP} ${!filters.view && !activeFilters.length ? "border-brand-accent bg-brand-accent/15 text-brand-accent" : "border-brand-border text-brand-textMuted hover:text-brand-text"}`}
        >
          All orders
          {payload ? <span className="ml-1.5 tabular-nums opacity-70">{payload.counts ? payload.total : ""}</span> : null}
        </button>
        {SAVED_VIEWS.map((view) => {
          const count = payload?.counts?.[view.id];
          const active = filters.view === view.id;
          return (
            <button
              key={view.id}
              type="button"
              onClick={() => navigate({ ...emptyFilters(), view: view.id })}
              aria-current={active ? "page" : undefined}
              title={view.description}
              className={`${CHIP} ${active ? "border-brand-accent bg-brand-accent/15 text-brand-accent" : "border-brand-border text-brand-textMuted hover:text-brand-text"}`}
            >
              {view.label}
              {/* `count === undefined` means unknown, and renders as nothing. */}
              {typeof count === "number" ? <span className="ml-1.5 tabular-nums opacity-70">{count}</span> : null}
            </button>
          );
        })}
      </nav>

      {payload?.degraded.counts ? (
        <Notice tone="warning" role="status">
          Queue totals could not be counted, so the numbers beside each queue are hidden rather than shown as zero. The
          list below is unaffected.
        </Notice>
      ) : null}

      <FilterBar
        filters={filters}
        searchDraft={searchDraft}
        onSearchDraft={setSearchDraft}
        onNavigate={navigate}
      />

      {activeFilters.length ? (
        <div className="flex flex-wrap items-center gap-2" aria-label="Active filters">
          <span className="text-xs font-semibold uppercase tracking-wide text-brand-textMuted">Filtered by</span>
          {activeFilters.map((filter) => (
            <button
              key={String(filter.key)}
              type="button"
              onClick={() => navigate(clearFilter(filters, filter.key))}
              className="ui-badge ui-badge-accent gap-1.5"
            >
              <span>
                {filter.label}: {filter.value}
              </span>
              <span aria-hidden="true">×</span>
              <span className="sr-only">Remove this filter</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => navigate(emptyFilters())}
            className="text-xs font-semibold text-brand-accent underline underline-offset-4"
          >
            Clear all
          </button>
        </div>
      ) : null}

      {/* ---- The three states, kept visually distinct ---- */}

      {isFailed(state) ? (
        <Notice tone="danger" role="alert">
          <p className="font-semibold">{state.failure.message}</p>
          <p className="mt-1 text-sm opacity-90">
            No count or list is shown, because the answer is unknown — not zero.
            {state.failure.reference ? ` Reference ${state.failure.reference}.` : ""}
          </p>
          <button
            type="button"
            onClick={() => setReloadToken((token) => token + 1)}
            className="ui-btn ui-btn-secondary mt-3 text-sm"
          >
            Retry
          </button>
        </Notice>
      ) : null}

      {state.status === "loading" ? (
        <EmptyState role="status">Loading orders…</EmptyState>
      ) : null}

      {payload?.degraded.customerSearch ? (
        <Notice tone="warning" role="status">
          Customer names could not be searched, so these results match on order number and product only. Orders matching
          only a customer name are missing from this list.
        </Notice>
      ) : null}

      {payload ? (
        <>
          <div className="space-y-3">
            {payload.orders.map((order) => (
              <OrderCard key={order.id} order={order} degradedNames={payload.degraded.customerNames} />
            ))}
          </div>

          {/* Only a *successful* query that returned nothing earns this sentence. */}
          {payload.orders.length === 0 ? (
            <EmptyState>
              {hasActiveFilters(filters)
                ? "No orders match these filters. That is a complete answer — the query succeeded and found none."
                : "There are no orders yet."}
            </EmptyState>
          ) : null}

          {payload.total > 0 ? (
            <Pagination payload={payload} filters={filters} onNavigate={navigate} />
          ) : null}
        </>
      ) : null}
    </main>
  );
}

function OrderCard({ order, degradedNames }: { order: OrderRow; degradedNames: boolean }) {
  const customer = order.customer?.display_name
    || (order.customer?.username ? `@${order.customer.username}` : degradedNames ? "Customer name unavailable" : "Customer");
  return (
    <Link
      href={`/staff/orders/${order.id}`}
      className="ui-card ui-card-hover group grid gap-4 md:grid-cols-[1.6fr_1fr_auto] md:items-center"
    >
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{order.product_name}</span>
          {order.quantity > 1 ? <Badge>Qty {order.quantity}</Badge> : null}
          {order.priority && order.priority !== "normal" ? (
            <Badge tone={order.priority === "urgent" ? "danger" : order.priority === "high" ? "warning" : "neutral"}>
              {pretty(order.priority)}
            </Badge>
          ) : null}
          {order.order_kind === "direct_purchase" ? <Badge tone="neutral">Direct</Badge> : null}
          {order.cancellation_open ? <Badge tone="danger">Cancellation</Badge> : null}
          {order.return_open ? <Badge tone="warning">Return</Badge> : null}
          {order.has_failed_refund ? <Badge tone="danger">Refund failed</Badge> : null}
          {order.has_inventory_issue ? <Badge tone="warning">Stock hold</Badge> : null}
          {order.is_overdue ? <Badge tone="warning">Overdue</Badge> : null}
        </div>
        <div className="mt-1 text-xs text-brand-textMuted">
          {order.order_number || "New request"} · {customer} · {ageLabel(order.updated_at)}
        </div>
      </div>
      <div>
        <div className="text-sm font-medium text-brand-accent">{nextAction(order)}</div>
        <div className="mt-1 text-xs text-brand-textMuted">
          {prettyStatus(order.status)} · {pretty(order.payment_status)}
          {order.production_status ? ` · ${pretty(order.production_status)}` : ""}
        </div>
      </div>
      <div className="text-left md:text-right">
        <div className="font-medium">{money(order.agreed_price_cents)}</div>
        <div className="mt-1 text-xs text-brand-textMuted">
          {order.outstanding_cents > 0
            ? `$${(order.outstanding_cents / 100).toFixed(2)} outstanding`
            : order.target_date
              ? `Target ${new Date(`${order.target_date}T00:00:00`).toLocaleDateString()}`
              : "No target date"}
        </div>
      </div>
    </Link>
  );
}

function Pagination({
  payload,
  filters,
  onNavigate,
}: {
  payload: Payload;
  filters: OrderFilters;
  onNavigate: (next: OrderFilters) => void;
}) {
  const first = (payload.page - 1) * payload.pageSize + 1;
  const last = Math.min(payload.total, payload.page * payload.pageSize);
  return (
    <nav className="ui-filter-bar items-center justify-between" aria-label="Pagination">
      <p className="text-sm text-brand-textMuted" aria-live="polite">
        Showing <span className="tabular-nums">{first}</span>–<span className="tabular-nums">{last}</span> of{" "}
        <span className="tabular-nums font-semibold">{payload.total}</span>
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="ui-btn ui-btn-secondary text-sm"
          disabled={payload.page <= 1}
          onClick={() => onNavigate({ ...filters, page: payload.page - 1 })}
        >
          Previous
        </button>
        <span className="text-sm text-brand-textMuted tabular-nums">
          Page {payload.page} of {payload.totalPages}
        </span>
        <button
          type="button"
          className="ui-btn ui-btn-secondary text-sm"
          disabled={payload.page >= payload.totalPages}
          onClick={() => onNavigate({ ...filters, page: payload.page + 1 })}
        >
          Next
        </button>
      </div>
    </nav>
  );
}

function FilterBar({
  filters,
  searchDraft,
  onSearchDraft,
  onNavigate,
}: {
  filters: OrderFilters;
  searchDraft: string;
  onSearchDraft: (value: string) => void;
  onNavigate: (next: OrderFilters) => void;
}) {
  /** A single-select dropdown writing into one array filter. */
  const select = <K extends keyof OrderFilters>(
    key: K,
    label: string,
    options: readonly string[],
    allLabel: string
  ) => {
    const current = (filters[key] as unknown as string[])[0] ?? "";
    return (
      <label key={String(key)}>
        <span className="sr-only">{label}</span>
        <select
          className="ui-input h-full"
          value={current}
          aria-label={label}
          onChange={(event) =>
            onNavigate({
              ...filters,
              view: null,
              page: 1,
              [key]: event.target.value ? [event.target.value] : [],
            } as OrderFilters)
          }
        >
          <option value="">{allLabel}</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {pretty(option)}
            </option>
          ))}
        </select>
      </label>
    );
  };

  return (
    <form
      className="ui-filter-bar"
      onSubmit={(event) => {
        event.preventDefault();
        onNavigate({ ...filters, view: null, search: searchDraft.trim(), page: 1 });
      }}
    >
      <label className="min-w-[14rem] flex-1">
        <span className="sr-only">Search orders</span>
        <input
          value={searchDraft}
          onChange={(event) => onSearchDraft(event.target.value)}
          className="ui-input h-full"
          placeholder="Order number, product or customer…"
          type="search"
        />
      </label>
      <button type="submit" className="ui-btn ui-btn-secondary text-sm">
        Search
      </button>
      {select("payment", "Filter by payment state", PAYMENT_STATUSES, "Any payment")}
      {select("fulfillment", "Filter by fulfillment state", FULFILLMENT_STATUSES, "Any fulfillment")}
      {select("method", "Filter by fulfillment method", FULFILLMENT_METHODS, "Any method")}
      {select("kind", "Filter by order type", ORDER_KINDS, "Any type")}
      {select("priority", "Filter by priority", PRIORITIES, "Any priority")}
      <label>
        <span className="sr-only">Created from</span>
        <input
          type="date"
          className="ui-input h-full"
          aria-label="Created from"
          value={filters.from ?? ""}
          onChange={(event) => onNavigate({ ...filters, view: null, page: 1, from: event.target.value || null })}
        />
      </label>
      <label>
        <span className="sr-only">Created to</span>
        <input
          type="date"
          className="ui-input h-full"
          aria-label="Created to"
          value={filters.to ?? ""}
          onChange={(event) => onNavigate({ ...filters, view: null, page: 1, to: event.target.value || null })}
        />
      </label>
      <label>
        <span className="sr-only">Sort orders</span>
        <select
          className="ui-input h-full"
          aria-label="Sort orders"
          value={filters.sort}
          onChange={(event) => onNavigate({ ...filters, page: 1, sort: event.target.value as OrderFilters["sort"] })}
        >
          <option value="updated_desc">Recently updated</option>
          <option value="created_desc">Newest orders</option>
          <option value="created_asc">Oldest orders</option>
          <option value="priority">Highest priority</option>
          <option value="target_date">Target date</option>
          <option value="price_desc">Highest price</option>
        </select>
      </label>
    </form>
  );
}

export default function StaffOrdersPage() {
  // `useSearchParams` needs a Suspense boundary; without one the route opts into
  // client-side rendering and the production build refuses to prerender it.
  return (
    <Suspense fallback={<p className="text-sm text-brand-textMuted" role="status">Loading the order queue…</p>}>
      <StaffOrdersContent />
    </Suspense>
  );
}
