import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { routeServiceClient } from "@/lib/api/routeAuth";
import { sendCommerceEmail } from "@/lib/commerceEmail";
import { raiseOperationalAlert, resolveOperationalAlert } from "@/lib/comms/operationalAlerts";
import { logLifecycleFailure } from "./orderLifecycleServer";
import {
  DEFAULT_COMMERCE_SETTINGS,
  parseCommerceSettings,
  publicCommerceSettings,
  type CommerceSettings,
  type PublicCommerceSettings,
} from "./commerceSettings";

/**
 * Server-side commerce settings, reservations, fulfillment transitions and
 * low-stock alerts. The rules live in `commerceSettings.ts` and
 * `orderLifecycle.ts` and are imported, never restated.
 */

const db = (): SupabaseClient => routeServiceClient;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * A settings read failing must not take checkout offline, so a failure falls
 * back to the safe defaults — which have shipping and pickup **disabled**, so
 * the degraded mode refuses clearly rather than quoting a price it invented.
 */
export async function loadCommerceSettings(): Promise<CommerceSettings> {
  const { data, error } = await db()
    .from("site_settings")
    .select("commerce_settings")
    .eq("singleton", true)
    .maybeSingle();
  if (error) {
    logLifecycleFailure("load_commerce_settings", error);
    return DEFAULT_COMMERCE_SETTINGS;
  }
  return parseCommerceSettings((data as { commerce_settings?: unknown } | null)?.commerce_settings);
}

export async function loadPublicCommerceSettings(
  options: { pickupReady?: boolean } = {}
): Promise<PublicCommerceSettings> {
  return publicCommerceSettings(await loadCommerceSettings(), options);
}

/**
 * Writes the whole parsed object, never a client-supplied fragment. The value
 * stored is the value `parseCommerceSettings` produced, so anything the form
 * did not send falls back to a known default rather than being written as
 * `undefined` and read back as garbage.
 */
