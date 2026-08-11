import "server-only";

import { cookies } from "next/headers";
import { routeServiceClient } from "@/lib/api/routeAuth";
import { checkoutAmountCents } from "@/lib/paymentMath";
import {
  evaluateGuestAccess,
  GUEST_ORDER_COOKIE,
  normalizeGuestOrderToken,
  type GuestAccessResult,
} from "@/lib/commerce/guestOrders";

/**
 * Resolving a guest's own order, and nothing else.
 *
 * ## What a guest is allowed to see
 *
 * The column list below is the whole contract, and it is a deliberate subset
 * of what the account order page reads. Absent by construction, not by
 * filtering afterwards:
 *
 * - `customer_id`, `guest_token_hash` — identity and the credential itself.
 * - `fulfillment_notes`, `staff_notes`, internal cost or margin fields — staff
 *   text. `customer_shipment_note` is the one note written *for* a customer
 *   and is the only one here, which is the same rule
 *   `OrderFulfillmentStatus` follows for signed-in customers.
 * - Stripe identifiers. A session or payment-intent id on a page is an
 *   identifier somebody can paste into a support chat.
 *
 * ## Why there is no lookup by order number and email
 *
 * Because it is a guessing oracle. Order numbers are sequential (`KM-0009`),
 * so "order number plus email" is really "email", and a form that answers
 * differently for a real customer's address than for a stranger's tells an
 * attacker who has bought from this shop. The credential is the cookie, and
 * a guest who has lost it is told to contact support — which is a person
 * checking, not a form guessing.
 */

/** Named columns only. `select("*")` here would leak the next column somebody adds. */
const GUEST_ORDER_COLUMNS =
  "id,order_number,product_name,status,quantity,order_kind,created_at,agreed_price_cents,deposit_amount_cents,quote_expires_at,subtotal_cents,discount_cents,shipping_cents,tax_cents,amount_paid_cents,amount_refunded_cents,payment_status,fulfillment_status,fulfillment_method,shipping_address,pickup_location_snapshot,shipping_method_snapshot,customer_shipment_note,shipping_carrier,tracking_number,tracking_url,ready_at,shipped_at,delivered_at,picked_up_at,guest_email,guest_name,guest_token_hash,guest_access_expires_at";

export type GuestOrderView = {
  id: string;
  order_number: string | null;
  product_name: string;
  status: string;
  quantity: number;
  order_kind: string | null;
  created_at: string;
  agreed_price_cents: number | null;
  deposit_amount_cents: number | null;
  quote_expires_at: string | null;
  subtotal_cents: number | null;
  discount_cents: number | null;
  shipping_cents: number | null;
  tax_cents: number | null;
  amount_paid_cents: number;
  amount_refunded_cents: number | null;
  payment_status: string;
  fulfillment_status: string | null;
  fulfillment_method: string | null;
  shipping_address: Record<string, string> | null;
  pickup_location_snapshot: Record<string, unknown> | null;
  shipping_method_snapshot: Record<string, unknown> | null;
  customer_shipment_note: string | null;
  shipping_carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  ready_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  picked_up_at: string | null;
  guest_email: string | null;
  guest_name: string | null;
};

export type GuestOrderItem = {
  product_name: string;
  product_slug: string | null;
  quantity: number;
  unit_price_cents: number;
  line_subtotal_cents: number;
  selected_options: Record<string, unknown> | null;
};

export type GuestOrderMessage = {
  id: number;
  body: string;
  created_at: string;
  /** True when it came from the shop rather than from this guest. */
  fromStaff: boolean;
};

export type GuestOrderResolution =
  | {
      ok: true;
      order: GuestOrderView;
      items: GuestOrderItem[];
      messages: GuestOrderMessage[];
      /** Whether there is a balance to pay right now, and how much. */
      payment: { payable: boolean; amountDueCents: number };
    }
  | { ok: false; reason: GuestAccessResult | "unavailable" };

/**
 * Whether this order can be paid, decided beside the data rather than in a
 * component.
 *
 * The same three conditions `/api/orders/guest/[id]/checkout` enforces, from
 * the same `paymentMath` helper, so the button appears exactly when the route
 * would accept the request. The route re-checks all of it — this only decides
 * whether to offer the control.
 */
function guestPayment(order: GuestOrderView, now: Date): { payable: boolean; amountDueCents: number } {
  const amountDueCents = checkoutAmountCents(order);
  const quoteLive = !order.quote_expires_at || Date.parse(order.quote_expires_at) > now.getTime();
  return {
    amountDueCents,
    payable:
      ["accepted", "awaiting_payment", "in_progress"].includes(order.status) &&
      (order.agreed_price_cents ?? 0) >= 50 &&
      quoteLive &&
      amountDueCents >= 50,
  };
}

/** The raw token from the httpOnly cookie, or null. Never logged, never in a URL. */
export async function readGuestOrderToken(): Promise<string | null> {
  const store = await cookies();
  return normalizeGuestOrderToken(store.get(GUEST_ORDER_COOKIE)?.value);
}

