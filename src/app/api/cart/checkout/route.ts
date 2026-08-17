import { NextRequest, NextResponse } from "next/server";
import { snapshotPurchasedOptions, snapshotSelections } from "@/lib/commerce/orderConfiguration";
import { getUserFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { stripeClient } from "@/lib/stripe";
import { captureCommerceException } from "@/lib/monitoring";
import { resolveCart } from "@/lib/commerce/cartService";
import { readGuestToken } from "@/lib/commerce/cartSession";
import { mergeGuestCart } from "@/lib/commerce/cartService";
import { lineSignature, type PricedLine } from "@/lib/commerce/pricing";
import {
  createGuestOrderToken,
  guestAccessExpiry,
  GUEST_ORDER_COOKIE,
  guestOrderCookieOptions,
  guestTokenMatches,
  hashGuestOrderToken,
  normalizeGuestOrderToken,
  parseGuestContact,
  type GuestContact,
} from "@/lib/commerce/guestOrders";
import {
  linkCartReservationsToOrder,
  loadCommerceSettings,
  releaseReservations,
  reserveCartInventory,
} from "@/lib/commerce/commerceSettingsServer";
import {
  loadProductFulfillment,
  planFulfillment,
  toQuotableLines,
} from "@/lib/commerce/checkoutFulfillment";

/**
 * Direct-purchase checkout, for an account or a guest.
 *
 * The order is written *before* the Stripe session exists, with a canonical
 * `agreed_price_cents` computed here from live product rows. The session then
 * points at that order using the same metadata shape the quote flow uses, so
 * the existing webhook settles it through the same idempotency table and the
 * same accounting RPC. Direct purchases inherit every payment guarantee the
 * request flow already has instead of growing a second, weaker payment path.
 *
 * **Guest checkout, and what it is not.** Until `20260806050000`,
 * `orders.customer_id` was NOT NULL, so a guest order was unrepresentable
 * rather than unimplemented. It is now nullable, and a guest order carries the
 * address its receipt goes to plus a salted digest of the cookie token that
 * lets that browser read it back.
 *
 * A guest is **not** a second pricing path. Everything below this point —
 * revalidation, fulfillment planning, the reservation, the order write, the
 * Stripe session, the idempotency key — is the same code for both. The only
 * differences are which identity columns are set, which address the receipt is
 * sent to, and where the customer lands afterwards.
 */

export const runtime = "nodejs";

/** Stripe rejects amounts under 50 cents. */
const STRIPE_MINIMUM_CENTS = 50;

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  const guestToken = readGuestToken(req);

  // Read once: the fulfillment plan needs it too, and a second `req.json()`
  // on a consumed body returns nothing.
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const settings = await loadCommerceSettings();

  let guest: GuestContact | null = null;
  if (!user) {
    if (!settings.guest.allowCheckout) {
      return NextResponse.json(
        { error: "Sign in to finish checking out.", requiresSignIn: true },
        { status: 401 }
      );
    }
    // The address is required, because it is the only way a guest ever hears
    // about the order again. It is validated here rather than trusted: it
    // reaches a mail send, so a value carrying CR or LF is a header injection
    // into a message somebody else receives.
    const parsed = parseGuestContact({ email: body.guestEmail, name: body.guestName });
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.message, field: parsed.field }, { status: 400 });
    }
    guest = parsed.contact;
    if (!guestToken) {
      // Without a cart cookie there is no cart to check out, and nothing to
      // attach the order to afterwards.
      return NextResponse.json({ error: "Your cart is empty." }, { status: 409 });
    }
  }

  // Fold in anything put in the cart as a guest before this cart is priced, so
  // the customer pays for what they actually filled the cart with.
  if (user && guestToken) await mergeGuestCart(guestToken, user.id);

  // Revalidation immediately before the session is created: this is the price
  // the customer is charged, recomputed from live products, not the number the
  // browser last displayed.
  const cart = await resolveCart(user ? { customerId: user.id } : { guestToken: guestToken as string });

  if (!cart.priced.lines.length) {
    return NextResponse.json({ error: "Your cart is empty." }, { status: 409 });
  }
  if (cart.priced.rejected.length) {
    return NextResponse.json(
      {
        error: "Some items are no longer available. Review your cart and try again.",
        unavailable: cart.priced.rejected.map((entry) => entry.blocker.message),
      },
      { status: 409 }
    );
  }

  if (!cart.totals.chargeable) {
    return NextResponse.json({ error: "This cart cannot be checked out." }, { status: 409 });
  }

  const lines = cart.priced.lines;

  // ---------------------------------------------------------------------
  // Fulfillment, priced server-side
  // ---------------------------------------------------------------------
  // The browser sends a *method id* and an address. It never sends a shipping
  // price, and no field carrying one is read: the charge is recomputed here
  // from the configured methods and this server's own subtotal.
  const productFulfillment = await loadProductFulfillment(lines.map((line) => line.productId));
  const quotableLines = toQuotableLines(lines, productFulfillment);

  const planned = planFulfillment({
    settings,
    lines: quotableLines,
    products: productFulfillment,
    requestedMethod: body.fulfillmentMethod,
    requestedShippingMethodId: body.shippingMethodId,
    requestedAddress: body.shippingAddress,
    subtotalCents: cart.totals.subtotalCents,
    discountCents: cart.totals.discountCents,
    orderKind: "direct_purchase",
  });

  if (!planned.ok) {
    return NextResponse.json({ error: planned.error, field: planned.field }, { status: 400 });
  }

  const { plan } = planned;
  const totalCents = plan.totals.totalCents;
  if (totalCents < STRIPE_MINIMUM_CENTS) {
    return NextResponse.json({ error: "This cart cannot be checked out." }, { status: 409 });
  }

  // ---------------------------------------------------------------------
  // Hold the stock before taking the customer to Stripe
  // ---------------------------------------------------------------------
  // This is the window pass 7 recorded as open: without a hold, two customers
  // can both check out the last unit and both payments succeed. The hold is
  // atomic and all-or-nothing, and it lapses on its own.
  if (!cart.cartId) {
    return NextResponse.json({ error: "Could not start checkout. Please try again." }, { status: 500 });
  }

  /*
   * Before anything is written: is this cart already checking out?
   *
   * Checked here rather than after the reservation so a repeat click touches no
   * state at all — the hold the first attempt took is still active, still linked
   * to that order and that session, and re-reserving would only supersede it
   * with an identical one.
   */
  const inFlight = await inFlightCheckout({
    req,
    cartId: cart.cartId,
    userId: user?.id ?? null,
    totalCents,
    lines,
  });
  if (inFlight) return NextResponse.json({ url: inFlight.url, orderId: inFlight.orderId });

  const reservation = await reserveCartInventory({
    cartId: cart.cartId,
    // A guest hold is keyed on the cart, which is what the release and commit
    // paths already look it up by. There is no user to attribute it to and
    // inventing one would put a fake id in the ledger.
    userId: user?.id ?? null,
    lines: lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
    minutes: settings.inventory.reservationMinutes,
    allowOversell: settings.inventory.allowOverselling,
  });

  if (!reservation.ok) {
    return NextResponse.json(
      {
        error:
          reservation.shortages.length === 1
            ? `${reservation.shortages[0].product_name} only has ${reservation.shortages[0].available} left.`
            : "Some items in your cart are no longer available in the quantity you asked for.",
        shortages: reservation.shortages.map((entry) => ({
          productName: entry.product_name,
          requested: entry.requested,
          available: entry.available,
        })),
      },
      { status: 409 }
    );
  }

  const summaryName =
    lines.length === 1
      ? lines[0].product.name
      : `${lines[0].product.name} and ${lines.length - 1} more item${lines.length - 1 === 1 ? "" : "s"}`;

  // Minted before the insert so its digest can be written with the row: an
  // order that exists without a way for its guest to reach it is an order that
  // has to be recovered by hand.
  const guestOrderToken = guest ? createGuestOrderToken() : null;

  const { data: order, error: orderError } = await routeServiceClient
    .from("orders")
    .insert({
      customer_id: user?.id ?? null,
      guest_email: guest?.email ?? null,
      guest_name: guest?.name ?? null,
      // The raw token is never stored. A database read — a dump, a log, a
      // support screen — must not yield something that can be replayed.
      guest_token_hash: guestOrderToken ? hashGuestOrderToken(guestOrderToken) : null,
      // Bounded from the moment it is minted. A cookie left on a shared
      // computer stops working on its own rather than waiting for somebody to
      // notice.
      guest_access_expires_at: guestOrderToken ? guestAccessExpiry() : null,
      order_kind: "direct_purchase",
      status: "awaiting_payment",
      payment_status: "unpaid",
      product_id: lines.length === 1 ? lines[0].productId : null,
      product_name: summaryName,
      quantity: cart.priced.itemCount,
      subtotal_cents: plan.totals.subtotalCents,
      discount_cents: plan.totals.discountCents,
      shipping_cents: plan.totals.shippingCents,
      tax_cents: plan.totals.taxCents,
      discount_code: cart.discount?.ok ? cart.discount.code.code : null,
      discount_code_id: cart.discount?.ok ? cart.discount.code.id : null,
      agreed_price_cents: totalCents,
      // Snapshots. A settings change six months from now must not rewrite what
      // this customer was charged or redirect a parcel already in the post.
      fulfillment_method: plan.method,
      fulfillment_status: plan.method === "none" ? "not_required" : "unfulfilled",
      shipping_address: plan.shippingAddress,
      shipping_method_snapshot: plan.shippingMethodSnapshot,
      shipping_origin_snapshot: plan.shippingOriginSnapshot,
      pickup_location_snapshot: plan.pickupLocationSnapshot,
      package_snapshot: plan.packageSnapshot,
    })
    .select("id")
    .single();

  if (orderError || !order) {
    // Give the stock straight back. An unreleased hold on a checkout that never
    // happened is an outage that presents as an out-of-stock product.
    await releaseReservations({ reason: "checkout_order_failed", cartId: cart.cartId });
    captureCommerceException(orderError, { operation: "create_direct_order" });
    return NextResponse.json({ error: "Could not start checkout. Please try again." }, { status: 500 });
  }

  // Line snapshots: name and price are copied at purchase time so a later
  // product edit never rewrites what the customer actually bought.
  const { error: itemsError } = await routeServiceClient.from("order_items").insert(
    lines.map((line) => ({
      order_id: order.id,
      product_id: line.productId,
      product_name: line.product.name,
      product_slug: line.product.slug,
      // Immutable display snapshot, deliberately richer than the cart's raw
      // selection map. Historical pages never resolve names or adjustments
      // from mutable product option rows.
      selected_options: snapshotPurchasedOptions(line),
      quantity: line.quantity,
      unit_price_cents: line.unitPriceCents,
      line_subtotal_cents: line.lineSubtotalCents,
    }))
  );

  if (itemsError) {
    // No payment exists yet, so removing the shell order is safe and keeps a
    // half-written order out of the customer's history.
    await releaseReservations({ reason: "checkout_items_failed", cartId: cart.cartId });
    await routeServiceClient.from("orders").delete().eq("id", order.id);
    captureCommerceException(itemsError, { operation: "create_direct_order_items", orderId: order.id });
    return NextResponse.json({ error: "Could not start checkout. Please try again." }, { status: 500 });
  }

  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://keymoura.com").replace(/\/$/, "");

  try {
    const session = await stripeClient().checkout.sessions.create(
      {
        mode: "payment",
        customer_email: user?.email ?? guest?.email,
        client_reference_id: order.id,
        /**
         * The webhook matches on these before settling any money.
         *
         * For an account order that is `customer_id`, unchanged. For a guest
         * there is no customer id, and comparing two nulls proves nothing — so
         * a guest session is marked as one, and the webhook additionally
         * requires it to be the session this order actually recorded. That is
         * a strictly stronger binding than the old comparison, not a relaxed
         * one: the session id is minted by Stripe and written by us.
         */
        metadata: user
          ? { order_id: order.id, customer_id: user.id, payment_kind: "full", order_kind: "direct_purchase" }
          : { order_id: order.id, guest: "1", payment_kind: "full", order_kind: "direct_purchase" },
        payment_intent_data: {
          metadata: user ? { order_id: order.id, customer_id: user.id } : { order_id: order.id, guest: "1" },
        },
        // One line for the canonical total. Stripe is told the amount; it is
        // never asked to compute one, and the client never supplies one.
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: totalCents,
              product_data: {
                name: summaryName,
                description: `${cart.priced.itemCount} item${cart.priced.itemCount === 1 ? "" : "s"}`,
              },
            },
          },
        ],
        // A guest lands on the read-only guest view, which authenticates on the
        // cookie. The account page reads through RLS as the signed-in customer
        // and would show a guest nothing.
        success_url: guest
          ? `${siteUrl}/orders/guest/${order.id}?payment=success`
          : `${siteUrl}/orders/${order.id}?payment=success`,
        cancel_url: `${siteUrl}/cart?payment=cancelled`,
        // The session dies when the hold does. Without this the session would
        // outlive its reservation by up to 24 hours, and a customer could pay
        // for stock that had already been released to somebody else.
        expires_at: Math.floor(Date.now() / 1000) + settings.inventory.reservationMinutes * 60,
      },
      { idempotencyKey: `direct-checkout-${order.id}-${totalCents}` }
    );

    const { error: sessionError } = await routeServiceClient
      .from("orders")
      .update({ stripe_checkout_session_id: session.id })
      .eq("id", order.id);

    if (sessionError) {
      captureCommerceException(sessionError, { operation: "save_direct_checkout_session", orderId: order.id });
      return NextResponse.json({ error: "Could not prepare checkout. Please try again." }, { status: 500 });
    }

    // The hold now belongs to this order and this session, which is what lets
    // `checkout.session.expired` and the payment webhook find it later.
    await linkCartReservationsToOrder(cart.cartId, order.id, session.id);

    // The cart is marked converted only after a session exists. It is not
    // emptied: payment has not happened yet, and a customer who abandons
    // Stripe must come back to a cart that still holds their items.
    await routeServiceClient
      .from("carts")
      .update({ converted_order_id: order.id, updated_at: new Date().toISOString() })
      .eq("id", cart.cartId);

    const response = NextResponse.json({ url: session.url, orderId: order.id });

    /**
     * The guest's credential, set on the response that hands back the Stripe
     * URL — so it exists before the customer leaves for Stripe and is present
     * when they come back.
     *
     * httpOnly so no script can read it, SameSite=Lax so it is not sent on a
     * cross-site POST but *is* sent on the top-level GET that Stripe redirects
     * back with, and Secure in production. It is never put in a URL.
     */
    if (guestOrderToken) {
      response.cookies.set(GUEST_ORDER_COOKIE, guestOrderToken, guestOrderCookieOptions());
    }

    return response;
  } catch (error) {
    await releaseReservations({ reason: "checkout_session_failed", cartId: cart.cartId, orderId: order.id });
    await routeServiceClient.from("orders").delete().eq("id", order.id);
    captureCommerceException(error, { operation: "create_direct_checkout_session", orderId: order.id });
    return NextResponse.json({ error: "Could not start checkout. Please try again." }, { status: 500 });
  }
}

