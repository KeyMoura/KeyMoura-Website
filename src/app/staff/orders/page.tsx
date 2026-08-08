"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StaffPage,
  StatusChip,
} from "@/components/staff/StaffPage";
import { Badge, Field, Notice } from "@/components/ui/DesignSystem";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";
import {
  PAYMENT_STATUSES,
  FULFILLMENT_STATUSES,
  FULFILLMENT_METHODS,
  ORDER_KINDS,
  PRIMARY_SAVED_VIEWS,
  PRIORITIES,
  SECONDARY_SAVED_VIEWS,
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
 * ## The truthfulness rules, unchanged
 *
 * - Nothing is derived from a load that has not succeeded. `LoadState` makes
 *   that structural: there is no way to reach `.data` without narrowing to
 *   `ready`, so a count *cannot* come from a failure.
 * - A count that is not known renders as **nothing**, never as `0`.
 * - "No orders match" is shown only for a successful query that returned no
 *   rows. A failure gets a failure, and they do not look alike.
 * - Filtering, sorting and paging are the server's job.
 *
 * ## What this pass changed
 *
 * The page opened with **sixteen chips** — one per saved view plus "All orders"
 * — wrapping over three lines at 1280px, and then a filter bar of **nine
 * always-visible controls**: a search box, a submit button, five dropdowns, two
 * date pickers and a sort. Twenty-six controls stood between the heading and
 * the first order.
 *
 * Now: six chips for the queues a shop actually works through, a toolbar of
 * three controls, and everything else behind a **Filters** disclosure that says
 * how many are active. Nothing was removed — the other nine views moved into
 * the panel as a dropdown, which is also where they can be combined with a
 * date range, which the chip row never allowed.
 *
 * Each row is a **record line** rather than a card: order, customer, date, and
 * then the three states this shop runs on — payment, production, fulfillment —
 * followed by the total and the action required. That is the column set a staff
 * member scans down, and it is now the same left-to-right order on every row.
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
const money = (cents: number | null) => (cents == null ? "Price pending" : `$${(cents / 100).toFixed(2)}`);

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

/** Which tab of the workspace an order's next action is performed on. */
function actionTab(order: OrderRow): string {
  if (order.cancellation_open || order.return_open) return "returns";
  if (order.has_failed_refund || order.fulfillment_bucket === "awaiting_payment") return "payment";
  if (order.missing_tracking) return "fulfillment";
  if (order.status === "requested" || order.status === "needs_information") return "overview";
  if (order.status === "accepted" && order.agreed_price_cents == null) return "payment";
  if (["to_prepare", "in_progress", "ready", "in_transit"].includes(order.fulfillment_bucket)) return "fulfillment";
  return "overview";
}

function StaffOrdersContent() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: access, isLoading: accessLoading } = useMeAccess();
  const permissions = useMemo(() => new Set(access?.permissions ?? []), [access]);
  const canView = permissions.has("orders.view") || permissions.has("orders.manage");
  const canManage = permissions.has("orders.manage");

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
   * mismatched key reads as loading.
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

  const activeFilters = describeActiveFilters(filters);
  /*
   * The panel opens itself when something inside it is applied.
   *
   * A collapsed panel hiding an active date range is how a staff member
   * concludes the shop has three orders. `useState` with a lazy initial value
   * rather than an effect: the correct state is known at first render.
   */
  const [filtersOpen, setFiltersOpen] = useState(() => activeFilters.length > 0);

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
  const currentView = savedView(filters.view);

  if (accessLoading) return <LoadingState>Loading orders…</LoadingState>;
  if (!canView) return <AccessDeniedCard message="You do not have access to orders." />;

  return (
    <StaffPage>
      <PageHeader
        title="Orders"
        description={
          currentView?.description ??
          "Every order, and where each one is. Open an order to manage all of it — payment, production, fulfillment, returns and messages are on that one page."
        }
        actions={
          canManage ? (
            <Link href="/staff/orders/new" className="ui-btn ui-btn-primary text-sm">
              New order
            </Link>
          ) : null
        }
      />

      {/* Six queues, in the order a shop works them. A chip shows a count only
          when the server supplied one: "Refund failures (0)" beside a failure
          notice is the exact lie this page was rebuilt to stop telling. */}
      <nav aria-label="Order queues" className="staff-views">
        <button
          type="button"
          onClick={() => navigate({ ...emptyFilters(), sort: filters.sort })}
          aria-current={!filters.view && !activeFilters.length ? "page" : undefined}
          className="staff-view"
        >
          All orders
          {payload?.counts ? <span className="staff-view-count">{payload.total}</span> : null}
        </button>
        {PRIMARY_SAVED_VIEWS.map((view) => {
          const count = payload?.counts?.[view.id];
          return (
            <button
              key={view.id}
              type="button"
              onClick={() => navigate({ ...emptyFilters(), view: view.id })}
              aria-current={filters.view === view.id ? "page" : undefined}
              title={view.description}
              className="staff-view"
            >
              {view.label}
              {/* `count === undefined` means unknown, and renders as nothing. */}
              {typeof count === "number" ? <span className="staff-view-count">{count}</span> : null}
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

      {/* ---- Toolbar: three controls, then everything else behind Filters ---- */}
      <form
        className="staff-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          navigate({ ...filters, view: null, search: searchDraft.trim(), page: 1 });
        }}
      >
        <label className="staff-toolbar-search">
          <span className="sr-only">Search orders</span>
          <input
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            className="ui-input w-full"
            placeholder="Order number, product or customer…"
            type="search"
          />
        </label>
        <button type="submit" className="ui-btn ui-btn-secondary text-sm">
          Search
        </button>
        <button
          type="button"
          onClick={() => setFiltersOpen((open) => !open)}
          aria-expanded={filtersOpen}
          aria-controls="staff-order-filters"
          className="ui-btn ui-btn-ghost text-sm"
        >
          Filters
          {activeFilters.length ? <span className="ml-1.5 tabular-nums">({activeFilters.length})</span> : null}
        </button>
        <label>
          <span className="sr-only">Sort orders</span>
          <select
            className="ui-input"
            aria-label="Sort orders"
            value={filters.sort}
            onChange={(event) => navigate({ ...filters, page: 1, sort: event.target.value as OrderFilters["sort"] })}
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

      {filtersOpen ? <FilterPanel filters={filters} onNavigate={navigate} /> : null}

      {activeFilters.length ? (
        <div className="flex flex-wrap items-center gap-2" aria-label="Active filters">
          <span className="staff-fact-label">Filtered by</span>
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
        <ErrorState onRetry={() => setReloadToken((token) => token + 1)}>
          <p className="font-semibold">{state.failure.message}</p>
          <p className="mt-1 text-sm opacity-90">
            No count or list is shown, because the answer is unknown — not zero.
            {state.failure.reference ? ` Reference ${state.failure.reference}.` : ""}
          </p>
        </ErrorState>
      ) : null}

      {state.status === "loading" ? <LoadingState>Loading orders…</LoadingState> : null}

      {payload?.degraded.customerSearch ? (
        <Notice tone="warning" role="status">
          Customer names could not be searched, so these results match on order number and product only. Orders matching
          only a customer name are missing from this list.
        </Notice>
      ) : null}

      {payload ? (
        <>
          {payload.orders.length ? (
            <div className="staff-rows">
              {payload.orders.map((order) => (
                <OrderLine key={order.id} order={order} degradedNames={payload.degraded.customerNames} />
              ))}
            </div>
          ) : null}

          {/* Only a *successful* query that returned nothing earns this sentence. */}
          {payload.orders.length === 0 ? (
            <EmptyState>
              {hasActiveFilters(filters)
                ? "No orders match these filters. That is a complete answer — the query succeeded and found none."
                : "There are no orders yet."}
            </EmptyState>
          ) : null}

          {payload.total > 0 ? <Pagination payload={payload} filters={filters} onNavigate={navigate} /> : null}
        </>
      ) : null}
    </StaffPage>
  );
}

/**
 * One order, as a record line.
 *
 * The column order is fixed — identity, then the three states, then money, then
 * what to do — because the value of a list is that the eye can travel straight
 * down one column. The card this replaced put the states in a sentence whose
 * length depended on which of them were set.
 *
 * The link carries the tab the work is done on, so clicking a row that says
 * "Add the missing tracking number" opens Fulfillment, not Overview.
 */
function OrderLine({ order, degradedNames }: { order: OrderRow; degradedNames: boolean }) {
  const customer =
    order.customer?.display_name ||
    (order.customer?.username ? `@${order.customer.username}` : degradedNames ? "Customer name unavailable" : "Customer");
  return (
    <Link href={`/staff/orders/${order.id}#${actionTab(order)}`} className="staff-row">
      <div className="staff-row-main">
        <div className="flex flex-wrap items-center gap-2">
          <span className="staff-row-title">{order.product_name}</span>
          {order.quantity > 1 ? <Badge>Qty {order.quantity}</Badge> : null}
          {order.priority && order.priority !== "normal" ? (
            <Badge tone={order.priority === "urgent" ? "danger" : order.priority === "high" ? "warning" : "neutral"}>
              {pretty(order.priority)}
            </Badge>
          ) : null}
        </div>
        <div className="staff-row-detail">
          {order.order_number || "New request"} · {customer} ·{" "}
          {new Date(order.created_at).toLocaleDateString()}
        </div>
        {/* The three states this shop runs on, always in this order. */}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <StatusChip value={order.payment_status} prefix="Payment · " />
          {order.production_status ? <StatusChip value={order.production_status} prefix="Production · " /> : null}
          {order.fulfillment_status !== "not_required" ? (
            <StatusChip value={order.fulfillment_status} prefix="Delivery · " />
          ) : null}
          {order.order_kind === "direct_purchase" ? <Badge tone="neutral">Direct</Badge> : null}
          {order.cancellation_open ? <Badge tone="danger">Cancellation</Badge> : null}
          {order.return_open ? <Badge tone="warning">Return</Badge> : null}
          {order.has_failed_refund ? <Badge tone="danger">Refund failed</Badge> : null}
          {order.has_inventory_issue ? <Badge tone="warning">Stock hold</Badge> : null}
          {order.is_overdue ? <Badge tone="warning">Overdue</Badge> : null}
        </div>
      </div>
      <div className="staff-row-aside flex-col !items-start gap-1 sm:!items-end">
        <span className="text-sm font-medium">{money(order.agreed_price_cents)}</span>
        <span className="text-xs font-semibold text-brand-accent">{nextAction(order)} →</span>
        {order.outstanding_cents > 0 ? (
          <span className="staff-row-meta">${(order.outstanding_cents / 100).toFixed(2)} outstanding</span>
        ) : order.target_date ? (
          <span className="staff-row-meta">
            Target {new Date(`${order.target_date}T00:00:00`).toLocaleDateString()}
          </span>
        ) : null}
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
    <nav className="staff-toolbar justify-between" aria-label="Pagination">
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

/**
 * Everything that is not one of the six queues.
 *
 * Including the nine remaining saved views, as one dropdown. Rendering them as
 * chips beside the six made every view look equally likely; here they read as
 * what they are — a longer list you go and get when you want one of them. Being
 * in the panel also means a view can now be combined with a date range, which
 * the chip row never allowed.
 */
function FilterPanel({
  filters,
  onNavigate,
}: {
  filters: OrderFilters;
  onNavigate: (next: OrderFilters) => void;
}) {
  const select = <K extends keyof OrderFilters>(
    key: K,
    label: string,
    options: readonly string[],
    allLabel: string
  ) => {
    const current = (filters[key] as unknown as string[])[0] ?? "";
    return (
      <Field label={label}>
        <select
          className="ui-input w-full"
          value={current}
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
      </Field>
    );
  };

  return (
    <div id="staff-order-filters" className="staff-filter-panel">
      <Field label="More queues" help="Named presets over the same filters.">
        <select
          className="ui-input w-full"
          value={SECONDARY_SAVED_VIEWS.some((view) => view.id === filters.view) ? String(filters.view) : ""}
          onChange={(event) =>
            onNavigate(
              event.target.value ? { ...emptyFilters(), view: event.target.value } : { ...filters, view: null }
            )
          }
        >
          <option value="">Choose a queue…</option>
          {SECONDARY_SAVED_VIEWS.map((view) => (
            <option key={view.id} value={view.id}>
              {view.label}
            </option>
          ))}
        </select>
      </Field>
      {select("payment", "Payment state", PAYMENT_STATUSES, "Any payment")}
      {select("fulfillment", "Delivery state", FULFILLMENT_STATUSES, "Any delivery state")}
      {select("method", "Delivery method", FULFILLMENT_METHODS, "Any method")}
      {select("kind", "Order type", ORDER_KINDS, "Any type")}
      {select("priority", "Priority", PRIORITIES, "Any priority")}
      <Field label="Created from">
        <input
          type="date"
          className="ui-input w-full"
          value={filters.from ?? ""}
          onChange={(event) => onNavigate({ ...filters, view: null, page: 1, from: event.target.value || null })}
        />
      </Field>
      <Field label="Created to">
        <input
          type="date"
          className="ui-input w-full"
          value={filters.to ?? ""}
          onChange={(event) => onNavigate({ ...filters, view: null, page: 1, to: event.target.value || null })}
        />
      </Field>
    </div>
  );
}

export default function StaffOrdersPage() {
  // `useSearchParams` needs a Suspense boundary; without one the route opts into
  // client-side rendering and the production build refuses to prerender it.
  return (
    <Suspense fallback={<LoadingState>Loading the order queue…</LoadingState>}>
      <StaffOrdersContent />
    </Suspense>
  );
}
