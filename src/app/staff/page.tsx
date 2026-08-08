"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import {
  Card,
  EmptyState,
  ErrorState,
  Fact,
  Facts,
  LoadingState,
  PageHeader,
  Row,
  Rows,
  Section,
  StaffPage,
} from "@/components/staff/StaffPage";
import { Badge, Notice } from "@/components/ui/DesignSystem";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { canUseStaffArea } from "@/lib/staffNavigation";
import { classifySupabaseError } from "@/lib/staff/loadState";
import { attentionSeverity } from "@/lib/staff/pageFramework";
import {
  ATTENTION_VIEW,
  REQUIRES_ACTION_HREF,
  savedView,
  viewHref,
  type SavedView,
} from "@/lib/staff/orderFilters";
import {
  ACTIVE_FULFILLMENT_BUCKETS,
  FULFILLMENT_BUCKET_COPY,
  attentionQueue,
  groupByFulfillmentBucket,
  stockAttention,
  type AttentionKind,
  type QueueOrder,
  type StockProduct,
} from "@/lib/staff/operationsQueues";

/**
 * The staff home — the page that answers "what do I have to do now".
 *
 * ## What this replaced
 *
 * A stack of nine unrelated panels: a "Needs a decision" list, five fulfillment
 * count cards, a production panel, four revenue metric tiles, a 40-row bar
 * chart, a stock list, and — at the bottom — a grid of **every destination the
 * viewer could open**, which was a second copy of the sidebar rendered as
 * cards. The chart and the tiles answered "how did the month go", which is the
 * Analytics page's question, and they sat above the stock list, so a published
 * product at zero stock was below the fold behind a decorative graph.
 *
 * ## The shape now
 *
 * 1. **Blockers** — an unconfigured delivery method makes every checkout
 *    refuse. That is an outage, not a metric, and it stays above everything.
 * 2. **Needs attention** — one queue, merged from orders *and* stock, each row
 *    saying what happened, what has to happen, and carrying the action. Rows
 *    link to the **tab** of the order workspace where the work is done, so the
 *    dashboard hands over to the exact control rather than to a long page.
 * 3. **Today** — four numbers that describe workload, each linking to the list
 *    it counted.
 * 4. **Recent activity** — what changed, newest first.
 * 5. **Quick actions** — the four things staff start from scratch.
 *
 * The revenue chart is gone from here. It is not a decision, it was the largest
 * element on the page, and `/staff/info/analytics` exists and is linked.
 *
 * Every panel is independently gated and independently loaded: a viewer with
 * only `inventory.view` gets the stock rows and no empty frames, and a slow
 * orders query does not hold back anything else.
 */

type Profile = { id: string; username: string | null; display_name: string | null };
type Activity = { id: number; order_id: string; to_status: string; note: string | null; created_at: string };

const ORDER_SELECT =
  "id,order_number,customer_id,product_name,status,quantity,agreed_price_cents,amount_paid_cents," +
  "amount_refunded_cents,payment_status,paid_at,target_date,created_at,updated_at,shipped_at,delivered_at," +
  "fulfillment_status,fulfillment_method,cancellation_status,return_status,shipping_carrier,tracking_number,ready_at";

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);

/** How many attention rows are shown before the page defers to the full list. */
const ATTENTION_LIMIT = 10;

