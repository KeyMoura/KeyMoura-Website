import { NextRequest, NextResponse } from "next/server";

import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { logLifecycleFailure } from "@/lib/commerce/orderLifecycleServer";

export const runtime = "nodejs";

const MATERIAL_COLUMNS =
  "id,name,sku,specification,unit,current_quantity,average_unit_cost_cents," +
  "reorder_threshold,preferred_supplier_id," +
  "preferred_supplier:suppliers!materials_preferred_supplier_id_fkey(id,name)";

// `materials_preferred_supplier_id_fkey` is the constraint PostgreSQL assigns
// to materials.preferred_supplier_id. Keep the name in the select above rather
// than reverting to an implicit `suppliers(...)` embed: supplier_materials adds
// a second path between these resources and makes that shorthand ambiguous.

const UNITS = new Set([
  "board_feet",
  "square_inches",
  "linear_inches",
  "pounds",
  "pieces",
  "sheets",
  "ounces",
  "feet",
  "inches",
]);

const clean = (value: unknown, max = 240) => String(value ?? "").trim().slice(0, max);

export async function GET(req: NextRequest) {
  if (!(await requirePermission(req, "materials.view"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const search = clean(new URL(req.url).searchParams.get("q"), 80).replace(/[,()\\]/g, "");
  let query = routeServiceClient
    .from("materials")
    // There are two paths between materials and suppliers. Naming the FK keeps
    // PostgREST from guessing between the preferred supplier and the junction.
    .select(MATERIAL_COLUMNS)
    .is("archived_at", null)
    .order("name");
  if (search) query = query.or(`name.ilike.%${search}%,sku.ilike.%${search}%`);

  const { data, error } = await query.limit(100);
  if (error) {
    logLifecycleFailure("load_materials", error);
    return NextResponse.json({ error: "Could not load materials." }, { status: 500 });
  }
  return NextResponse.json({ items: data ?? [] });
}

export async function POST(req: NextRequest) {
  if (!(await requirePermission(req, "materials.manage"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const quantity = Number(body?.currentQuantity);
  const cost = Math.round(Number(body?.averageUnitCostCents));
  if (
    !body ||
    clean(body.name).length < 2 ||
    clean(body.sku).length < 2 ||
    !Number.isFinite(quantity) ||
    quantity < 0 ||
    !Number.isFinite(cost) ||
    cost < 0
  ) {
    return NextResponse.json(
      { error: "Enter a name, unique SKU, and valid non-negative quantity and cost." },
      { status: 400 }
    );
  }
  if (!UNITS.has(body.unit)) {
    return NextResponse.json({ error: "Choose a valid unit." }, { status: 400 });
  }

  const { data, error } = await routeServiceClient
    .from("materials")
    .insert({
      name: clean(body.name, 160),
      sku: clean(body.sku, 80).toUpperCase(),
      specification: clean(body.specification, 500) || null,
      unit: body.unit,
      current_quantity: quantity,
      average_unit_cost_cents: cost,
      reorder_threshold: body.reorderThreshold === "" ? null : Number(body.reorderThreshold),
      preferred_supplier_id: body.preferredSupplierId || null,
    })
    .select(MATERIAL_COLUMNS)
    .single();

  if (error) {
    logLifecycleFailure("create_material", error);
    return NextResponse.json(
      { error: error.code === "23505" ? "That SKU is already in use." : "Could not save material." },
      { status: 400 }
    );
  }
  return NextResponse.json({ item: data }, { status: 201 });
}
