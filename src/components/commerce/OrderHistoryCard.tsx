"use client";

import Link from "next/link";
import ProductImage from "@/components/ProductImage";
import { moneyFromCents } from "@/lib/orderHub";
import type { ProductImageSource } from "@/lib/productImages";
import {
  orderHistoryActions,
  orderHistoryBalanceCents,
  orderHistoryDate,
  orderHistoryFulfillment,
  orderHistoryItems,
  orderHistoryOptionSummary,
  orderHistoryRefundedCents,
  orderHistoryShortDate,
  orderHistoryStatus,
  orderHistoryStatusDate,
  type OrderHistoryOrder,
} from "@/lib/commerce/orderHistory";

/**
 * One order, as a line in a customer's history.
 *
 * ## What the shape is for
 *
 * A header strip of facts — placed, total, where it is going, which order —
 * then the state it is in, then what is in it, then what to do about it. That
 * ordering is not decoration: a customer scanning a history is answering "which
 * one is this" and "what is happening to it" in that order, and every question
 * after those two is answered on the order's own page.
 *
 * The card carries **no** stretched link. Unlike a product card, whose only
 * possible act is "open it", an order has several genuinely different ones —
 * pay, track, collect, ask for help — and a card-wide anchor swallowing the
 * clicks around them is exactly the trap `ProductCard` documents at length.
 * Every destination here is a real, individually reachable control.
 *
 * ## What it may say
 *
 * Only what the order's own columns say. The status comes from the shared
 * customer projection, the dates come from columns named after the event they
 * describe, and the item names and prices are the purchase-time snapshot. The
 * *picture* is the exception and the only one: there is no historical image, so
 * the current product's photograph stands in. It is marked decorative rather
 * than labelled with the product name, because an `alt` naming the item would
 * assert that this is a picture of the thing that was actually shipped, and
 * nothing here knows that.
 *
 * Absent by construction: production stages, staff names, internal notes,
 * costs, machines, Stripe identifiers, refund reasons, and the order's UUID.
 */

type OrderHistoryCardProps = {
  order: OrderHistoryOrder;
  /** Live product rows keyed by id, for the thumbnails. Missing is fine. */
  images?: Map<string, ProductImageSource>;
  /** Cards above the fold should not lazy-load their first thumbnail. */
  priority?: boolean;
};

/** Two lines of the header strip: a quiet label over the fact it names. */
function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="order-card-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

const MAX_VISIBLE_ITEMS = 3;

export function OrderHistoryCard({ order, images, priority = false }: OrderHistoryCardProps) {
  const status = orderHistoryStatus(order);
  const statusAt = orderHistoryStatusDate(order);
  const fulfillment = orderHistoryFulfillment(order);
  const items = orderHistoryItems(order);
  const actions = orderHistoryActions(order);
  const balance = orderHistoryBalanceCents(order);
  const refunded = orderHistoryRefundedCents(order);

  const visible = items.slice(0, MAX_VISIBLE_ITEMS);
  const overflow = items.length - visible.length;
  const headingId = `order-${order.id}-heading`;

  return (
    // A region per order, named by its order number, so a screen reader can
    // move between orders rather than through every line of every one of them.
    <article className="order-card" aria-labelledby={headingId} data-tone={status.tone}>
      <dl className="order-card-header">
        <Fact label="Order placed" value={orderHistoryDate(order.created_at)} />
        <Fact
          label="Total"
          value={order.agreed_price_cents == null ? "Price after review" : moneyFromCents(order.agreed_price_cents)}
        />
        <Fact label={fulfillment.label} value={fulfillment.value ?? "—"} />
        <div className="order-card-fact order-card-fact-id">
          {/* The order number is the heading, because it is the thing that
              identifies this card among the others. The UUID that addresses the
              route stays in the href where it belongs. */}
          <dt>Order</dt>
          <dd id={headingId}>{order.order_number || "Pending"}</dd>
        </div>
      </dl>

      <div className="order-card-body">
        <div className="order-card-main">
          <p className="order-card-status">
            <span className="order-card-status-dot" aria-hidden="true" />
            {/* The tone is a colour *and* a word. A status legible only by hue
                is not a status for anyone reading in greyscale. */}
            <span className="order-card-status-label">{status.label}</span>
            {statusAt ? <span className="order-card-status-date">{orderHistoryShortDate(statusAt)}</span> : null}
          </p>

          <ul className="order-card-items">
            {visible.map((item, index) => {
              const source = item.product_id ? images?.get(item.product_id) : undefined;
              const options = orderHistoryOptionSummary(item.selected_options);
              return (
                <li key={item.id || `${item.product_name}-${index}`} className="order-card-item">
                  {/*
                    Decorative on purpose: the product's name is the text beside
                    it, and this photograph is the product as it is listed
                    *today*, not a record of what was made and sent.
                  */}
                  <ProductImage
                    product={source ?? {}}
                    alt=""
                    priority={priority && index === 0}
                    sizes="72px"
                    className="order-card-thumb"
                  />
                  <div className="order-card-item-text">
                    <p className="order-card-item-name">
                      {item.product_slug ? (
                        <Link href={`/catalog/${item.product_slug}`}>{item.product_name}</Link>
                      ) : (
                        item.product_name
                      )}
                    </p>
                    {options ? <p className="order-card-item-options">{options}</p> : null}
                    <p className="order-card-item-meta">
                      Qty {item.quantity}
                      {item.line_subtotal_cents != null ? ` · ${moneyFromCents(item.line_subtotal_cents)}` : ""}
                    </p>
                  </div>
                </li>
              );
            })}
            {overflow > 0 ? (
              <li className="order-card-item-more">
                <Link href={`/orders/${order.id}`}>
                  {overflow} more {overflow === 1 ? "item" : "items"} in this order
                </Link>
              </li>
            ) : null}
          </ul>

          {/* Money that is still owed, or money that has come back. Both are
              things a customer wants to see without opening anything; neither
              carries a reason, an internal id, or who decided it. */}
          {balance > 0 ? (
            <p className="order-card-money order-card-money-due">
              <span>Payment required</span>
              <strong>{moneyFromCents(balance)}</strong>
            </p>
          ) : refunded > 0 ? (
            <p className="order-card-money">
              <span>Refunded</span>
              <strong>{moneyFromCents(refunded)}</strong>
            </p>
          ) : null}
        </div>

        <div className="order-card-actions">
          {actions.map((action) =>
            action.external ? (
              <a
                key={action.key}
                href={action.href}
                // A carrier's site is not ours, and a tracking link handed to us
                // is a URL from outside this application: `noopener` is the rule
                // for any target we did not author.
                target="_blank"
                rel="noopener noreferrer"
                className={`ui-btn ${action.role === "primary" ? "ui-btn-primary" : "ui-btn-secondary"}`}
              >
                {action.label}
                <span className="sr-only"> for order {order.order_number || "pending"} (opens in a new tab)</span>
              </a>
            ) : (
              <Link
                key={action.key}
                href={action.href}
                className={`ui-btn ${
                  action.role === "primary"
                    ? "ui-btn-primary"
                    : action.role === "secondary"
                      ? "ui-btn-secondary"
                      : "ui-btn-ghost"
                }`}
              >
                {action.label}
                {/* Twelve cards each with a "View order" link need twelve
                    distinguishable names, or a screen reader's link list is
                    twelve identical rows. */}
                <span className="sr-only"> {order.order_number || "pending"}</span>
              </Link>
            )
          )}
        </div>
      </div>
    </article>
  );
}