export default function StaffDashboardPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { data: access, isLoading: accessLoading } = useMeAccess();
  const permissions = useMemo(() => new Set(access?.permissions ?? []), [access]);

  const canViewOrders = permissions.has("orders.view") || permissions.has("orders.manage");
  const canManageOrders = permissions.has("orders.manage");
  const canViewCatalog = permissions.has("catalog.view") || permissions.has("catalog.manage");
  const canManageCatalog = permissions.has("catalog.manage");
  const canViewInventory = permissions.has("inventory.view") || permissions.has("inventory.manage");
  const canViewProduction = permissions.has("production.view") || permissions.has("production.manage");
  const canViewFulfillment = permissions.has("fulfillment.view") || permissions.has("fulfillment.manage");
  const canViewSettings = permissions.has("commerce.settings.view") || permissions.has("commerce.settings.manage");
  const canViewAnalytics = permissions.has("analytics.view");
  const canUseStaff = canUseStaffArea(permissions);

  const [orders, setOrders] = useState<QueueOrder[]>([]);
  const [products, setProducts] = useState<StockProduct[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [activity, setActivity] = useState<Activity[]>([]);
  const [now, setNow] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  /*
   * Failures are tracked per source, not as one banner.
   *
   * A single `error` string plus sections that keep rendering their empty
   * states is how a queue shows an error while the numbers beside it read "0
   * open". A section whose data failed says so *in the section*, and never
   * shows a count it does not have.
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
              .select("id,name,is_published,inventory_policy,inventory_quantity,low_stock_threshold,archived_at")
              .order("inventory_quantity", { ascending: true })
          : Promise.resolve({ data: [], error: null }),
      ]);
      // A refused query yields no rows at all, so the state is cleared rather
      // than left holding a previous load that a section would present as
      // current.
      const orderRows = (orderResult.error ? [] : (orderResult.data ?? [])) as unknown as QueueOrder[];
      setOrders(orderRows);
      setProducts((productResult.error ? [] : (productResult.data ?? [])) as StockProduct[]);
      if (orderRows.length) {
        const [profileResult, activityResult] = await Promise.all([
          supabase
            .from("profiles")
            .select("id,username,display_name")
            .in("id", [...new Set(orderRows.map((row) => row.customer_id))]),
          // The activity feed. A failure leaves it empty and the section says
          // nothing rather than claiming the shop has been quiet.
          supabase
            .from("order_status_history")
            .select("id,order_id,to_status,note,created_at")
            .order("created_at", { ascending: false })
            .limit(12),
        ]);
        setProfiles(
          Object.fromEntries(
            ((profileResult.error ? [] : (profileResult.data ?? [])) as Profile[]).map((p) => [p.id, p])
          )
        );
        setActivity((activityResult.error ? [] : (activityResult.data ?? [])) as Activity[]);
      }
      // Classified rather than echoed — a Postgres message names schema objects
      // and can quote row values, and these strings are rendered into the page.
      setOrdersError(orderResult.error ? classifySupabaseError(orderResult.error).message : "");
      setProductsError(productResult.error ? classifySupabaseError(productResult.error).message : "");
      setLoading(false);
    })();
  }, [canUseStaff, canViewCatalog, canViewInventory, canViewOrders, supabase]);

  /*
   * The one configuration state that silently stops the shop taking money.
   * Shipping and pickup both ship disabled, and checkout refuses a physical
   * product until one is turned on. That refusal is correct — an unconfigured
   * shop must not invent a delivery price — but with nothing surfacing it, the
   * only symptom is customers failing to check out.
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
   * A queue built from `[]` reports "nothing needs attention", which is a
   * confident, wrong answer. Gating forces the sections below to choose a
   * failure state instead of rendering a reassurance.
   */
  const ordersUsable = canViewOrders && !ordersError;
  const stockUsable = (canViewInventory || canViewCatalog) && !productsError;

  const orderAttention = useMemo(
    () => (now && ordersUsable ? attentionQueue(orders, now) : []),
    [now, orders, ordersUsable]
  );
  const stockRows = useMemo(() => (stockUsable ? stockAttention(products) : []), [products, stockUsable]);
  const orderById = useMemo(() => new Map(orders.map((order) => [order.id, order])), [orders]);

  /** Orders and stock in one queue, most consequential first. */
  const attention = useMemo(() => {
    const merged = [
      ...orderAttention.map((item) => ({
        key: `${item.kind}-${item.orderId}`,
        title: item.title,
        detail: item.detail,
        action: item.action,
        href: item.href,
        weight: item.weight,
        customerId: orderById.get(item.orderId)?.customer_id ?? null,
      })),
      ...stockRows.map((item) => ({
        key: `stock-${item.id}`,
        title: item.title,
        detail: item.detail,
        action: item.action,
        href: item.href,
        weight: item.weight,
        customerId: null as string | null,
      })),
    ];
    return merged.sort((a, b) => b.weight - a.weight || a.title.localeCompare(b.title));
  }, [orderAttention, orderById, stockRows]);

  const fulfillmentGroups = useMemo(() => groupByFulfillmentBucket(orders), [orders]);

  /** The four workload numbers. Each links to the list that produced it. */
  const today = useMemo(() => {
    if (!now || !ordersUsable) return null;
    const dayAgo = new Date(now.getTime() - 24 * 3_600_000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3_600_000);
    return {
      newOrders: orders.filter((order) => new Date(order.created_at) >= dayAgo).length,
      // Collected, net of refunds, over the last seven days — the number a shop
      // checks daily. Longer horizons are Analytics' job.
      collectedCents: orders
        .filter((order) => order.paid_at && new Date(order.paid_at) >= weekAgo)
        .reduce(
          (sum, order) => sum + Math.max(0, (order.amount_paid_cents || 0) - (order.amount_refunded_cents || 0)),
          0
        ),
      toMake: orders.filter((order) => order.status === "in_progress").length,
      toSend: ACTIVE_FULFILLMENT_BUCKETS.filter((bucket) => bucket !== "awaiting_payment").reduce(
        (sum, bucket) => sum + fulfillmentGroups[bucket].length,
        0
      ),
    };
  }, [fulfillmentGroups, now, orders, ordersUsable]);

  if (accessLoading) return <LoadingState>Loading the dashboard…</LoadingState>;
  if (!canUseStaff) return <AccessDeniedCard message="You do not have access to the staff area." />;

  const customerName = (customerId: string | null) => {
    if (!customerId) return null;
    const profile = profiles[customerId];
    return profile?.display_name || (profile?.username ? `@${profile.username}` : null);
  };

  return (
    <StaffPage>
      <PageHeader
        title="Dashboard"
        description="Open decisions first, then today's workload. Every row says what has to happen and takes you to where it is done."
        actions={
          canManageOrders ? (
            <Link href="/staff/orders/new" className="ui-btn ui-btn-primary text-sm">
              New order
            </Link>
          ) : null
        }
      />

      {deliveryBlocked ? (
        <Notice tone="warning" role="alert">
          <strong className="font-semibold">Checkout is blocked for physical products.</strong> {deliveryBlocked}{" "}
          <Link href="/staff/settings/commerce#shipping" className="font-semibold underline">
            Configure delivery
          </Link>
          .
        </Notice>
      ) : null}

      {/* --------------------------------------------------------------- */}
      {canViewOrders || canViewInventory || canViewCatalog ? (
        <Section
          title="Needs attention"
          description="Everything waiting on a person, most consequential first."
          actions={
            ordersUsable && orderAttention.length ? (
              <Link href={REQUIRES_ACTION_HREF} className="text-xs font-semibold text-brand-accent hover:underline">
                All open work →
              </Link>
            ) : null
          }
        >
          {ordersError ? (
            <ErrorState>
              Open order work could not be loaded, so this queue is not a statement that there is none. {ordersError}
            </ErrorState>
          ) : null}
          {productsError ? (
            <ErrorState>
              Stock could not be read, so no low-stock rows are shown. “Healthy” is not a claim this page can make
              right now. {productsError}
            </ErrorState>
          ) : null}

          {loading ? <LoadingState>Loading open work…</LoadingState> : null}

          {attention.length ? (
            <Rows>
              {attention.slice(0, ATTENTION_LIMIT).map((item) => {
                const who = customerName(item.customerId);
                return (
                  <Row
                    key={item.key}
                    href={item.href}
                    severity={attentionSeverity(item.weight)}
                    title={item.title}
                    detail={item.detail}
                    meta={who}
                    aside={
                      <span className="text-xs font-semibold text-brand-accent whitespace-nowrap">
                        {item.action} →
                      </span>
                    }
                  />
                );
              })}
            </Rows>
          ) : null}

          {/* One link per kind of work present, each opening the queue that
              holds exactly that kind. A dashboard that can only say "here are
              ten things" makes a staff member re-find the eleventh by hand. */}
          {ordersUsable && orderAttention.length ? (
            <div className="staff-views">
              {[...new Set(orderAttention.map((item) => item.kind))]
                .map((kind) => ({ kind, view: savedView(ATTENTION_VIEW[kind]) }))
                .filter((entry): entry is { kind: AttentionKind; view: SavedView } => entry.view !== null)
                .map(({ kind, view }) => (
                  <Link key={kind} href={viewHref(view.id)} className="staff-view">
                    {view.label}
                    <span className="staff-view-count">
                      {orderAttention.filter((item) => item.kind === kind).length}
                    </span>
                  </Link>
                ))}
            </div>
          ) : null}

          {!loading && !ordersError && !productsError && !attention.length ? (
            <EmptyState>Nothing is waiting on a decision. Every order and every tracked product is settled.</EmptyState>
          ) : null}
        </Section>
      ) : null}

      {/* --------------------------------------------------------------- */}
      {today ? (
        <Section
          title="Today"
          description="The shop's current workload."
          actions={
            canViewAnalytics ? (
              <Link href="/staff/info/analytics" className="text-xs font-semibold text-brand-accent hover:underline">
                Full analytics →
              </Link>
            ) : null
          }
        >
          <Card>
            <Facts>
              <Fact label="New orders (24h)">
                <Link href="/staff/orders?sort=created_desc" className="hover:text-brand-accent">
                  <span className="tabular-nums">{today.newOrders}</span>
                </Link>
              </Fact>
              <Fact label="Collected (7 days)">
                <span className="tabular-nums">{money(today.collectedCents)}</span>
              </Fact>
              <Fact label="In production">
                {canViewProduction ? (
                  <Link href="/staff/production" className="hover:text-brand-accent">
                    <span className="tabular-nums">{today.toMake}</span> to make
                  </Link>
                ) : (
                  <>
                    <span className="tabular-nums">{today.toMake}</span> to make
                  </>
                )}
              </Fact>
              <Fact label="Waiting to go out">
                {canViewFulfillment ? (
                  <Link href="/staff/fulfillment" className="hover:text-brand-accent">
                    <span className="tabular-nums">{today.toSend}</span> to send
                  </Link>
                ) : (
                  <>
                    <span className="tabular-nums">{today.toSend}</span> to send
                  </>
                )}
              </Fact>
            </Facts>

            {canViewFulfillment ? (
              <div className="staff-views mt-5 border-t border-[var(--border)] pt-4">
                {ACTIVE_FULFILLMENT_BUCKETS.map((bucket) => (
                  <Link key={bucket} href={`/staff/fulfillment?bucket=${bucket}`} className="staff-view">
                    {FULFILLMENT_BUCKET_COPY[bucket].label}
                    <span className="staff-view-count">{fulfillmentGroups[bucket].length}</span>
                  </Link>
                ))}
              </div>
            ) : null}
          </Card>
        </Section>
      ) : null}

      {/* --------------------------------------------------------------- */}
      {canViewOrders && activity.length ? (
        <Section title="Recent activity" description="What changed across the shop, newest first.">
          <Rows>
            {activity.slice(0, 8).map((entry) => {
              const order = orderById.get(entry.order_id);
              return (
                <Row
                  key={entry.id}
                  href={`/staff/orders/${entry.order_id}#activity`}
                  title={`${order?.order_number || order?.product_name || "Order"} → ${entry.to_status.replaceAll("_", " ")}`}
                  detail={entry.note || undefined}
                  aside={
                    <span className="staff-row-meta whitespace-nowrap">
                      {new Date(entry.created_at).toLocaleString()}
                    </span>
                  }
                />
              );
            })}
          </Rows>
        </Section>
      ) : null}

      {/* --------------------------------------------------------------- */}
      <Section title="Quick actions" description="The things staff start from scratch.">
        <div className="staff-views">
          {canManageCatalog ? (
            <Link href="/staff/catalog" className="staff-view">
              New product
            </Link>
          ) : null}
          {canManageOrders ? (
            <Link href="/staff/orders/new" className="staff-view">
              New custom order
            </Link>
          ) : null}
          {canViewInventory ? (
            <Link href="/staff/inventory?view=low_stock" className="staff-view">
              Adjust inventory
            </Link>
          ) : null}
          {canViewSettings ? (
            <Link href="/staff/settings/commerce" className="staff-view">
              Commerce settings
            </Link>
          ) : null}
        </div>
      </Section>

      {/* The dashboard no longer renders a grid of every destination the
          viewer can open. That was a second copy of the sidebar, three
          screens down, and it made the page longer without answering a
          question the sidebar had not already answered. */}
      {loading ? null : (
        <p className="text-xs text-brand-textMuted">
          Every staff destination is in the sidebar, and the ones you rarely need are under{" "}
          <Badge>More tools</Badge>.
        </p>
      )}
    </StaffPage>
  );
}
