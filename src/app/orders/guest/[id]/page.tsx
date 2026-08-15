import type { Metadata } from "next";
import Link from "next/link";
import GuestOrderActions from "@/components/commerce/GuestOrderActions";
import { GuestOrderVerification } from "@/components/commerce/GuestOrderVerification";
import { CustomerOrderOverview } from "@/components/commerce/CustomerOrderOverview";
import { resolveGuestOrder } from "@/lib/commerce/guestOrderAccess";
import { GUEST_ACCESS_WINDOW_LABEL } from "@/lib/commerce/guestAccessWindow";
import { paymentWasTaken } from "@/lib/commerce/orderLifecycle";

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
     * Every routine denial becomes the same email challenge.
     *
     * No cookie, the wrong cookie, an expired session, a revoked one, or an
     * order id that does not exist: all of them render `GuestOrderVerification`
     * identically. That sameness is the point — a page that distinguished them
     * would answer, for anyone willing to try ids, which ones are real. The
     * guest proves the mailbox instead, and a guest who genuinely owns the
     * order is a minute away rather than told to email support.
     */
    if (result.reason !== "unavailable") return <GuestOrderVerification orderId={id} />;

    /**
     * Reserved for an infrastructure failure — a refused query, not a refused
     * guest. It says nothing about whether the requested order exists, and it
     * deliberately does not offer the code form, which could only fail too.
     */
    return (
      <main className="page-container">
        <h1 className="text-3xl font-semibold tracking-tight">That order could not be loaded</h1>
        <p className="mt-4 max-w-prose leading-7 text-brand-textMuted">
          Something went wrong reading this order. Nothing has changed — please try again in a moment.
        </p>
        <div className="ui-action-row mt-6">
          <Link href="/support" className="ui-btn ui-btn-primary">
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

      <p className="mt-4 text-sm leading-6 text-brand-textMuted">
        Viewing as a guest. This browser stays verified for {GUEST_ACCESS_WINDOW_LABEL}; another device will require the 6-digit code sent by email.
      </p>
      <div className="page-stack mt-4">
        <CustomerOrderOverview order={order} items={items} />
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
          {/*
            The order id travels in the URL, and only that. It is a suggestion:
            the support route re-checks it against this browser's guest session
            cookie before attaching it, so following this link from somebody
            else's copy attaches nothing.
          */}
          <Link href={`/support?order=${order.id}&category=order`} className="ui-btn ui-btn-secondary">
            Contact support about this order
          </Link>
          <Link href="/auth/register" className="ui-btn ui-btn-ghost">
            Create an account for next time
          </Link>
        </div>
      </section>
    </main>
  );
}