export async function saveCommerceSettings(next: CommerceSettings): Promise<{ ok: boolean }> {
  const { error } = await db()
    .from("site_settings")
    .update({ commerce_settings: next, updated_at: new Date().toISOString() })
    .eq("singleton", true);
  if (error) {
    logLifecycleFailure("save_commerce_settings", error);
    return { ok: false };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

export type ReservationShortage = {
  product_id: string;
  product_name: string;
  requested: number;
  available: number;
  reason: string;
};

export type ReservationResult =
  | { ok: true; reservations: { id: string; product_id: string; quantity: number }[]; expiresAt: string | null }
  | { ok: false; shortages: ReservationShortage[]; error: string };

/**
 * Hold stock for a cart, all or nothing.
 *
 * The shortage list is what the customer is shown, so it names products rather
 * than ids. Everything atomic happens inside `reserve_cart_inventory`: doing
 * the availability check here and the insert there would reopen exactly the
 * race this exists to close.
 */
export async function reserveCartInventory(input: {
  cartId: string;
  userId: string | null;
  lines: { productId: string; quantity: number }[];
  minutes: number;
  allowOversell?: boolean;
}): Promise<ReservationResult> {
  const { data, error } = await db().rpc("reserve_cart_inventory", {
    p_cart_id: input.cartId,
    p_user_id: input.userId,
    p_lines: input.lines.map((line) => ({ product_id: line.productId, quantity: line.quantity })),
    p_minutes: input.minutes,
    p_allow_oversell: input.allowOversell ?? false,
  });

  if (error) {
    logLifecycleFailure("reserve_cart_inventory", error, { cartId: input.cartId });
    return { ok: false, shortages: [], error: "reservation_failed" };
  }

  const result = data as
    | { ok?: boolean; error?: string; shortages?: ReservationShortage[]; reservations?: { id: string; product_id: string; quantity: number }[]; expires_at?: string }
    | null;

  if (!result?.ok) {
    return {
      ok: false,
      shortages: Array.isArray(result?.shortages) ? result.shortages : [],
      error: String(result?.error || "reservation_failed"),
    };
  }
  return {
    ok: true,
    reservations: Array.isArray(result.reservations) ? result.reservations : [],
    expiresAt: result.expires_at ?? null,
  };
}

export async function linkCartReservationsToOrder(cartId: string, orderId: string, sessionId: string | null) {
  const { error } = await db().rpc("link_cart_reservations_to_order", {
    p_cart_id: cartId,
    p_order_id: orderId,
    p_checkout_session_id: sessionId,
  });
  if (error) logLifecycleFailure("link_cart_reservations", error, { cartId, orderId });
}

/** Exactly once. Only `active` rows move, so a replayed webhook commits none. */
export async function commitOrderReservations(orderId: string): Promise<number> {
  const { data, error } = await db().rpc("commit_order_reservations", { p_order_id: orderId });
  if (error) {
    logLifecycleFailure("commit_order_reservations", error, { orderId });
    return 0;
  }
  return Number((data as { committed?: number } | null)?.committed ?? 0);
}

export async function releaseReservations(input: {
  reason: string;
  cartId?: string | null;
  orderId?: string | null;
  checkoutSessionId?: string | null;
}): Promise<number> {
  const { data, error } = await db().rpc("release_inventory_reservations", {
    p_reason: input.reason,
    p_cart_id: input.cartId ?? null,
    p_order_id: input.orderId ?? null,
    p_checkout_session_id: input.checkoutSessionId ?? null,
  });
  if (error) {
    logLifecycleFailure("release_inventory_reservations", error, {
      orderId: input.orderId ?? null,
      cartId: input.cartId ?? null,
    });
    return 0;
  }
  return Number((data as { released?: number } | null)?.released ?? 0);
}

/**
 * Opportunistic cleanup.
 *
 * There is no cron service in this project, so expiry cannot depend on one.
 * `reserve_cart_inventory` sweeps before it measures, and availability ignores
 * a lapsed hold regardless — so a hold that outlives its sweep still stops
 * blocking a sale. This exported form exists for the staff reconciliation page
 * and for a scheduled job if one is ever added.
 */
export async function expireReservations(limit = 500): Promise<number> {
  const { data, error } = await db().rpc("expire_inventory_reservations", { p_limit: limit });
  if (error) {
    logLifecycleFailure("expire_inventory_reservations", error);
    return 0;
  }
  return Number(data ?? 0);
}

// ---------------------------------------------------------------------------
// Low-stock alerts
// ---------------------------------------------------------------------------

export type InventoryAlertOutcome = {
  action: "opened" | "escalated" | "resolved" | "unchanged" | "none";
  alert_id?: string;
  level?: "low" | "out";
  product_id?: string;
  product_name?: string;
  quantity?: number;
  threshold?: number;
};

/**
 * Evaluate one product's stock level and announce it at most once.
 *
 * Deduplication is the database's job — one open alert per product is a
 * partial unique index — so this can safely be called after *every* inventory
 * movement without producing an alert per page load. Only `opened` and
 * `escalated` notify, and `mark_inventory_alert_notified` is what makes the
 * second call for the same alert silent.
 */
export async function evaluateAndAnnounceStock(productId: string): Promise<InventoryAlertOutcome> {
  const { data, error } = await db().rpc("evaluate_inventory_alert", { p_product_id: productId });
  if (error) {
    logLifecycleFailure("evaluate_inventory_alert", error, { productId });
    return { action: "none" };
  }
  const outcome = (data ?? { action: "none" }) as InventoryAlertOutcome;

  /**
   * Stock coming back is news too.
   *
   * An alert nobody ever sees close teaches staff that the bell is a list of
   * things that were once true, which is how a real blocker gets scrolled past.
   * The resolution is keyed off the same alert row, so it lands once.
   */
  if (outcome.action === "resolved" && outcome.alert_id) {
    await resolveOperationalAlert({
      kind: "inventory.low_stock",
      subjectId: productId,
      discriminator: outcome.alert_id,
      message: `${outcome.product_name || "A product"} is back above its low-stock threshold.`,
    });
    return outcome;
  }

  if (outcome.action !== "opened" && outcome.action !== "escalated") return outcome;
  if (!outcome.alert_id) return outcome;

  const { data: claimed } = await db().rpc("mark_inventory_alert_notified", { p_alert_id: outcome.alert_id });
  // Another request got there first. Not an error, and not a reason to send.
  if (claimed !== true) return outcome;

  const settings = await loadCommerceSettings();
  if (!settings.email.categories.staffAlerts) return outcome;

  const out = outcome.level === "out";
  const name = outcome.product_name || "A product";

  // Gated on `inventory.view`, not `orders.manage`: the people who need to know
  // stock is running out are the people who can act on it.
  //
  // The alert row id is the discriminator, so an escalation from low to out is
  // a genuinely new event while a redelivery of the same level is silent —
  // `mark_inventory_alert_notified` already claims the send, and the event key
  // is the second, durable guard behind it.
  await raiseOperationalAlert({
    kind: out ? "inventory.out_of_stock" : "inventory.low_stock",
    subjectId: productId,
    discriminator: outcome.alert_id,
    message: out
      ? `${name} is out of stock. Direct purchase will be refused until it is restocked.`
      : `${name} is down to ${outcome.quantity ?? 0}, at or below its threshold of ${outcome.threshold ?? 0}.`,
  }).catch((error) => logLifecycleFailure("notify_low_stock", error, { productId }));

  const recipients = settings.inventory.lowStockRecipients.length
    ? settings.inventory.lowStockRecipients
    : settings.email.staffAlertRecipients;

  for (const recipient of recipients) {
    await sendCommerceEmail({
      to: recipient,
      orderId: null,
      templateKey: out ? "out_of_stock_alert" : "low_stock_alert",
      // Keyed on the alert row and its level, so an escalation sends once and
      // a redelivery of the same level sends nothing.
      eventKey: `inventory-alert-${outcome.alert_id}-${outcome.level}-${recipient}`,
      href: `/staff/inventory/${productId}`,
      variables: {
        product_name: name,
        quantity: String(outcome.quantity ?? 0),
        threshold: String(outcome.threshold ?? 0),
        order_label: "Inventory",
      },
    });
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Fulfillment
// ---------------------------------------------------------------------------

export type FulfillmentTransitionResult =
  | { ok: true; already: boolean; from?: string; status: string }
  | { ok: false; error: "order_not_found" | "stale" | "failed"; status?: string };

/**
 * Move an order's fulfillment state.
 *
 * The from-status is passed and re-asserted inside the RPC's `WHERE` clause, so
 * a change that landed between the staff member's page load and their click
 * matches zero rows and is refused with `stale` rather than overwriting
 * somebody else's work. Repeating a transition reports `already`, which is what
 * makes a double-click harmless instead of an error the operator has to read.
 */
export async function transitionFulfillment(input: {
  orderId: string;
  from: string | null;
  to: string;
  actorUserId: string | null;
  actorRole?: string | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<FulfillmentTransitionResult> {
  const { data, error } = await db().rpc("transition_order_fulfillment", {
    p_order_id: input.orderId,
    p_from: input.from,
    p_to: input.to,
    p_actor: input.actorUserId,
    p_actor_role: input.actorRole ?? "staff",
    p_note: input.note ?? null,
    p_metadata: input.metadata ?? {},
  });
  if (error) {
    logLifecycleFailure("transition_order_fulfillment", error, { orderId: input.orderId, to: input.to });
    return { ok: false, error: "failed" };
  }
  const result = data as { ok?: boolean; already?: boolean; from?: string; status?: string; error?: string } | null;
  if (!result?.ok) {
    return {
      ok: false,
      error: (result?.error as "order_not_found" | "stale") ?? "failed",
      status: result?.status,
    };
  }
  return { ok: true, already: Boolean(result.already), from: result.from, status: String(result.status) };
}

/** The fulfillment timeline a staff member reads on every visit to an order. */
export async function loadFulfillmentHistory(orderId: string, limit = 50) {
  const { data, error } = await db()
    .from("order_fulfillment_events")
    .select("id,from_status,to_status,actor_user_id,actor_role,note,metadata,created_at")
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })
    .limit(Math.min(200, Math.max(1, limit)));
  if (error) {
    logLifecycleFailure("load_fulfillment_history", error, { orderId });
    return [];
  }
  return data ?? [];
}
