"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { Badge, EmptyState, Notice } from "@/components/ui/DesignSystem";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { FULFILLMENT_STAFF_LABELS, lifecycleLabel } from "@/lib/commerce/orderLifecycle";
import {
  ACTIVE_FULFILLMENT_BUCKETS,
  FULFILLMENT_BUCKET_COPY,
  fulfillmentNextAction,
  groupByFulfillmentBucket,
  missingTracking,
  outstandingBalanceCents,
  type FulfillmentBucket,
  type QueueOrder,
} from "@/lib/staff/operationsQueues";

/**
 * The fulfillment queue.
 *
 * The pass-8 API is complete and server-enforced but had no queue in front of
 * it, so "what has to go out today" was answerable only by opening orders one
 * at a time.
 *
 * **Filters live in the URL**, following the production queue: a dashboard card
 * links to an exact view, and a view is bookmarkable and shareable. Bucketing
 * comes from `operationsQueues.ts`, which the dashboard also reads, so a card
 * reading 3 and a queue showing 5 is not representable.
 *
 * Reads go through the browser client and RLS rather than a new staff API. The
 * columns are already staff-readable — the order cockpit reads the same table
 * the same way — and adding a route to re-fetch what RLS already permits would
 * be a second copy of the permission decision.
 */

const SELECT =
  "id,order_number,customer_id,product_name,status,quantity,agreed_price_cents,amount_paid_cents," +
  "amount_refunded_cents,payment_status,fulfillment_status,fulfillment_method,cancellation_status," +
  "return_status,shipping_carrier,tracking_number,ready_at,shipped_at,delivered_at,target_date," +
  "created_at,updated_at";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function isBucket(value: string | null): value is FulfillmentBucket {
  return Boolean(value) && (ACTIVE_FULFILLMENT_BUCKETS as readonly string[]).includes(String(value));
}