/**
 * One line of a basket, reduced to the facts that decide whether two baskets
 * are the same purchase: the product, the exact configuration, how many, and
 * what each costs. Order-independent, because a cart's row order is not part of
 * what the customer is buying.
 */
function basketFingerprint(
  lines: readonly { productId: string; selectedOptions: Record<string, string>; quantity: number; unitPriceCents: number }[]
): string {
  return lines
    .map((line) => `${lineSignature(line.productId, line.selectedOptions)}|q=${line.quantity}|u=${line.unitPriceCents}`)
    .sort()
    .join("\n");
}

type ReusableOrderRow = {
  id: string;
  customer_id: string | null;
  guest_token_hash: string | null;
  order_kind: string | null;
  status: string;
  payment_status: string;
  agreed_price_cents: number | null;
  stripe_checkout_session_id: string | null;
};

/**
 * The checkout this cart is already in the middle of, when there is one.
 *
 * Every POST used to insert a fresh order, so a double click, a Back out of
 * Stripe, or a retry after a flaky response each left another
 * `awaiting_payment` row in the customer's history and on the staff queue — and
 * two live sessions for one basket is how one basket gets paid for twice.
 *
 * The cart already records the order it was converted for, so no new state is
 * needed to find it. This mirrors the reuse `/api/orders/[id]/checkout` has
 * always done for quotes, and is deliberately strict: same owner, same basket,
 * same total, nothing paid against it, and Stripe still calling the session
 * open. Any mismatch returns null and the normal path writes a new order, which
 * is exactly the old behaviour.
 *
 * Comparing the *basket* and not merely the total matters: swapping one item
 * for another at the same price leaves the total identical while changing what
 * is being bought, and reusing there would charge the customer for the order
 * they no longer have.
 */
