import type { Metadata } from "next";
import Link from "next/link";
import GuestOrderActions from "@/components/commerce/GuestOrderActions";
import { OrderFulfillmentStatus } from "@/components/commerce/OrderFulfillmentStatus";
import { resolveGuestOrder } from "@/lib/commerce/guestOrderAccess";
import { lifecycleLabel, PAYMENT_LABELS, paymentWasTaken } from "@/lib/commerce/orderLifecycle";

/**
 * A guest's own order, read-only.
 *
 * Separate from `/orders/[id]` rather than a branch inside it, for a reason
 * that is structural rather than stylistic: the account page is a client
 * component that reads `orders` **through RLS as the signed-in customer**. A
 * guest is never `authenticated`, so that page can only ever show them
 * nothing. This one runs on the server, authenticates on the httpOnly cookie,
 * and selects a named subset of columns.
 *
 * A guest can read the order, answer a question, and pay an approved quote.
 * There is deliberately **no cancellation and no return control**: each is a
 * financial workflow with its own eligibility rules, its own staff decision
 * and its own refund path, and wiring a guest into them is a larger piece of
 * work than it looks. A button that appears to work and is refused
 * server-side is worse than one that is not offered, so those two say plainly
 * that the team handles them. Recorded in the ledger as the boundary of guest
 * commerce rather than left to be discovered.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your order",
  // A page reachable only with a bearer token must never be indexed, and a
  // crawler that somehow reached it must not pass the link on.
  robots: { index: false, follow: false, nocache: true },
};

const money = (cents: number | null | undefined) =>
  cents == null ? "—" : `$${(cents / 100).toFixed(2)}`;

export default async function GuestOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const result = await resolveGuestOrder(id);

  if (!result.ok) {
    /**
     * Every denial renders the same page, with one exception.
     *
     * "Expired" is only reachable by a token that *matched*, so saying so
     * tells the holder nothing they did not already have. Every other reason —
     * no cookie, wrong cookie, revoked, or an order id that does not exist —
     * gets identical wording, because distinguishing them would turn this page
     * into an oracle for whether an order id is real.
     */
    const expired = result.reason === "expired";
    const unavailable = result.reason === "unavailable";
    return (
      <main className="page-container">
        <h1 className="text-3xl font-semibold tracking-tight">
          {unavailable ? "That order could not be loaded" : expired ? "That link has expired" : "Order not available"}
        </h1>
        <p className="mt-4 max-w-prose leading-7 text-brand-textMuted">
          {unavailable
            ? "Something went wrong reading this order. Nothing has changed — please try again in a moment."
            : expired
              ? "Guest order links stop working after 90 days. Your confirmation email still has the details, and support can help if you need anything else."
              : "We could not confirm this order belongs to you on this device. If you checked out as a guest, open the link from the same browser you used, or reply to your confirmation email."}
        </p>
        <div className="ui-action-row mt-6">
          <Link href="/contact" className="ui-btn ui-btn-primary">
            Contact support
          </Link>
          <Link href="/catalog" className="ui-btn ui-btn-ghost">
            Back to products
          </Link>
        </div>
      </main>
    );
  }

  const { order, items, messages, payment } = result;
  const justPaid = query.payment === "success";
  const isRequest = order.order_kind !== "direct_purchase";

  /**
   * Whether the money has actually landed on the order yet.
   *
   * `?payment=success` only means Stripe accepted the card and redirected; the
   * order is settled by `checkout.session.completed`, which is a *separate*
   * request that can arrive after the customer is already looking at this page.
   * Announcing a receipt on the strength of a query parameter would be telling
   * the customer something this application does not yet know. `paymentWasTaken`
   * is the same predicate the lifecycle rules use, so the page and the rules
   * cannot disagree about whether an order is paid.
   */
  const settled = paymentWasTaken(order);

  return (
    <main className="page-container">
      {justPaid && settled ? (
        <p role="status" className="ui-notice ui-notice-success">
          Payment received. A receipt is on its way to {order.guest_email}.
        </p>
      ) : null}
      {justPaid && !settled ? (
        <p role="status" className="ui-notice">
          Payment processing. Your payment went through and we are confirming it — this usually takes a few
          seconds.{" "}
          {/* The page is `force-dynamic`, so re-requesting it is the whole
              refresh mechanism. A plain link keeps this a server component. */}
          <Link href={`/orders/guest/${order.id}`} className="underline">
            Check again
          </Link>
          .
        </p>
      ) : null}

      <header className="mt-4 max-w-3xl">
        <p className="ui-eyebrow">{order.order_number ?? "Order"}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">{order.product_name}</h1>
        <p className="mt-3 leading-7 text-brand-textMuted">
          Placed {new Date(order.created_at).toLocaleDateString()} as a guest.{" "}
          {/* Said plainly rather than discovered: the credential is this
              browser, so the customer knows what they are relying on. */}
          This page opens from the browser you checked out with, for 90 days.
        </p>
      </header>

      <section aria-labelledby="guest-order-summary" className="ui-card mt-6 p-5">
        <h2 id="guest-order-summary" className="text-lg font-semibold">
          Summary
        </h2>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-brand-textMuted">Status</dt>
            <dd className="mt-1 text-sm">{order.status.replace(/_/g, " ")}</dd>
          </div>
          <div>
            <dt className="text-xs text-brand-textMuted">Payment</dt>
            {/* The customer wording table, which also title-cases anything it
                does not recognise — a legacy payment state renders as a neutral
                phrase rather than as a blank or a crash. */}
            <dd className="mt-1 text-sm">{lifecycleLabel(PAYMENT_LABELS, order.payment_status)}</dd>
          </div>
          <div>
            <dt className="text-xs text-brand-textMuted">Paid</dt>
            <dd className="mt-1 text-sm">{money(order.amount_paid_cents)}</dd>
          </div>
          {Number(order.amount_refunded_cents ?? 0) > 0 ? (
            <div>
              <dt className="text-xs text-brand-textMuted">Refunded</dt>
              <dd className="mt-1 text-sm">{money(order.amount_refunded_cents)}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      {items.length ? (
        <section aria-labelledby="guest-order-items" className="ui-card mt-4 p-5">
          <h2 id="guest-order-items" className="text-lg font-semibold">
            Items
          </h2>
          <ul className="mt-4 grid gap-3">
            {items.map((item, index) => (
              <li key={`${item.product_slug ?? item.product_name}-${index}`} className="flex flex-wrap justify-between gap-3 border-b border-brand-border pb-3 last:border-0 last:pb-0">
                <div className="min-w-0">
                  <p className="font-medium">
                    {item.product_slug ? (
                      <Link href={`/catalog/${item.product_slug}`} className="hover:text-brand-primary">
                        {item.product_name}
                      </Link>
                    ) : (
                      item.product_name
                    )}
                  </p>
                  <p className="mt-1 text-xs text-brand-textMuted">
                    {item.quantity} × {money(item.unit_price_cents)}
                  </p>
                </div>
                <p className="font-semibold">{money(item.line_subtotal_cents)}</p>
              </li>
            ))}
          </ul>

          <dl className="mt-4 grid gap-2 border-t border-brand-border pt-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-brand-textMuted">Subtotal</dt>
              <dd>{money(order.subtotal_cents)}</dd>
            </div>
            {Number(order.discount_cents ?? 0) > 0 ? (
              <div className="flex justify-between">
                <dt className="text-brand-textMuted">Discount</dt>
                <dd>−{money(order.discount_cents)}</dd>
              </div>
            ) : null}
            {order.shipping_cents != null ? (
              <div className="flex justify-between">
                <dt className="text-brand-textMuted">Delivery</dt>
                <dd>{money(order.shipping_cents)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between font-semibold">
              <dt>Total</dt>
              <dd>{money(order.agreed_price_cents)}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      {/* The same component signed-in customers see, reading the same state
          field — so a guest and an account customer cannot be told two
          different things about where their parcel is. */}
      <div className="mt-4">
        <OrderFulfillmentStatus order={order} />
      </div>

      <GuestOrderActions
        orderId={order.id}
        messages={messages}
        payable={payment.payable}
        amountDueLabel={payment.payable ? money(payment.amountDueCents) : null}
      />

      <section className="ui-card mt-4 p-5">
        <h2 className="text-lg font-semibold">Need to change something?</h2>
        <p className="mt-2 text-sm leading-6 text-brand-textMuted">
          {isRequest
            ? "Ask us anything in the messages above and we will pick it up from there."
            : "Cancellations and returns are handled by our team for guest orders — send a message above, or create an account to manage them yourself."}
        </p>
        <div className="ui-action-row mt-4">
          <Link href="/contact" className="ui-btn ui-btn-secondary">
            Contact us
          </Link>
          <Link href="/auth/register" className="ui-btn ui-btn-ghost">
            Create an account for next time
          </Link>
        </div>
      </section>
    </main>
  );
}
