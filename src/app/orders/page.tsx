"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMagnifyingGlass, faXmark } from "@fortawesome/free-solid-svg-icons";

import { OrderHistoryCard } from "@/components/commerce/OrderHistoryCard";
import { EmptyState, Notice } from "@/components/ui/DesignSystem";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { MenuSelect } from "@/components/ui/MenuSelect";
import {
  filterOrderHistoryTab,
  orderHistoryTabOf,
  ORDER_HISTORY_SORT_OPTIONS,
  ORDER_HISTORY_TAB_LABELS,
  ORDER_HISTORY_TABS,
  searchOrderHistory,
  sortOrderHistory,
  type OrderHistoryOrder,
  type OrderHistorySort,
  type OrderHistoryTab,
} from "@/lib/commerce/orderHistory";
import { groupMediaByProduct, type ProductImageSource } from "@/lib/productImages";
import { supabaseBrowser } from "@/lib/supabaseClient";

/**
 * A customer's order history.
 *
 * ## What this reads, and what it is not allowed to read
 *
 * One query for the orders and their line items, filtered by `customer_id` and
 * backed by RLS — the filter is a convenience and the policy is the control, so
 * a mistake here narrows the result rather than widening it. Knowing an order's
 * UUID is not access, and a matching email address is not ownership: guest
 * orders belong to the browser that checked out and are reached through their
 * own signed route, never from here.
 *
 * Every column selected is one a customer may see. Staff notes, production
 * jobs, costs, internal statuses and Stripe identifiers are not in the select
 * list at all, which is a better guarantee than remembering not to render them.
 *
 * ## Two queries, never N+1
 *
 * The line items arrive nested with the orders. The product photographs are one
 * further `in (…)` over the distinct product ids — not one query per card, and
 * not one per line. Those images are the *current* listing, and the card treats
 * them as illustrative for exactly that reason; names, options and prices come
 * from the immutable snapshot written at purchase time.
 *
 * ## Bounded
 *
 * `PAGE_SIZE + 1` rows are requested so "there are more" can be told from
 * "that is all", without a count query. Today's volumes fit in one page; the
 * shape is here so paging is a button rather than a rewrite.
 */

const PAGE_SIZE = 25;

const ORDER_COLUMNS =
  "id,order_number,product_name,quantity,status,payment_status,fulfillment_method,fulfillment_status," +
  "cancellation_status,return_status,agreed_price_cents,amount_paid_cents,amount_refunded_cents," +
  "tracking_url,tracking_number,shipping_carrier,shipping_address,pickup_location_snapshot," +
  "created_at,ready_at,shipped_at,delivered_at,picked_up_at," +
  "order_items(id,product_id,product_name,product_slug,quantity,unit_price_cents,line_subtotal_cents,selected_options)";

type ViewState = "loading" | "ready" | "error" | "signed-out";