async function inFlightCheckout(input: {
  req: NextRequest;
  cartId: string;
  userId: string | null;
  totalCents: number;
  lines: readonly PricedLine[];
}): Promise<{ url: string; orderId: string } | null> {
  const { data: cartRow } = await routeServiceClient
    .from("carts")
    .select("converted_order_id")
    .eq("id", input.cartId)
    .maybeSingle();

  const orderId = (cartRow as { converted_order_id: string | null } | null)?.converted_order_id;
  if (!orderId) return null;

  const { data } = await routeServiceClient
    .from("orders")
    .select("id,customer_id,guest_token_hash,order_kind,status,payment_status,agreed_price_cents,stripe_checkout_session_id")
    .eq("id", orderId)
    .maybeSingle();

  const order = data as ReusableOrderRow | null;
  if (
    !order ||
    order.order_kind !== "direct_purchase" ||
    order.status !== "awaiting_payment" ||
    order.payment_status !== "unpaid" ||
    order.agreed_price_cents !== input.totalCents ||
    !order.stripe_checkout_session_id
  ) {
    return null;
  }

  /**
   * Same owner.
   *
   * An account order must belong to this account. A guest order must be one
   * this browser still holds the credential for — reuse cannot mint a
   * replacement, because the raw token is not recoverable from its digest, so a
   * guest who has lost the cookie is better served by a new order that comes
   * with a new one.
   */
  const ownerMatches = input.userId
    ? order.customer_id === input.userId
    : !order.customer_id &&
      guestTokenMatches(
        normalizeGuestOrderToken(input.req.cookies.get(GUEST_ORDER_COOKIE)?.value),
        order.guest_token_hash
      );
  if (!ownerMatches) return null;

  const { data: itemRows, error: itemsError } = await routeServiceClient
    .from("order_items")
    .select("product_id,quantity,unit_price_cents,selected_options")
    .eq("order_id", order.id);

  // An unreadable item list is not a matching basket. Falling through writes a
  // new order, which is the safe direction to fail in.
  if (itemsError || !itemRows?.length) return null;

  const storedBasket = basketFingerprint(
    (itemRows as { product_id: string | null; quantity: number; unit_price_cents: number; selected_options: unknown }[]).map(
      (row) => ({
        productId: String(row.product_id ?? ""),
        selectedOptions: snapshotSelections(row.selected_options),
        quantity: Number(row.quantity ?? 0),
        unitPriceCents: Number(row.unit_price_cents ?? 0),
      })
    )
  );

  if (storedBasket !== basketFingerprint(input.lines)) return null;

  try {
    const session = await stripeClient().checkout.sessions.retrieve(order.stripe_checkout_session_id);
    if (session.status === "open" && session.amount_total === input.totalCents && session.url) {
      return { url: session.url, orderId: order.id };
    }
  } catch {
    // A session Stripe no longer knows about must not block a fresh checkout.
  }
  return null;
}
