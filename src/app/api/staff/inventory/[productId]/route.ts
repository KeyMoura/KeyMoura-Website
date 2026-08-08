import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { logLifecycleAudit, logLifecycleFailure } from "@/lib/commerce/orderLifecycleServer";
import { evaluateAndAnnounceStock } from "@/lib/commerce/commerceSettingsServer";

/**
 * One product's inventory: current figures, live holds, and the adjustment
 * ledger — plus the manual adjustment itself.
 *
 * Adjustments go through `adjust_product_inventory`, the pass-7 function that
 * reads, changes and records under a row lock in one statement. Reading a
 * quantity here and writing it back would reintroduce exactly the race that
 * function exists to prevent.
 */

export const runtime = "nodejs";

const HISTORY_PAGE = 25;

type InventoryProductRow = {
  id: string;
  name: string;
  slug: string | null;
  sku: string | null;
  inventory_policy: string;
  inventory_quantity: number;
  low_stock_threshold: number;
  continue_selling_when_out_of_stock: boolean;
  made_to_order: boolean;
  purchase_mode: string;
  is_published: boolean;
};

export async function GET(req: NextRequest, context: { params: Promise<{ productId: string }> }) {
  const actor = await requirePermission(req, "inventory.view");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { productId } = await context.params;

  const url = new URL(req.url);
  const page = Math.max(0, Number(url.searchParams.get("page") ?? 0) || 0);

  const { data: productRow, error } = await routeServiceClient
    .from("products")
    .select(
      "id,name,slug,sku,inventory_policy,inventory_quantity,low_stock_threshold," +
        "continue_selling_when_out_of_stock,made_to_order,purchase_mode,is_published"
    )
    .eq("id", productId)
    .maybeSingle();
  const product = productRow as unknown as InventoryProductRow | null;

  if (error) {
    logLifecycleFailure("load_inventory_product", error, { productId });
    return NextResponse.json({ error: "Could not load this product." }, { status: 500 });
  }
  if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });

  // Paginated. The ledger grows without bound, and a product with a thousand
  // movements must not send a thousand rows to render twenty-five.
  const [{ data: reservations }, { data: history, count }, { data: openAlert }] = await Promise.all([
    routeServiceClient
      .from("inventory_reservations")
      .select("id,quantity,status,expires_at,created_at,order_id,checkout_session_id")
      .eq("product_id", productId)
      .eq("status", "active")
      .gt("expires_at", new Date().toISOString())
      .order("expires_at", { ascending: true })
      .limit(50),
    routeServiceClient
      .from("inventory_adjustments")
      // `created_by`, not `actor_user_id` — the latter has never been a column
      // on this table, so this whole read failed and the stock-movement history
      // rendered as "no movements" for every product.
      .select("id,delta,quantity_before,quantity_after,reason,note,order_id,created_at,created_by", {
        count: "exact",
      })
      .eq("product_id", productId)
      .order("created_at", { ascending: false })
      .range(page * HISTORY_PAGE, page * HISTORY_PAGE + HISTORY_PAGE - 1),
    routeServiceClient
      .from("inventory_alerts")
      .select("id,level,threshold,quantity_at_alert,created_at,notified_at")
      .eq("product_id", productId)
      .eq("status", "open")
      .maybeSingle(),
  ]);

  const reserved = (reservations ?? []).reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  const tracked = product.inventory_policy === "track" && !product.made_to_order;

  return NextResponse.json({
    product: {
      id: product.id,
      name: product.name,
      slug: product.slug,
      sku: product.sku,
      tracked,
      madeToOrder: Boolean(product.made_to_order),
      backordersAllowed: Boolean(product.continue_selling_when_out_of_stock),
      purchaseMode: product.purchase_mode,
      isPublished: Boolean(product.is_published),
      onHand: Number(product.inventory_quantity || 0),
      reserved,
      available: tracked ? Math.max(0, Number(product.inventory_quantity || 0) - reserved) : null,
      lowStockThreshold: Number(product.low_stock_threshold || 0),
    },
    // The order id is included so staff can reach the order; nothing about the
    // customer is. A hold is not a place to learn who is buying what.
    reservations: (reservations ?? []).map((row) => ({
      id: row.id,
      quantity: row.quantity,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      orderId: row.order_id,
    })),
    history: history ?? [],
    historyPage: page,
    historyTotal: count ?? 0,
    hasMoreHistory: (page + 1) * HISTORY_PAGE < (count ?? 0),
    openAlert: openAlert ?? null,
  });
}

