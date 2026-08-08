"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { ProductionDashboardPanel } from "@/components/staff/production/ProductionDashboardPanel";
import { StaffNavIcon } from "@/components/staff/StaffNavIcon";
import { Badge, EmptyState, MetricCard, Notice, Panel } from "@/components/ui/DesignSystem";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { canUseStaffArea, visibleStaffNav } from "@/lib/staffNavigation";
import { classifySupabaseError } from "@/lib/staff/loadState";
import { ATTENTION_VIEW, REQUIRES_ACTION_HREF, savedView, viewHref, type SavedView } from "@/lib/staff/orderFilters";
import {
  buildDashboardSummary,
  type DashboardOrder,
  type DashboardProduct,
  type DashboardRange,
} from "@/lib/staffDashboard";
import {
  ACTIVE_FULFILLMENT_BUCKETS,
  FULFILLMENT_BUCKET_COPY,
  attentionQueue,
  groupByFulfillmentBucket,
  type AttentionKind,
  type QueueOrder,
} from "@/lib/staff/operationsQueues";

/**
 * The staff home page.
 *
 * Before this pass `/staff` was a revenue chart with a workshop bar list — it
 * answered "how did the month go", which is a question for Analytics, and never
 * answered "what do I have to do now". Cancellations, returns, fulfillment and
 * stock holds were entirely absent from it despite all four being live systems.
 *
 * What it does now, in the order a shop actually reads it:
 *
 * 1. **Configuration blockers first.** An unconfigured delivery method makes
 *    every direct checkout refuse. That is not a metric, it is an outage, and
 *    it belongs above the numbers.
 * 2. **The attention queue** — every open decision, from
 *    `operationsQueues.ts`, which the fulfillment queue also reads.
 * 3. **Fulfillment counts**, each linking to the exact filtered view it counted.
 * 4. Production, money, and stock.
 *
 * Every panel is independently gated and independently loaded: a viewer with
 * only `inventory.view` gets the stock panel and no empty frames, and a slow
 * orders query does not hold back the production counts.
 */

type Profile = { id: string; username: string | null; display_name: string | null };

const ORDER_SELECT =
  "id,order_number,customer_id,product_name,status,quantity,agreed_price_cents,amount_paid_cents," +
  "amount_refunded_cents,payment_status,paid_at,target_date,created_at,updated_at,shipped_at,delivered_at," +
  "fulfillment_status,fulfillment_method,cancellation_status,return_status,shipping_carrier,tracking_number,ready_at";

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);

