"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { Badge, Field } from "@/components/ui/DesignSystem";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StaffPage,
  StatusChip,
} from "@/components/staff/StaffPage";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { classifySupabaseError } from "@/lib/staff/loadState";
import { supabaseBrowser } from "@/lib/supabaseClient";
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
 * **This page is a queue, and deliberately not an order editor.** It answers
 * "what has to go out, and what is waiting on someone else"; every row opens the
 * order for the actual work. That boundary is the reason the page exists rather
 * than being a filter on `/staff/orders`, and it is the one thing to preserve
 * here: the moment it grows fields to edit, there are two places to ship an
 * order from and two places for the answer to be wrong.
 *
 * ## What this pass changed
 *
 * The five buckets were a row of large cards — each a label, a two-line
 * description and a big number — that took the top 300px of the page before a
 * single order appeared. They are now the same chips the order queue uses, so
 * the work starts at the top of the screen.
 *
 * Two things were missing from the rows and are now on them: **age**, which is
 * the only way to see that an order has been sitting in "to prepare" for six
 * days, and a **Problems** view, which collects the orders whose fulfillment
 * state is wrong rather than merely early — today that is anything shipped
 * without a tracking number, which is invisible in a state-based bucket because
 * it sits in "Out for delivery" looking healthy.
 *
 * Bucketing comes from `operationsQueues.ts`, which the dashboard also reads, so
 * a card reading 3 and a queue showing 5 is not representable.
 *
 * Reads go through the browser client and RLS rather than a new staff API. The
 * columns are already staff-readable — the orders list reads the same table the
 * same way — and adding a route to re-fetch what RLS already permits would be a
 * second copy of the permission decision.
 */

const SELECT =
  "id,order_number,customer_id,product_name,status,quantity,agreed_price_cents,amount_paid_cents," +
  "amount_refunded_cents,payment_status,fulfillment_status,fulfillment_method,cancellation_status," +
  "return_status,shipping_carrier,tracking_number,ready_at,shipped_at,delivered_at,target_date," +
  "created_at,updated_at";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** The pseudo-bucket for orders whose state is wrong rather than early. */
const PROBLEMS = "problems";

function isBucket(value: string | null): value is FulfillmentBucket {
  return Boolean(value) && (ACTIVE_FULFILLMENT_BUCKETS as readonly string[]).includes(String(value));
}

/**
 * How long this order has been sitting where it is.
 *
 * Measured from the timestamp that put it in its current state, falling back to
 * `updated_at`. Age is the difference between a queue and a list: five orders
 * "to prepare" is normal, and one of them being nine days old is not.
 */