const REASONS = new Set([
  "recount",
  "damage",
  "loss",
  "found",
  "production",
  "supplier_delivery",
  "correction",
  "other",
]);

export async function POST(req: NextRequest, context: { params: Promise<{ productId: string }> }) {
  const actor = await requirePermission(req, "inventory.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { productId } = await context.params;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const mode = String(body.mode || "");
  if (!["set", "increment", "decrement"].includes(mode)) {
    return NextResponse.json({ error: "Choose whether to set, add or remove stock." }, { status: 400 });
  }

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0 || amount > 1_000_000) {
    return NextResponse.json({ error: "Enter a whole number of units." }, { status: 400 });
  }

  // A reason is required on every manual movement. "The count changed and
  // nobody knows why" is the state this ledger exists to make impossible.
  const reason = String(body.reason || "");
  if (!REASONS.has(reason)) {
    return NextResponse.json({ error: "Choose a reason for this adjustment." }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
  if (reason === "other" && note.length < 3) {
    return NextResponse.json({ error: "Describe the reason for this adjustment." }, { status: 400 });
  }

  const { data: product } = await routeServiceClient
    .from("products")
    .select("id,name,inventory_quantity,inventory_policy,made_to_order,continue_selling_when_out_of_stock")
    .eq("id", productId)
    .maybeSingle();
  if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });

  if (product.inventory_policy !== "track") {
    return NextResponse.json(
      { error: "This product does not track stock, so there is no quantity to adjust." },
      { status: 409 }
    );
  }

  const before = Number(product.inventory_quantity || 0);
  const delta = mode === "set" ? amount - before : mode === "increment" ? amount : -amount;

  if (delta === 0) {
    return NextResponse.json({ ok: true, unchanged: true, quantity: before });
  }

  // Negative stock is refused unless backorders are explicitly enabled. A count
  // below zero is not a number anyone can act on.
  if (before + delta < 0 && !product.continue_selling_when_out_of_stock) {
    return NextResponse.json(
      {
        error: `That would take ${product.name} to ${before + delta}. Stock cannot go below zero unless backorders are enabled.`,
      },
      { status: 409 }
    );
  }

  // The browser sends what it believed the count was. A movement that landed in
  // between is refused rather than silently applied to a different number.
  if (body.expectedQuantity !== undefined && Number(body.expectedQuantity) !== before) {
    return NextResponse.json(
      { error: "This count changed since the page loaded. Reload and check before adjusting.", quantity: before },
      { status: 409 }
    );
  }

  const { data: adjusted, error: adjustError } = await routeServiceClient.rpc("adjust_product_inventory", {
    p_product_id: productId,
    p_delta: delta,
    p_reason: reason,
    // Keyed per submission, so a double-clicked Save applies once. The pass-7
    // function is a no-op on a key it has already seen.
    p_idempotency_key:
      typeof body.idempotencyKey === "string" && body.idempotencyKey
        ? `manual:${productId}:${String(body.idempotencyKey).slice(0, 64)}`
        : null,
    p_note: note || null,
    p_created_by: actor.userId,
  });

  if (adjustError) {
    logLifecycleFailure("manual_inventory_adjustment", adjustError, { productId });
    return NextResponse.json({ error: "Could not adjust this product's stock." }, { status: 500 });
  }

  const result = adjusted as { quantity_before?: number; quantity_after?: number } | null;
  const after = Number(result?.quantity_after ?? before + delta);

  await logLifecycleAudit({
    eventType: "staff.inventory.adjusted",
    actorUserId: actor.userId,
    orderId: productId,
    // The free-text note is deliberately not copied in: the audit log is read
    // more widely than the inventory page.
    metadata: { product_id: productId, mode, delta, quantity_before: before, quantity_after: after, reason },
  });

  // Stock moved, so the alert is re-evaluated. Deduplication is a partial
  // unique index, so this cannot raise a second alert for a flagged product,
  // and crossing back above the threshold resolves the open one.
  const alert = await evaluateAndAnnounceStock(productId);

  return NextResponse.json({ ok: true, quantityBefore: before, quantityAfter: after, delta, alert: alert.action });
}