export default function StaffDashboardPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { data: access, isLoading: accessLoading } = useMeAccess();
  const permissions = useMemo(() => new Set(access?.permissions ?? []), [access]);

  const canViewOrders = permissions.has("orders.view") || permissions.has("orders.manage");
  const canViewCatalog = permissions.has("catalog.view") || permissions.has("catalog.manage");
  const canViewInventory = permissions.has("inventory.view") || permissions.has("inventory.manage");
  const canViewProduction = permissions.has("production.view") || permissions.has("production.manage");
  const canViewFulfillment = permissions.has("fulfillment.view") || permissions.has("fulfillment.manage");
  const canViewSettings = permissions.has("commerce.settings.view") || permissions.has("commerce.settings.manage");
  const canViewAnalytics = permissions.has("analytics.view");
  const canUseStaff = canUseStaffArea(permissions);

  const [orders, setOrders] = useState<QueueOrder[]>([]);
  const [products, setProducts] = useState<DashboardProduct[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [range, setRange] = useState<DashboardRange>("30d");
  const [now, setNow] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  /*
   * Failures are tracked per source, not as one banner.
   *
   * A single `error` string plus panels that keep rendering their empty states
   * is the pass-5a mistake in a new place: the queue showed an error while the
   * cards beside it read "0 open, 0 overdue". A staff member scanning this page
   * sees the zeros, not the sentence above them — so a panel whose data failed
   * says so *in the panel*, and never shows a count it does not have.
   */
  const [ordersError, setOrdersError] = useState("");
  const [productsError, setProductsError] = useState("");
  const [deliveryBlocked, setDeliveryBlocked] = useState<string | null>(null);

  useEffect(() => {
    if (!canUseStaff) return;
    void (async () => {
      setLoading(true);
      setNow(new Date());
      const [orderResult, productResult] = await Promise.all([
        canViewOrders
          ? supabase.from("orders").select(ORDER_SELECT).order("updated_at", { ascending: false })
          : Promise.resolve({ data: [], error: null }),
        canViewCatalog || canViewInventory
          ? supabase
              .from("products")
              .select("id,name,slug,is_published,inventory_policy,inventory_quantity,low_stock_threshold,archived_at")
              .order("inventory_quantity", { ascending: true })
          : Promise.resolve({ data: [], error: null }),
      ]);
      // A refused query yields no rows at all, so the state is cleared rather
      // than left holding a previous load that the panel would then present as
      // current.
      const orderRows = (orderResult.error ? [] : (orderResult.data ?? [])) as unknown as QueueOrder[];
      setOrders(orderRows);
      setProducts((productResult.error ? [] : (productResult.data ?? [])) as DashboardProduct[]);
      if (orderRows.length) {
        const profileResult = await supabase
          .from("profiles")
          .select("id,username,display_name")
          .in("id", [...new Set(orderRows.map((row) => row.customer_id))]);
        // A refused profile read leaves the names generic; it does not mean the
        // orders have no customers.
        setProfiles(Object.fromEntries(((profileResult.error ? [] : (profileResult.data ?? [])) as Profile[]).map((p) => [p.id, p])));
      }
      // Classified rather than echoed — a Postgres message names schema objects
      // and can quote row values, and these strings are rendered into panels.
      setOrdersError(orderResult.error ? classifySupabaseError(orderResult.error).message : "");
      setProductsError(productResult.error ? classifySupabaseError(productResult.error).message : "");
      setLoading(false);
    })();
  }, [canUseStaff, canViewCatalog, canViewInventory, canViewOrders, supabase]);

  /*
   * The one configuration state that silently stops the shop taking money.
   * Pass 8 shipped shipping and pickup both disabled by default and refuses
   * checkout for a physical product until one is turned on. That refusal is
   * correct — an unconfigured shop must not invent a delivery price — but with
   * nothing surfacing it, the only symptom is customers failing to check out.
   */
  useEffect(() => {
    if (!canViewSettings) return;
    void (async () => {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;
      const response = await fetch("/api/staff/commerce/settings", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) return;
      const payload = (await response.json()) as {
        settings?: { shipping?: { enabled?: boolean }; pickup?: { enabled?: boolean } };
      };
      const shipping = Boolean(payload.settings?.shipping?.enabled);
      const pickup = Boolean(payload.settings?.pickup?.enabled);
      setDeliveryBlocked(
        shipping || pickup
          ? null
          : "Neither shipping nor local pickup is enabled, so a cart holding a physical product refuses at checkout."
      );
    })();
  }, [canViewSettings, supabase]);

  /*
   * Every derived value is gated on the load having actually succeeded.
   *
   * `buildDashboardSummary([])` is perfectly happy to report $0 and zero
   * overdue, which is a confident, wrong answer. `null` here forces the panels
   * below to choose a failure state instead of rendering a number.
   */
  const ordersUsable = canViewOrders && !ordersError;

  const summary = useMemo(
    () =>
      now && ordersUsable
        ? buildDashboardSummary(orders as unknown as DashboardOrder[], products, range, now)
        : null,
    [now, orders, ordersUsable, products, range]
  );
  const attention = useMemo(() => (now && ordersUsable ? attentionQueue(orders, now) : []), [now, orders, ordersUsable]);
  const fulfillmentGroups = useMemo(() => groupByFulfillmentBucket(orders), [orders]);
  const orderById = useMemo(() => new Map(orders.map((order) => [order.id, order])), [orders]);
  const lowStock = useMemo(
    () =>
      products
        .filter(
          (product) =>
            !product.archived_at &&
            product.inventory_policy === "track" &&
            product.inventory_quantity <= product.low_stock_threshold
        )
        .sort((a, b) => a.inventory_quantity - b.inventory_quantity || a.name.localeCompare(b.name)),
    [products]
  );
  const shortcuts = useMemo(
    () => visibleStaffNav(permissions).flatMap((group) => group.items.filter((item) => item.href !== "/staff")),
    [permissions]
  );

  if (accessLoading) return <div className="ui-card p-6 text-sm text-brand-textMuted">Loading the dashboard…</div>;
  if (!canUseStaff) return <AccessDeniedCard message="You do not have access to the staff area." />;

  return (
    <main className="page-stack">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="ui-eyebrow">KeyMoura operations</p>
          <h1 className="mt-1 text-3xl font-semibold">Today at KeyMoura</h1>
          <p className="mt-2 max-w-2xl text-sm text-brand-textMuted">
            Open decisions first, then what has to go out, then the numbers.
          </p>
        </div>
        {canViewOrders ? (
          <SegmentedControl
            value={range}
            onChange={setRange}
            ariaLabel="Revenue date range"
            options={[
              { value: "30d", label: "30 days" },
              { value: "90d", label: "90 days" },
              { value: "all", label: "All time" },
            ]}
          />
        ) : null}
      </div>

      {deliveryBlocked ? (
        <Notice tone="warning" role="alert">
          <strong className="font-semibold">Checkout is blocked for physical products.</strong> {deliveryBlocked}{" "}
          <Link href="/staff/settings/commerce" className="font-semibold underline">
            Configure delivery
          </Link>
          .
        </Notice>
      ) : null}

      {/* One banner naming every source that failed. The panels below say so
          individually as well — this is the summary, not the whole warning. */}
      {ordersError || productsError ? (
        <Notice tone="danger" role="alert">
          Some dashboard data could not be loaded, so the panels that depend on it are showing an error rather
          than a count. {ordersError ? `Orders: ${ordersError}. ` : ""}
          {productsError ? `Products: ${productsError}.` : ""}
        </Notice>
      ) : null}

      {canViewOrders ? (
        <Panel>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Needs a decision</h2>
              <p className="mt-1 text-xs text-brand-textMuted">
                Cancellations, returns and blocked work, most consequential first.
              </p>
            </div>
            {/* No badge when the source failed: "0" would be a claim this page
                cannot make. */}
            {ordersUsable ? (
              <Badge tone={attention.length ? "warning" : "neutral"}>{attention.length}</Badge>
            ) : null}
          </div>
          <div className="mt-4 divide-y divide-white/10">
            {attention.slice(0, 8).map((item, index) => {
              const order = orderById.get(item.orderId);
              const profile = order ? profiles[order.customer_id] : undefined;
              return (
                <Link
                  key={`${item.kind}-${item.orderId}-${index}`}
                  href={`/staff/orders/${item.orderId}`}
                  className="grid gap-1 py-3 transition hover:text-brand-accent sm:grid-cols-[1fr_auto] sm:items-center"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.title}</p>
                    <p className="mt-1 text-xs text-brand-textMuted">{item.detail}</p>
                  </div>
                  <p className="text-xs text-brand-textMuted">
                    {profile?.display_name || (profile?.username ? `@${profile.username}` : "Customer")}
                  </p>
                </Link>
              );
            })}
          </div>
          {/*
            One link per kind of work present, each opening the queue that holds
            exactly that kind. A dashboard that can only say "here are eight
            things" makes a staff member re-find the ninth by hand.
          */}
          {ordersUsable && attention.length ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {[...new Set(attention.map((item) => item.kind))]
                .map((kind) => ({ kind, view: savedView(ATTENTION_VIEW[kind]) as SavedView | null }))
                .filter((entry): entry is { kind: AttentionKind; view: SavedView } => entry.view !== null)
                .map(({ kind, view }) => (
                  <Link
                    key={kind}
                    href={viewHref(view.id)}
                    className="rounded-full border border-brand-border px-3 py-1 text-xs font-medium text-brand-textMuted transition hover:border-brand-accent hover:text-brand-accent"
                  >
                    {view.label} ({attention.filter((item) => item.kind === kind).length})
                  </Link>
                ))}
            </div>
          ) : null}
          {ordersError ? (
            <Notice tone="danger" className="mt-5">
              Open work could not be loaded, so this list is not a statement that there is none.
            </Notice>
          ) : !loading && !attention.length ? (
            <EmptyState className="mt-5">Nothing is waiting on a decision.</EmptyState>
          ) : null}
          {loading ? <EmptyState className="mt-5">Loading open work…</EmptyState> : null}
          {/* The exact list this panel counted, not a general order list the
              reader then has to filter by hand. */}
          {attention.length > 8 ? (
            <Link href={REQUIRES_ACTION_HREF} className="mt-4 inline-block text-xs font-medium text-brand-accent hover:underline">
              {attention.length - 8} more in Orders →
            </Link>
          ) : null}
        </Panel>
      ) : null}

      {canViewFulfillment && canViewOrders ? (
        <Panel>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Fulfillment</h2>
              <p className="mt-1 text-xs text-brand-textMuted">
                Each order is in exactly one queue, so these add up.
              </p>
            </div>
            <Link href="/staff/fulfillment" className="text-xs font-medium text-brand-accent hover:underline">
              Open the queue
            </Link>
          </div>
          {ordersError ? (
            <Notice tone="danger" className="mt-4">
              The fulfillment queues could not be counted. Open the queue itself rather than trusting a number
              here.
            </Notice>
          ) : (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              {ACTIVE_FULFILLMENT_BUCKETS.map((bucket) => (
                <Link
                  key={bucket}
                  href={`/staff/fulfillment?bucket=${bucket}`}
                  className="ui-card ui-card-hover"
                  // The card and the view it opens are the same filter, so a card
                  // reading 3 cannot open a list of 5.
                >
                  <span className="block text-2xl font-semibold tabular-nums">{fulfillmentGroups[bucket].length}</span>
                  <span className="mt-1 block text-xs font-medium">{FULFILLMENT_BUCKET_COPY[bucket].label}</span>
                </Link>
              ))}
            </div>
          )}
        </Panel>
      ) : null}

      {canViewProduction ? <ProductionDashboardPanel /> : null}

      {canViewOrders && ordersError ? (
        <Panel>
          <h2 className="text-lg font-semibold">Revenue</h2>
          <Notice tone="danger" className="mt-3">
            Orders could not be read, so no revenue figure is shown. An empty chart here would read as a quiet
            month rather than as a failure.
          </Notice>
        </Panel>
      ) : null}

      {canViewOrders && summary ? (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Business summary">
            <MetricCard label="Revenue collected" value={money(summary.revenueCents)} detail={summary.revenueComparison} />
            <MetricCard label="Orders" value={String(summary.orderCount)} detail={`${summary.paidOrderCount} with payment collected`} />
            <MetricCard label="Average paid order" value={money(summary.averageOrderCents)} detail="Orders with collected payments" />
            <MetricCard
              label="Overdue"
              value={String(summary.overdue.length)}
              detail={`${summary.dueSoon.length} due within 7 days`}
              tone={summary.overdue.length ? "warning" : "default"}
            />
          </section>

          <Panel>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Revenue trend</h2>
                <p className="mt-1 text-xs text-brand-textMuted">
                  Payments collected by {range === "30d" ? "day" : range === "90d" ? "week" : "month"}
                </p>
              </div>
              {canViewAnalytics ? (
                <Link href="/staff/info/analytics" className="text-xs font-medium text-brand-accent hover:underline">
                  Full analytics
                </Link>
              ) : null}
            </div>
            <div className="mt-6 flex h-40 items-end gap-1.5" aria-label="Revenue chart">
              {summary.trend.map((point) => (
                <div
                  key={point.key}
                  className="group flex min-w-0 flex-1 flex-col items-center justify-end gap-2"
                  title={`${point.label}: ${money(point.revenueCents)}`}
                >
                  <div
                    className="w-full rounded-t-md bg-brand-accent/75 transition group-hover:bg-brand-accent"
                    style={{
                      height: `${Math.max(point.revenueCents ? 7 : 2, (point.revenueCents / Math.max(1, ...summary.trend.map((p) => p.revenueCents))) * 100)}%`,
                    }}
                  />
                  <span className="hidden text-[9px] text-brand-textMuted first:block last:block sm:block sm:[&:not(:nth-child(4n+1))]:hidden">
                    {point.label}
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        </>
      ) : null}

      {canViewInventory || canViewCatalog ? (
        <Panel>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Stock alerts</h2>
              <p className="mt-1 text-xs text-brand-textMuted">Tracked products at or below their threshold</p>
            </div>
            <Link
              href={canViewInventory ? "/staff/inventory" : "/staff/catalog"}
              className="text-xs font-medium text-brand-accent hover:underline"
            >
              {canViewInventory ? "Open inventory" : "Open catalog"}
            </Link>
          </div>
          <div className="mt-4 divide-y divide-white/10">
            {lowStock.slice(0, 6).map((product) => (
              <Link
                key={product.id}
                href={canViewInventory ? `/staff/inventory/${product.id}` : "/staff/catalog"}
                className="flex items-center justify-between gap-4 py-3 transition hover:text-brand-accent"
              >
                <div>
                  <p className="text-sm font-medium">{product.name}</p>
                  <p className="mt-1 text-xs text-brand-textMuted">{product.is_published ? "Published" : "Draft"}</p>
                </div>
                <span
                  className={`rounded-full px-2.5 py-1 text-xs ${product.inventory_quantity === 0 ? "bg-rose-500/15 text-rose-200" : "bg-amber-400/10 text-amber-200"}`}
                >
                  {product.inventory_quantity === 0 ? "Out of stock" : `${product.inventory_quantity} left`}
                </span>
              </Link>
            ))}
          </div>
          {productsError ? (
            <Notice tone="danger" className="mt-5">
              Stock could not be read. “Healthy” is not a claim this panel can make right now.
            </Notice>
          ) : !loading && !lowStock.length ? (
            <EmptyState className="mt-5">Stock levels look healthy.</EmptyState>
          ) : null}
        </Panel>
      ) : null}

      <Panel>
        <h2 className="text-lg font-semibold">Everywhere you can go</h2>
        <p className="mt-1 text-xs text-brand-textMuted">
          Every staff destination your account can open. The sidebar carries the same list.
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {shortcuts.map((item) => (
            <Link key={item.href} href={item.href} className="ui-card ui-card-hover flex items-start gap-3">
              <StaffNavIcon icon={item.icon} className="mt-0.5 h-4 w-4 shrink-0 text-brand-accent" />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{item.label}</span>
                <span className="mt-0.5 block text-xs leading-5 text-brand-textMuted">{item.description}</span>
              </span>
            </Link>
          ))}
        </div>
      </Panel>
    </main>
  );
}