function ageLabel(order: QueueOrder): string {
  const since = order.shipped_at || order.ready_at || order.updated_at;
  const hours = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 3_600_000));
  if (hours < 1) return "Just now";
  if (hours < 24) return `${hours}h in this state`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} in this state`;
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
  const bucket: FulfillmentBucket | "all" | typeof PROBLEMS = isBucket(bucketParam)
    ? bucketParam
    : bucketParam === PROBLEMS
      ? PROBLEMS
      : "all";
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
        // A refused profile read is not "these orders have no customers": the
        // rows fall back to a generic label, and the orders themselves — which
        // is what this queue is for — are unaffected.
        setProfiles(
          Object.fromEntries(
            ((profileResult.error ? [] : (profileResult.data ?? [])) as { id: string; username: string | null; display_name: string | null }[]).map(
              (profile) => [profile.id, profile]
            )
          )
        );
      }
      // Classified, not echoed: a Postgres message names schema objects and can
      // quote row values, and this string is rendered into the page.
      setError(result.error ? classifySupabaseError(result.error).message : "");
      setLoading(false);
    })();
  }, [canView, supabase]);

  const grouped = useMemo(() => groupByFulfillmentBucket(orders), [orders]);
  /*
   * Problems overlap the state buckets on purpose.
   *
   * An order shipped without tracking sits in "Out for delivery" and looks
   * entirely healthy there; the customer has nothing to follow. Counting it in
   * both places is correct — the state buckets still partition every order, and
   * this is a cross-cutting view over them, which is why its count is not added
   * to the totals below.
   */
  const problems = useMemo(() => orders.filter((order) => missingTracking(order)), [orders]);

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
      bucket === "all"
        ? ACTIVE_FULFILLMENT_BUCKETS.flatMap((key) => grouped[key])
        : bucket === PROBLEMS
          ? problems
          : grouped[bucket];
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
  }, [bucket, grouped, method, problems, profiles, query]);

  if (isLoading) return <LoadingState>Loading…</LoadingState>;
  if (!canView) {
    return <AccessDeniedCard message="You need the “View fulfillment” permission to see the delivery queue." />;
  }

  const totalActive = ACTIVE_FULFILLMENT_BUCKETS.reduce((sum, key) => sum + grouped[key].length, 0);

  return (
    <StaffPage>
      <PageHeader
        title="Fulfillment"
        description="Everything waiting to be packed, collected, shipped or confirmed. Each order sits in exactly one queue, so these counts add up. This is a worklist — open an order to change anything on it."
        actions={
          <Link href="/staff/settings/commerce#shipping" className="ui-btn ui-btn-ghost text-sm">
            Delivery settings
          </Link>
        }
      />

      {error ? (
        <ErrorState>Could not load the fulfillment queue, so no counts are shown: {error}</ErrorState>
      ) : null}

      {/* The queues, as chips. With no data they are not zeroes, they are
          unknown — and a row of confident zeroes beside an error notice reads
          as an empty shop. */}
      {!error ? (
        <nav aria-label="Fulfillment queues" className="staff-views">
          <button
            type="button"
            onClick={() => setFilter({ bucket: "all" })}
            aria-pressed={bucket === "all"}
            className="staff-view"
          >
            All live work
            <span className="staff-view-count">{totalActive}</span>
          </button>
          {ACTIVE_FULFILLMENT_BUCKETS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter({ bucket: bucket === key ? "all" : key })}
              aria-pressed={bucket === key}
              title={FULFILLMENT_BUCKET_COPY[key].description}
              className="staff-view"
            >
              {FULFILLMENT_BUCKET_COPY[key].label}
              <span className="staff-view-count">{grouped[key].length}</span>
            </button>
          ))}
          {problems.length ? (
            <button
              type="button"
              onClick={() => setFilter({ bucket: bucket === PROBLEMS ? "all" : PROBLEMS })}
              aria-pressed={bucket === PROBLEMS}
              title="Shipped with no tracking number, so the customer has nothing to follow."
              className="staff-view"
            >
              Problems
              <span className="staff-view-count">{problems.length}</span>
            </button>
          ) : null}
        </nav>
      ) : null}

      <div className="staff-toolbar">
        <label className="staff-toolbar-search">
          <span className="sr-only">Search fulfillment queue</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="ui-input w-full"
            placeholder="Search order, product, customer or tracking…"
          />
        </label>
        <Field label="Method" className="min-w-[10rem]">
          <select
            value={method}
            onChange={(event) => setFilter({ method: event.target.value })}
            className="ui-input w-full"
          >
            <option value="all">All methods</option>
            <option value="shipping">Shipping</option>
            <option value="pickup">Local pickup</option>
          </select>
        </Field>
        {bucket !== "all" || method !== "all" ? (
          <button
            type="button"
            onClick={() => setFilter({ bucket: "all", method: "all" })}
            className="ui-btn ui-btn-ghost text-sm"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {!error ? (
        <p className="text-xs text-brand-textMuted" aria-live="polite">
          {bucket === "all"
            ? `${shown.length} of ${totalActive} orders in the live queues`
            : bucket === PROBLEMS
              ? `${shown.length} with a delivery problem`
              : `${shown.length} in ${FULFILLMENT_BUCKET_COPY[bucket].label.toLowerCase()}`}
        </p>
      ) : null}

      {shown.length ? (
        <div className="staff-rows">
          {shown.map((order) => {
            const profile = profiles[order.customer_id];
            const customer = profile?.display_name || (profile?.username ? `@${profile.username}` : "Customer");
            const balance = outstandingBalanceCents(order);
            const pickup = String(order.fulfillment_method) === "pickup";
            return (
              <div key={order.id} className="staff-row">
                <div className="staff-row-main">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="staff-row-title">{order.product_name}</span>
                    {order.quantity > 1 ? <Badge>Qty {order.quantity}</Badge> : null}
                    <Badge tone={pickup ? "accent" : "neutral"}>{pickup ? "Pickup" : "Shipping"}</Badge>
                    {missingTracking(order) ? <Badge tone="danger">No tracking</Badge> : null}
                  </div>
                  <div className="staff-row-detail">
                    {order.order_number || "New request"} · {customer} · {ageLabel(order)}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <StatusChip value={order.fulfillment_status || "unfulfilled"} />
                    {balance > 0 ? <Badge tone="warning">{money(balance)} due</Badge> : null}
                    {order.tracking_number ? (
                      <span className="staff-row-meta">
                        {order.shipping_carrier || "Carrier"} {order.tracking_number}
                      </span>
                    ) : null}
                  </div>
                </div>
                {/*
                  The action names itself and the link says where it goes.

                  The whole row used to be one link to `#fulfillment`, so "Open
                  Order" and "do the next thing" were the same click and the row
                  could not offer both. They are different intentions — reading
                  the order and performing its next delivery step — and a queue
                  that only offers one of them sends staff to the wrong tab half
                  the time.
                */}
                <div className="staff-row-aside flex-col !items-start gap-1.5 sm:!items-end">
                  <Link
                    href={`/staff/orders/${order.id}#fulfillment`}
                    className="text-xs font-semibold text-brand-accent"
                  >
                    {fulfillmentNextAction(order)} →
                  </Link>
                  <Link href={`/staff/orders/${order.id}`} className="staff-row-meta hover:text-brand-accent">
                    Open order
                  </Link>
                  <span className="staff-row-meta">
                    {order.target_date
                      ? `Target ${new Date(`${order.target_date}T00:00:00`).toLocaleDateString()}`
                      : "No target date"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {loading ? <LoadingState>Loading the fulfillment queue…</LoadingState> : null}
      {/* "Nothing is waiting to go out" is a claim about the shop. It must not
          be made when the query that would have shown the work was refused. */}
      {!loading && !error && shown.length === 0 ? (
        <EmptyState>
          {query || method !== "all" || bucket !== "all"
            ? "Nothing matches this view."
            : "Nothing is waiting to go out. Every order is either delivered, collected or not yet payable."}
        </EmptyState>
      ) : null}
    </StaffPage>
  );
}

export default function StaffFulfillmentQueuePage() {
  // `useSearchParams` needs a Suspense boundary; without one the whole route
  // opts into client-side rendering and the production build refuses to
  // prerender it.
  return (
    <Suspense fallback={<LoadingState>Loading the fulfillment queue…</LoadingState>}>
      <FulfillmentQueueContent />
    </Suspense>
  );
}