/** The same token, from a route handler's request. */
export function guestOrderTokenFromRequest(req: { cookies: { get(name: string): { value: string } | undefined } }): string | null {
  return normalizeGuestOrderToken(req.cookies.get(GUEST_ORDER_COOKIE)?.value);
}

export type GuestOrderIdentity = {
  guestEmail: string | null;
  guestName: string | null;
};

/**
 * Whether this request's cookie opens this order, for a **write** path.
 *
 * The check is the same as the read path's and deliberately shares
 * `evaluateGuestAccess`, so a guest who may read an order and a guest who may
 * reply to it are the same guest by construction.
 *
 * `customer_id is null` is required as well as the token matching. Without it,
 * a token minted for a guest order that was later claimed by an account would
 * still open it — and an order that belongs to somebody's account must be
 * reachable only through that account.
 */
export async function authorizeGuestOrderWrite(
  token: string | null,
  orderId: string
): Promise<{ ok: true; identity: GuestOrderIdentity } | { ok: false; reason: GuestAccessResult | "unavailable" }> {
  if (!token) return { ok: false, reason: "no_token" };

  const { data, error } = await routeServiceClient
    .from("orders")
    .select("customer_id,guest_email,guest_name,guest_token_hash,guest_access_expires_at")
    .eq("id", orderId)
    .maybeSingle();

  if (error) return { ok: false, reason: "unavailable" };

  const row = data as {
    customer_id: string | null;
    guest_email: string | null;
    guest_name: string | null;
    guest_token_hash: string | null;
    guest_access_expires_at: string | null;
  } | null;

  if (!row || row.customer_id) return { ok: false, reason: "mismatch" };

  const verdict = evaluateGuestAccess(token, row);
  if (verdict !== "granted") return { ok: false, reason: verdict };

  return { ok: true, identity: { guestEmail: row.guest_email, guestName: row.guest_name } };
}

/**
 * The order this browser's token opens, or why it does not.
 *
 * The row is fetched by **id**, then the token is checked against it. Fetching
 * by token hash instead would work, but it would mean a request for order A
 * carrying a token for order B silently rendered order B — a confusing bug in
 * the best case and a wrong-order disclosure in the worst.
 *
 * A failure is never distinguishable from the outside: every denial renders
 * the same page. The reason is returned so the *page* can choose its wording
 * for a token that matched and has merely expired, which is the one case where
 * saying more tells the holder nothing they did not already have.
 */
export async function resolveGuestOrder(orderId: string): Promise<GuestOrderResolution> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
    return { ok: false, reason: "mismatch" };
  }

  const token = await readGuestOrderToken();
  if (!token) return { ok: false, reason: "no_token" };

  const { data, error } = await routeServiceClient
    .from("orders")
    .select(GUEST_ORDER_COLUMNS)
    .eq("id", orderId)
    .maybeSingle();

  // A refused query is not an empty order and is not a denial either. Saying
  // "we could not load this" is the honest answer; rendering the not-found
  // page would tell a customer their order does not exist.
  if (error) return { ok: false, reason: "unavailable" };

  const row = data as unknown as (GuestOrderView & {
    guest_token_hash: string | null;
    guest_access_expires_at: string | null;
  }) | null;

  const verdict = evaluateGuestAccess(token, row);
  if (verdict !== "granted" || !row) return { ok: false, reason: verdict };

  const [{ data: itemRows, error: itemsError }, { data: messageRows, error: messagesError }] = await Promise.all([
    routeServiceClient
      .from("order_items")
      .select("product_name,product_slug,quantity,unit_price_cents,line_subtotal_cents,selected_options")
      .eq("order_id", orderId)
      .order("created_at"),
    // `is_internal = false` is the filter that matters: an internal note is
    // staff writing to staff and must never reach this page. It is applied in
    // the query rather than after it, so a row that should not be here is
    // never loaded in the first place.
    routeServiceClient
      .from("order_messages")
      .select("id,body,created_at,sender_id")
      .eq("order_id", orderId)
      .eq("is_internal", false)
      .order("created_at")
      .limit(200),
  ]);

  if (itemsError || messagesError) return { ok: false, reason: "unavailable" };

  // The credential and the expiry never leave this function. Everything the
  // page receives is already safe to render.
  const { guest_token_hash: _hash, guest_access_expires_at: _expires, ...order } = row;
  void _hash;
  void _expires;

  return {
    ok: true,
    order,
    payment: guestPayment(order, new Date()),
    items: (itemRows ?? []) as GuestOrderItem[],
    // A guest's own messages carry no sender; anything with one came from the
    // shop. The sender id itself is dropped rather than passed on — it names a
    // staff account, which is not this customer's business.
    messages: ((messageRows ?? []) as { id: number; body: string; created_at: string; sender_id: string | null }[]).map(
      (row) => ({ id: row.id, body: row.body, created_at: row.created_at, fromStaff: Boolean(row.sender_id) })
    ),
  };
}