function FulfillmentQueueContent() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: access, isLoading } = useMeAccess();
  const permissions = new Set(access?.permissions ?? []);
  const canView = permissions.has("fulfillment.view") || permissions.has("fulfillment.manage");

  const [orders, setOrders] = useState<QueueOrder[]>([]);
  const [profiles, setProfiles] = useState<Record<string, { display_name: string | null; username: string | null }>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  const bucketParam = searchParams.get("bucket");
  const bucket: FulfillmentBucket | "all" = isBucket(bucketParam) ? bucketParam : "all";
  const methodParam = searchParams.get("method");
  const method = methodParam === "shipping" || methodParam === "pickup" ? methodParam : "all";

  useEffect(() => {
    if (!canView) return;
    void (async () => {
      setLoading(true);
      const result = await supabase.from("orders").select(SELECT).order("updated_at", { ascending: false });
      // A refused query is not an empty shop. Keeping `data ?? []` here is what
      // lets every bucket render a confident "0" beside an error notice.
      const rows = (result.error ? [] : (result.data ?? [])) as unknown as QueueOrder[];
      setOrders(rows);
      if (rows.length) {
        const profileResult = await supabase
          .from("profiles")
          .select("id,username,display_name")
          .in("id", [...new Set(rows.map((row) => row.customer_id))]);
        setProfiles(
          Object.fromEntries(
            ((profileResult.data ?? []) as { id: string; username: string | null; display_name: string | null }[]).map(
              (profile) => [profile.id, profile]
            )
          )
        );
      }
      setError(result.error?.message ?? "");
      setLoading(false);
    })();
  }, [canView, supabase]);

  const grouped = useMemo(() => groupByFulfillmentBucket(orders), [orders]);

  const setFilter = (next: { bucket?: string; method?: string }) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (!value || value === "all") params.delete(key);
      else params.set(key, value);
    }
    const search = params.toString();
    router.replace(search ? `/staff/fulfillment?${search}` : "/staff/fulfillment", { scroll: false });
  };

  const shown = useMemo(() => {
    const base =
      bucket === "all" ? ACTIVE_FULFILLMENT_BUCKETS.flatMap((key) => grouped[key]) : grouped[bucket];
    const term = query.trim().toLowerCase();
    return base.filter((order) => {
      if (method !== "all" && String(order.fulfillment_method || "shipping") !== method) return false;
      if (!term) return true;
      const profile = profiles[order.customer_id];
      return [order.order_number, order.product_name, order.tracking_number, profile?.display_name, profile?.username]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(term);
    });
  }, [bucket, grouped, method, profiles, query]);

  if (isLoading) return <div className="ui-card text-sm text-brand-textMuted">Loading…</div>;
  if (!canView) {
    return <AccessDeniedCard message="You need the “View fulfillment” permission to see the delivery queue." />;
  }

  const totalActive = ACTIVE_FULFILLMENT_BUCKETS.reduce((sum, key) => sum + grouped[key].length, 0);

  return (
    <main className="page-stack">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="ui-eyebrow">Commerce</p>
          <h1 className="mt-1 text-3xl font-semibold">Fulfillment</h1>
          <p className="mt-2 max-w-2xl text-sm text-brand-textMuted">
            Everything waiting to be packed, collected, shipped or confirmed. Each order sits in exactly one
            queue, so these counts add up.
          </p>
        </div>
        <Link href="/staff/settings/commerce" className="ui-btn ui-btn-ghost text-sm">
          Delivery settings
        </Link>
      </div>

      {error ? (
        <Notice tone="danger" role="alert">
          Could not load the fulfillment queue, so no counts are shown: {error}
        </Notice>
      ) : null}

      {/* The bucket cards are counts. With no data they are not zeroes, they
          are unknown — and a row of confident zeroes beside an error notice is
          read as an empty shop. */}
      {!error ? (
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="Fulfillment queues">
          {ACTIVE_FULFILLMENT_BUCKETS.map((key) => {
            const active = bucket === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setFilter({ bucket: active ? "all" : key })}
                aria-pressed={active}
                className={`ui-card ui-card-hover text-left ${active ? "!border-brand-primary !bg-brand-primary/10" : ""}`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold">{FULFILLMENT_BUCKET_COPY[key].label}</span>
                  <span className="text-2xl font-semibold tabular-nums">{grouped[key].length}</span>
                </span>
                <span className="mt-1 block text-xs leading-5 text-brand-textMuted">
                  {FULFILLMENT_BUCKET_COPY[key].description}
                </span>
              </button>
            );
          })}
        </section>
      ) : null}

      <div className="ui-filter-bar">
        <label className="min-w-[14rem] flex-1">
          <span className="sr-only">Search fulfillment queue</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="ui-input h-full"
            placeholder="Search order, product, customer or tracking…"
          />
        </label>
        <label>
          <span className="sr-only">Filter by delivery method</span>
          <select
            value={method}
            onChange={(event) => setFilter({ method: event.target.value })}
            className="ui-input h-full"
          >
            <option value="all">All methods</option>
            <option value="shipping">Shipping</option>
            <option value="pickup">Local pickup</option>
          </select>
        </label>
        {bucket !== "all" || method !== "all" ? (
          <button type="button" onClick={() => setFilter({ bucket: "all", method: "all" })} className="ui-btn ui-btn-ghost text-sm">
            Clear filters
          </button>
        ) : null}
      </div>

      {!error ? (
        <p className="text-xs text-brand-textMuted" aria-live="polite">
          {bucket === "all"
            ? `${shown.length} of ${totalActive} orders in the live queues`
            : `${shown.length} in ${FULFILLMENT_BUCKET_COPY[bucket].label.toLowerCase()}`}
        </p>
      ) : null}

      <div className="space-y-3">
        {shown.map((order) => {
          const profile = profiles[order.customer_id];
          const customer = profile?.display_name || (profile?.username ? `@${profile.username}` : "Customer");
          const balance = outstandingBalanceCents(order);
          return (
            <Link
              key={order.id}
              href={`/staff/orders/${order.id}#fulfillment`}
              className="ui-card ui-card-hover grid gap-4 md:grid-cols-[1.5fr_1fr_auto] md:items-center"
            >
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{order.product_name}</span>
                  {order.quantity > 1 ? <Badge>Qty {order.quantity}</Badge> : null}
                  <Badge tone={String(order.fulfillment_method) === "pickup" ? "accent" : "neutral"}>
                    {String(order.fulfillment_method) === "pickup" ? "Pickup" : "Shipping"}
                  </Badge>
                  {missingTracking(order) ? <Badge tone="warning">No tracking</Badge> : null}
                </div>
                <div className="mt-1 text-xs text-brand-textMuted">
                  {order.order_number || "New request"} · {customer}
                </div>
              </div>
              <div>
                <div className="text-sm font-medium text-brand-accent">{fulfillmentNextAction(order)}</div>
                <div className="mt-1 text-xs text-brand-textMuted">
                  {lifecycleLabel(FULFILLMENT_STAFF_LABELS, String(order.fulfillment_status || "unfulfilled"))}
                  {order.tracking_number ? ` · ${order.shipping_carrier || "Carrier"} ${order.tracking_number}` : ""}
                </div>
              </div>
              <div className="text-left md:text-right">
                <div className="font-medium">{balance > 0 ? `${money(balance)} due` : "Paid in full"}</div>
                <div className="mt-1 text-xs text-brand-textMuted">
                  {order.target_date ? `Target ${order.target_date}` : "No target date"}
                </div>
              </div>
            </Link>
          );
        })}
      </div>

      {loading ? <EmptyState>Loading the fulfillment queue…</EmptyState> : null}
      {/* "Nothing is waiting to go out" is a claim about the shop. It must not
          be made when the query that would have shown the work was refused. */}
      {!loading && !error && shown.length === 0 ? (
        <EmptyState>
          {query || method !== "all" || bucket !== "all"
            ? "Nothing matches this view."
            : "Nothing is waiting to go out. Every order is either delivered, collected or not yet payable."}
        </EmptyState>
      ) : null}
    </main>
  );
}

export default function StaffFulfillmentQueuePage() {
  // `useSearchParams` needs a Suspense boundary; without one the whole route
  // opts into client-side rendering and the production build refuses to
  // prerender it. Same shape as the production queue, which puts its filters in
  // the URL for the same reason.
  return (
    <Suspense
      fallback={
        <p className="text-sm text-brand-textMuted" role="status">
          Loading the fulfillment queue…
        </p>
      }
    >
      <FulfillmentQueueContent />
    </Suspense>
  );
}
