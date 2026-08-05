import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { logLifecycleFailure } from "@/lib/commerce/orderLifecycleServer";
import { expireReservations } from "@/lib/commerce/commerceSettingsServer";

/**
 * The inventory overview.
 *
 * Counts and reservation totals are computed in Postgres and paginated. Loading
 * the whole ledger to add it up in JavaScript is how a page that is fine with
 * two products falls over at two hundred.
 */

export const runtime = "nodejs";

const PAGE_SIZE = 25;

type InventoryListRow = {
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
  category_id: string | null;
  archived_at: string | null;
};

/** PostgREST's own `or()` separators, stripped so a search box cannot inject a filter. */
const sanitizeSearch = (raw: string) => raw.replace(/[,()\\]/g, "").trim().slice(0, 80);

export async function GET(req: NextRequest) {
  const actor = await requirePermission(req, "inventory.view");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Opportunistic: there is no cron service in this project, so a lapsed hold
  // is swept whenever somebody looks. Availability already ignores one, so this
  // tidies the table rather than fixing a wrong number.
  await expireReservations(200).catch(() => 0);

  const url = new URL(req.url);
  const page = Math.max(0, Number(url.searchParams.get("page") ?? 0) || 0);
  const search = sanitizeSearch(url.searchParams.get("q") ?? "");
  const filter = url.searchParams.get("filter") ?? "all";
  const categoryId = url.searchParams.get("category") ?? "";

  let query = routeServiceClient
    .from("products")
    .select(
      "id,name,slug,sku,inventory_policy,inventory_quantity,low_stock_threshold," +
        "continue_selling_when_out_of_stock,made_to_order,purchase_mode,is_published,category_id,archived_at",
      { count: "exact" }
    )
    .is("archived_at", null);

  if (search) query = query.or(`name.ilike.%${search}%,sku.ilike.%${search}%`);
  if (categoryId) query = query.eq("category_id", categoryId);

  switch (filter) {
    case "tracked":
      query = query.eq("inventory_policy", "track");
      break;
    case "untracked":
      query = query.neq("inventory_policy", "track");
      break;
    case "made_to_order":
      query = query.eq("made_to_order", true);
      break;
    case "backorder":
      query = query.eq("continue_selling_when_out_of_stock", true);
      break;
    case "out_of_stock":
      query = query.eq("inventory_policy", "track").lte("inventory_quantity", 0);
      break;
    case "low_stock":
      // The threshold is per product, so "low" cannot be a constant. Filtered
      // after the fetch below, on the page only.
      query = query.eq("inventory_policy", "track");
      break;
    default:
      break;
  }

  const { data, error, count } = await query
    .order("name", { ascending: true })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

  if (error) {
    logLifecycleFailure("load_inventory_overview", error);
    return NextResponse.json({ error: "Could not load inventory." }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as InventoryListRow[];
  const productIds = rows.map((row) => row.id);

  // One grouped query for every reservation on the page, rather than one per
  // row. Expired holds are excluded here as well as by status, so the figure is
  // right even between sweeps.
  const reservedByProduct = new Map<string, { quantity: number; count: number }>();
  if (productIds.length) {
    const { data: holds, error: holdsError } = await routeServiceClient
      .from("inventory_reservations")
      .select("product_id,quantity")
      .in("product_id", productIds)
      .eq("status", "active")
      .gt("expires_at", new Date().toISOString());
    if (holdsError) logLifecycleFailure("load_inventory_reservations", holdsError);
    for (const hold of holds ?? []) {
      const current = reservedByProduct.get(hold.product_id) ?? { quantity: 0, count: 0 };
      current.quantity += Number(hold.quantity || 0);
      current.count += 1;
      reservedByProduct.set(hold.product_id, current);
    }
  }

  const { data: alerts } = productIds.length
    ? await routeServiceClient
        .from("inventory_alerts")
        .select("product_id,level,created_at")
        .in("product_id", productIds)
        .eq("status", "open")
    : { data: [] };
  const alertByProduct = new Map((alerts ?? []).map((row) => [row.product_id, row]));

  const items = rows.map((row) => {
    const reserved = reservedByProduct.get(row.id) ?? { quantity: 0, count: 0 };
    const tracked = row.inventory_policy === "track" && !row.made_to_order;
    const onHand = Number(row.inventory_quantity || 0);
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      sku: row.sku,
      tracked,
      madeToOrder: Boolean(row.made_to_order),
      backordersAllowed: Boolean(row.continue_selling_when_out_of_stock),
      purchaseMode: row.purchase_mode,
      isPublished: Boolean(row.is_published),
      onHand,
      reserved: reserved.quantity,
      reservationCount: reserved.count,
      available: tracked ? Math.max(0, onHand - reserved.quantity) : null,
      lowStockThreshold: Number(row.low_stock_threshold || 0),
      openAlert: alertByProduct.get(row.id)?.level ?? null,
      availability: !tracked
        ? row.made_to_order
          ? "made_to_order"
          : "untracked"
        : onHand - reserved.quantity > Number(row.low_stock_threshold || 0)
          ? "in_stock"
          : onHand - reserved.quantity > 0
            ? "low_stock"
            : row.continue_selling_when_out_of_stock
              ? "backorder"
              : "out_of_stock",
    };
  });

  const visible = filter === "low_stock" ? items.filter((item) => item.availability === "low_stock") : items;

  return NextResponse.json({
    items: visible,
    page,
    pageSize: PAGE_SIZE,
    total: count ?? visible.length,
    hasMore: (page + 1) * PAGE_SIZE < (count ?? 0),
  });
}