export default function OrdersPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [state, setState] = useState<ViewState>("loading");
  const [orders, setOrders] = useState<OrderHistoryOrder[]>([]);
  const [images, setImages] = useState<Map<string, ProductImageSource>>(new Map());
  const [truncated, setTruncated] = useState(false);

  const [tab, setTab] = useState<OrderHistoryTab>("all");
  const [sort, setSort] = useState<OrderHistorySort>("newest");
  const [query, setQuery] = useState("");

  const searchId = useId();

  const load = useCallback(async () => {
    setState("loading");
    const auth = await supabase.auth.getUser();
    if (!auth.data.user) {
      setState("signed-out");
      return;
    }

    const result = await supabase
      .from("orders")
      .select(ORDER_COLUMNS)
      .eq("customer_id", auth.data.user.id)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE + 1);

    // A failed read is an error, never an empty history. "You have no orders"
    // is a sentence a customer will believe, and believing it after an outage
    // is how somebody concludes their purchase never went through.
    if (result.error) {
      setState("error");
      return;
    }

    const rows = (result.data ?? []) as unknown as OrderHistoryOrder[];
    setTruncated(rows.length > PAGE_SIZE);
    const page = rows.slice(0, PAGE_SIZE);
    setOrders(page);
    setState("ready");

    // Thumbnails, in one further query over the distinct products on this page.
    // A failure here leaves the brand mark in every image box, which is the
    // right outcome: a missing photograph must not cost the customer their
    // order history.
    const productIds = Array.from(
      new Set(
        page.flatMap((order) => (order.order_items ?? []).map((item) => item.product_id).filter(Boolean))
      )
    ) as string[];
    if (!productIds.length) return;

    const [productResult, mediaResult] = await Promise.all([
      supabase.from("products").select("id,image_url").in("id", productIds),
      supabase.from("product_media").select("product_id,url,kind,sort_order").in("product_id", productIds).eq("kind", "image").order("sort_order"),
    ]);
    if (productResult.error) return;

    const byProduct = groupMediaByProduct(mediaResult.data ?? []);
    const next = new Map<string, ProductImageSource>();
    for (const row of (productResult.data ?? []) as { id: string; image_url: string | null }[]) {
      next.set(row.id, { image_url: row.image_url, product_media: byProduct.get(row.id) ?? [] });
    }
    setImages(next);
  }, [supabase]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const counts = useMemo(() => {
    const tally = { active: 0, completed: 0, cancelled: 0, all: orders.length };
    for (const order of orders) tally[orderHistoryTabOf(order)] += 1;
    return tally;
  }, [orders]);

  const shown = useMemo(
    () => sortOrderHistory(searchOrderHistory(filterOrderHistoryTab(orders, tab), query), sort),
    [orders, tab, query, sort]
  );

  const term = query.trim();

  if (state === "loading") {
    return (
      <main className="page-container page-stack">
        <p role="status" className="text-brand-textMuted">
          Loading your orders…
        </p>
      </main>
    );
  }

  if (state === "signed-out") {
    return (
      <main className="page-container page-stack">
        <div className="ui-card max-w-xl">
          <h1 className="text-2xl font-semibold">Sign in to see your orders</h1>
          <p className="mt-3 text-sm leading-6 text-brand-textMuted">
            Your order history lives on your account. If you checked out as a guest, open the order with the
            secure link in your confirmation email — guest orders are not attached to an account by email.
          </p>
          <div className="ui-action-row mt-5">
            <Link href="/auth" className="ui-btn ui-btn-primary">
              Sign in
            </Link>
            <Link href="/catalog" className="ui-btn ui-btn-secondary">
              Browse catalog
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (state === "error") {
    return (
      <main className="page-container page-stack">
        <Notice tone="danger" role="alert">
          <h1 className="text-lg font-semibold">Unable to load your orders</h1>
          <p className="mt-2 text-sm">
            This is a problem at our end. Your orders are safe and none of them has been counted as missing.
          </p>
          <button type="button" className="ui-btn ui-btn-secondary mt-4" onClick={() => void load()}>
            Try again
          </button>
        </Notice>
      </main>
    );
  }

  return (
    <main className="page-container page-stack">
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="ui-eyebrow">Your account</p>
          <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">Your orders</h1>
          <p className="mt-2 max-w-2xl text-sm text-brand-textMuted">
            Everything you have ordered from KeyMoura, with where each one has got to.
          </p>
        </div>
        <Link href="/catalog" className="ui-btn ui-btn-secondary w-full text-center text-sm sm:w-auto">
          Browse catalog
        </Link>
      </header>

      {orders.length ? (
        <section aria-label="Find an order" className="order-history-toolbar">
          {/*
            Order number or product name, matched over the page already loaded.
            No round trip, no index, no ranking — a customer has tens of orders
            and remembers either the number on the email or roughly what it was.
          */}
          <form
            role="search"
            aria-label="Search your orders"
            className="commerce-search"
            onSubmit={(event) => event.preventDefault()}
          >
            <div className="commerce-search-field">
              <label className="sr-only" htmlFor={searchId}>
                Search orders
              </label>
              <FontAwesomeIcon icon={faMagnifyingGlass} className="commerce-search-icon" aria-hidden="true" />
              <input
                id={searchId}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search orders by number or product"
                autoComplete="off"
                className="commerce-search-input"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="commerce-search-clear"
                  aria-label="Clear order search"
                >
                  <FontAwesomeIcon icon={faXmark} className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <button type="submit" className="ui-btn ui-btn-primary commerce-search-submit">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="commerce-search-submit-icon" aria-hidden="true" />
              <span className="commerce-search-submit-label">Search</span>
            </button>
          </form>

          <div className="order-history-filters">
            <SegmentedControl
              className="w-full sm:w-auto"
              value={tab}
              onChange={setTab}
              ariaLabel="Filter orders"
              options={ORDER_HISTORY_TABS.map((value) => ({
                value,
                label: `${ORDER_HISTORY_TAB_LABELS[value]} (${counts[value]})`,
              }))}
            />
            <MenuSelect
              ariaLabel="Sort your orders"
              className="ui-select-trigger"
              value={sort}
              onChange={(value) => setSort(value as OrderHistorySort)}
              options={ORDER_HISTORY_SORT_OPTIONS}
            />
          </div>

          <p className="order-history-count" aria-live="polite">
            <strong>{shown.length}</strong>{" "}
            {term ? (
              <>
                {shown.length === 1 ? "order matches" : "orders match"}{" "}
                <span className="catalog-results-term">“{term}”</span>
              </>
            ) : shown.length === 1 ? (
              "order"
            ) : (
              "orders"
            )}
          </p>
        </section>
      ) : null}

      {shown.length ? (
        <div className="order-history-list">
          {shown.map((order, index) => (
            <OrderHistoryCard key={order.id} order={order} images={images} priority={index === 0} />
          ))}
        </div>
      ) : orders.length ? (
        <EmptyState>
          <h2 className="text-lg font-semibold text-brand-text">
            {term ? `No orders match “${term}”.` : "Nothing in this view."}
          </h2>
          <p className="mt-2">
            {term
              ? "Try the order number from your confirmation email, or part of the product name."
              : "Choose a different filter to see your other orders."}
          </p>
          <div className="ui-action-row mt-5 justify-center">
            {term ? (
              <button type="button" onClick={() => setQuery("")} className="ui-btn ui-btn-secondary">
                Clear search
              </button>
            ) : null}
            {tab !== "all" ? (
              <button type="button" onClick={() => setTab("all")} className="ui-btn ui-btn-secondary">
                Show all orders
              </button>
            ) : null}
          </div>
        </EmptyState>
      ) : (
        <EmptyState>
          <h2 className="text-lg font-semibold text-brand-text">No orders yet</h2>
          <p className="mt-2">Browse the catalog to find your first KeyMoura product.</p>
          <div className="ui-action-row mt-5 justify-center">
            <Link href="/catalog" className="ui-btn ui-btn-primary">
              Browse catalog
            </Link>
            <Link href="/orders/new" className="ui-btn ui-btn-secondary">
              Start a custom project
            </Link>
          </div>
        </EmptyState>
      )}

      {truncated ? (
        <p className="text-sm text-brand-textMuted">
          Showing your {PAGE_SIZE} most recent orders. Ask support if you need something older.
        </p>
      ) : null}

      <aside className="rounded-2xl border border-zinc-800 p-5 text-sm text-brand-textMuted">
        <strong className="text-brand-text">Placed an order as a guest?</strong> Open it with the secure link and
        verification details from your confirmation email. Matching an account email never attaches a guest order.
      </aside>
    </main>
  );
}
