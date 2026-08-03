import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  allowsDirectPurchase,
  allowsRequest,
  normalizePurchaseMode,
  PURCHASE_MODES,
} from "../src/lib/commerce/purchaseModes.ts";
import {
  clampQuantity,
  isRejected,
  lineSignature,
  priceCart,
  priceLine,
  purchasableQuantity,
  type PricedProduct,
  type RequestedLine,
} from "../src/lib/commerce/pricing.ts";
import {
  cartTotals,
  evaluateDiscount,
  lineIsEligible,
  normalizeDiscountCodeInput,
  type DiscountCode,
} from "../src/lib/commerce/discounts.ts";
import {
  buildCategoryTree,
  categoryScopeIds,
  categoryTrail,
  categorySlug,
  categoryNameProblem,
  deletionProblem,
  parentProblem,
  uniqueCategorySlug,
  type CategoryRow,
} from "../src/lib/commerce/categories.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function product(overrides: Partial<PricedProduct> = {}): PricedProduct {
  return {
    id: "p1",
    name: "Shift Knob",
    slug: "shift-knob",
    is_published: true,
    archived_at: null,
    purchase_mode: "direct_purchase",
    starting_price_cents: 4500,
    availability_status: "available",
    inventory_policy: "unlimited",
    inventory_quantity: 0,
    continue_selling_when_out_of_stock: false,
    option_groups: [],
    ...overrides,
  };
}

const line = (overrides: Partial<RequestedLine> = {}): RequestedLine => ({
  productId: "p1",
  quantity: 1,
  selectedOptions: {},
  ...overrides,
});

// --- purchase modes ------------------------------------------------------

test("purchase modes gate the cart and the request path", () => {
  assert.equal(allowsDirectPurchase("direct_purchase"), true);
  assert.equal(allowsDirectPurchase("direct_or_request"), true);
  assert.equal(allowsDirectPurchase("request_only"), false);

  assert.equal(allowsRequest("request_only"), true);
  assert.equal(allowsRequest("direct_or_request"), true);
  assert.equal(allowsRequest("direct_purchase"), false);
});

test("an unknown purchase mode falls back to the safest one", () => {
  // Defaulting to request_only means a bad value can never open direct checkout.
  for (const bad of [null, undefined, "", "buy_it_now", 42, {}]) {
    assert.equal(normalizePurchaseMode(bad), "request_only");
  }
  for (const mode of PURCHASE_MODES) assert.equal(normalizePurchaseMode(mode), mode);
});

// --- pricing -------------------------------------------------------------

test("a request-only product can never be priced for direct checkout", () => {
  const result = priceLine(product({ purchase_mode: "request_only" }), line());
  assert.ok(isRejected(result));
  assert.equal(result.blocker.reason, "mode");
});

test("a product with no fixed price cannot be bought directly", () => {
  const result = priceLine(product({ starting_price_cents: null }), line());
  assert.ok(isRejected(result));
  assert.equal(result.blocker.reason, "no_price");
});

test("unpublished, archived, and unavailable products are refused", () => {
  for (const overrides of [
    { is_published: false },
    { archived_at: "2026-01-01T00:00:00Z" },
    { availability_status: "unavailable" as const },
  ]) {
    const result = priceLine(product(overrides), line());
    assert.ok(isRejected(result), `expected rejection for ${JSON.stringify(overrides)}`);
  }
});

test("option surcharges are added server-side from the live option row", () => {
  const withOptions = product({
    option_groups: [
      {
        id: "g1",
        option_key: "finish",
        name: "Finish",
        is_required: true,
        input_type: "select",
        values: [
          { id: "v1", label: "Raw", value: "raw", price_adjustment_cents: 0, is_active: true, requires_request: false },
          { id: "v2", label: "Anodized", value: "anodized", price_adjustment_cents: 1200, is_active: true, requires_request: false },
        ],
      },
    ],
  });

  const result = priceLine(withOptions, line({ quantity: 2, selectedOptions: { finish: "anodized" } }));
  assert.ok(!isRejected(result));
  assert.equal(result.unitPriceCents, 5700);
  assert.equal(result.lineSubtotalCents, 11400);
  assert.deepEqual(result.selectedOptions, { finish: "anodized" });
});

test("an option flagged requires_request forces the request path", () => {
  const withOptions = product({
    option_groups: [
      {
        id: "g1",
        option_key: "size",
        name: "Size",
        is_required: true,
        input_type: "select",
        values: [
          { id: "v1", label: "Standard", value: "std", price_adjustment_cents: 0, is_active: true, requires_request: false },
          { id: "v2", label: "Oversized", value: "xl", price_adjustment_cents: 0, is_active: true, requires_request: true },
        ],
      },
    ],
  });

  const ok = priceLine(withOptions, line({ selectedOptions: { size: "std" } }));
  assert.ok(!isRejected(ok));

  const blocked = priceLine(withOptions, line({ selectedOptions: { size: "xl" } }));
  assert.ok(isRejected(blocked));
  assert.equal(blocked.blocker.reason, "option_requires_request");
});

test("an inactive or unknown option value is never honored", () => {
  const withOptions = product({
    option_groups: [
      {
        id: "g1",
        option_key: "finish",
        name: "Finish",
        is_required: false,
        input_type: "select",
        values: [
          { id: "v1", label: "Retired", value: "retired", price_adjustment_cents: -4000, is_active: false, requires_request: false },
        ],
      },
    ],
  });

  // A deactivated value with a negative adjustment must not discount the line.
  const result = priceLine(withOptions, line({ selectedOptions: { finish: "retired" } }));
  assert.ok(!isRejected(result));
  assert.equal(result.unitPriceCents, 4500);
  assert.deepEqual(result.selectedOptions, {});

  const unknown = priceLine(withOptions, line({ selectedOptions: { finish: "does-not-exist" } }));
  assert.ok(!isRejected(unknown));
  assert.equal(unknown.unitPriceCents, 4500);
});

test("a missing required option is reported rather than guessed", () => {
  const withOptions = product({
    option_groups: [
      {
        id: "g1",
        option_key: "finish",
        name: "Finish",
        is_required: true,
        input_type: "select",
        values: [{ id: "v1", label: "Raw", value: "raw", price_adjustment_cents: 0, is_active: true, requires_request: false }],
      },
    ],
  });
  const result = priceLine(withOptions, line({ selectedOptions: {} }));
  assert.ok(isRejected(result));
});

test("quantity is clamped to stock and to the line maximum", () => {
  assert.equal(clampQuantity(-5), 1);
  assert.equal(clampQuantity(0), 1);
  assert.equal(clampQuantity(1000), 99);
  assert.equal(clampQuantity("3"), 3);
  assert.equal(clampQuantity("abc"), 1);
  assert.equal(clampQuantity(2.9), 2);

  const tracked = product({ inventory_policy: "track", inventory_quantity: 3 });
  assert.equal(purchasableQuantity(tracked), 3);
  const result = priceLine(tracked, line({ quantity: 10 }));
  assert.ok(!isRejected(result));
  assert.equal(result.quantity, 3, "cannot buy more than exists");
});

test("out of stock is refused unless backorders are allowed", () => {
  assert.equal(purchasableQuantity(product({ inventory_policy: "track", inventory_quantity: 0 })), 0);
  assert.equal(
    purchasableQuantity(product({ inventory_policy: "track", inventory_quantity: 0, continue_selling_when_out_of_stock: true })),
    99
  );
});

test("a cart keeps good lines and explains the rejected ones", () => {
  const products = new Map<string, PricedProduct>([
    ["p1", product({ id: "p1" })],
    ["p2", product({ id: "p2", name: "Custom Bracket", purchase_mode: "request_only" })],
  ]);

  const cart = priceCart(products, [
    { productId: "p1", quantity: 2, selectedOptions: {} },
    { productId: "p2", quantity: 1, selectedOptions: {} },
    { productId: "gone", quantity: 1, selectedOptions: {} },
  ]);

  assert.equal(cart.lines.length, 1);
  assert.equal(cart.subtotalCents, 9000);
  assert.equal(cart.itemCount, 2);
  assert.equal(cart.rejected.length, 2);
});

// --- discounts -----------------------------------------------------------

function code(overrides: Partial<DiscountCode> = {}): DiscountCode {
  return {
    id: "d1",
    code: "SAVE10",
    description: null,
    discount_type: "percent",
    discount_value: 10,
    max_discount_cents: null,
    minimum_subtotal_cents: 0,
    starts_at: null,
    ends_at: null,
    is_active: true,
    archived_at: null,
    max_total_uses: null,
    max_uses_per_customer: null,
    first_order_only: false,
    is_stackable: false,
    total_uses: 0,
    targets: [],
    ...overrides,
  };
}

const cartOf = (subtotal: number, productId = "p1") => ({
  lines: [
    {
      productId,
      lineId: `line-${productId}`,
      product: product({ id: productId }),
      quantity: 1,
      selectedOptions: {},
      optionLabels: [],
      unitPriceCents: subtotal,
      lineSubtotalCents: subtotal,
    },
  ],
  rejected: [],
  subtotalCents: subtotal,
  itemCount: 1,
});

const context = (overrides: Partial<Parameters<typeof evaluateDiscount>[2]> = {}) => ({
  customerUses: 0,
  customerOrderCount: 0,
  categoryByProduct: new Map<string, string | null>([["p1", "cat1"]]),
  ...overrides,
});

test("percentage and fixed discounts compute from the eligible subtotal", () => {
  const percent = evaluateDiscount(code(), cartOf(10000), context());
  assert.ok(percent.ok);
  assert.equal(percent.amountCents, 1000);

  const fixed = evaluateDiscount(code({ discount_type: "fixed", discount_value: 2500 }), cartOf(10000), context());
  assert.ok(fixed.ok);
  assert.equal(fixed.amountCents, 2500);
});

test("a discount can never exceed the eligible subtotal or become credit", () => {
  const result = evaluateDiscount(code({ discount_type: "fixed", discount_value: 999999 }), cartOf(5000), context());
  assert.ok(result.ok);
  assert.equal(result.amountCents, 5000);
});

test("a percentage cap is respected", () => {
  const result = evaluateDiscount(code({ discount_value: 50, max_discount_cents: 1500 }), cartOf(10000), context());
  assert.ok(result.ok);
  assert.equal(result.amountCents, 1500);
});

test("inactive, unstarted, expired, and exhausted codes are refused", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();

  const cases: Array<[Partial<DiscountCode>, string]> = [
    [{ is_active: false }, "inactive"],
    [{ archived_at: past }, "inactive"],
    [{ starts_at: future }, "not_started"],
    [{ ends_at: past }, "expired"],
    [{ max_total_uses: 5, total_uses: 5 }, "exhausted"],
  ];

  for (const [overrides, reason] of cases) {
    const result = evaluateDiscount(code(overrides), cartOf(10000), context());
    assert.ok(!result.ok, `expected refusal for ${reason}`);
    assert.equal(result.reason, reason);
  }
  assert.equal(evaluateDiscount(null, cartOf(10000), context()).ok, false);
});

test("per-customer limits and first-order-only are enforced", () => {
  const limited = evaluateDiscount(code({ max_uses_per_customer: 1 }), cartOf(10000), context({ customerUses: 1 }));
  assert.ok(!limited.ok);
  assert.equal(limited.reason, "customer_limit");

  const firstOnly = evaluateDiscount(code({ first_order_only: true }), cartOf(10000), context({ customerOrderCount: 2 }));
  assert.ok(!firstOnly.ok);
  assert.equal(firstOnly.reason, "first_order_only");

  assert.equal(evaluateDiscount(code({ first_order_only: true }), cartOf(10000), context()).ok, true);
});

test("the minimum subtotal is measured against the whole cart", () => {
  const below = evaluateDiscount(code({ minimum_subtotal_cents: 20000 }), cartOf(10000), context());
  assert.ok(!below.ok);
  assert.equal(below.reason, "minimum_subtotal");
  assert.match(below.message, /\$200\.00/);

  assert.equal(evaluateDiscount(code({ minimum_subtotal_cents: 5000 }), cartOf(10000), context()).ok, true);
});

test("targeting includes, excludes, and can leave nothing eligible", () => {
  const forProduct = code({ targets: [{ target_type: "product", target_id: "p1", is_exclusion: false }] });
  assert.equal(evaluateDiscount(forProduct, cartOf(10000), context()).ok, true);

  const otherProduct = code({ targets: [{ target_type: "product", target_id: "p9", is_exclusion: false }] });
  const miss = evaluateDiscount(otherProduct, cartOf(10000), context());
  assert.ok(!miss.ok);
  assert.equal(miss.reason, "no_eligible_items");

  const forCategory = code({ targets: [{ target_type: "category", target_id: "cat1", is_exclusion: false }] });
  assert.equal(evaluateDiscount(forCategory, cartOf(10000), context()).ok, true);

  // An exclusion always beats an inclusion.
  const excluded = code({
    targets: [
      { target_type: "category", target_id: "cat1", is_exclusion: false },
      { target_type: "product", target_id: "p1", is_exclusion: true },
    ],
  });
  assert.equal(evaluateDiscount(excluded, cartOf(10000), context()).ok, false);
});

test("line eligibility handles an uncategorized product", () => {
  const cartLine = cartOf(1000).lines[0];
  const categoryTarget = [{ target_type: "category" as const, target_id: "cat1", is_exclusion: false }];
  assert.equal(lineIsEligible(cartLine, categoryTarget, null), false);
  assert.equal(lineIsEligible(cartLine, categoryTarget, "cat1"), true);
  assert.equal(lineIsEligible(cartLine, [], null), true, "no targets means the whole cart");
});

test("submitted codes are normalized, never trusted as amounts", () => {
  assert.equal(normalizeDiscountCodeInput("  save10 "), "SAVE10");
  assert.equal(normalizeDiscountCodeInput(1000), "");
  assert.equal(normalizeDiscountCodeInput("x".repeat(80)).length, 40);
});

test("cart totals stay non-negative and respect the Stripe minimum", () => {
  assert.deepEqual(cartTotals(10000, 2500), { subtotalCents: 10000, discountCents: 2500, totalCents: 7500, chargeable: true });
  assert.deepEqual(cartTotals(1000, 5000), { subtotalCents: 1000, discountCents: 1000, totalCents: 0, chargeable: false });
  assert.equal(cartTotals(100, 60).chargeable, false, "40 cents is below the Stripe minimum");
  assert.equal(cartTotals(100, 50).chargeable, true);
});

// --- categories ----------------------------------------------------------

const cat = (overrides: Partial<CategoryRow> & { id: string; name: string; slug: string }): CategoryRow => ({
  description: null,
  parent_id: null,
  image_url: null,
  display_order: 0,
  is_active: true,
  archived_at: null,
  ...overrides,
});

test("slugs match the backfill migration's rules", () => {
  assert.equal(categorySlug("CNC & Machining"), "cnc-machining");
  assert.equal(categorySlug("  Interior  "), "interior");
  assert.equal(categorySlug("!!!"), "category");
  assert.equal(uniqueCategorySlug("Interior", ["interior"]), "interior-2");
  assert.equal(uniqueCategorySlug("Interior", ["interior", "interior-2"]), "interior-3");
});

test("blank and duplicate sibling names are refused", () => {
  const siblings = [{ id: "a", name: "Interior", parent_id: null }];
  assert.equal(categoryNameProblem("   ", siblings, null), "blank");
  assert.equal(categoryNameProblem("  interior ", siblings, null), "duplicate");
  assert.equal(categoryNameProblem("Interior", siblings, null, "a"), null, "renaming itself is fine");
  assert.equal(categoryNameProblem("Interior", siblings, "parent-1"), null, "same name under a different parent is fine");
});

test("the one-subcategory-level rule matches the database trigger", () => {
  const rows = [
    cat({ id: "p", name: "Parent", slug: "parent" }),
    cat({ id: "c", name: "Child", slug: "child", parent_id: "p" }),
    cat({ id: "o", name: "Other", slug: "other" }),
  ];

  assert.equal(parentProblem("x", null, rows), null);
  assert.match(String(parentProblem("p", "p", rows)), /own parent/);
  assert.match(String(parentProblem("x", "c", rows)), /one level/);
  assert.match(String(parentProblem("p", "o", rows)), /subcategories first/);
  assert.equal(parentProblem("o", "p", rows), null);
});

test("a category in use cannot be deleted, only archived", () => {
  const rows = [
    cat({ id: "p", name: "Parent", slug: "parent" }),
    cat({ id: "c", name: "Child", slug: "child", parent_id: "p" }),
  ];

  assert.match(String(deletionProblem(rows[0], rows, 0)), /subcategor/);
  assert.match(String(deletionProblem(rows[1], rows, 3)), /3 products/);
  assert.equal(deletionProblem(rows[1], rows, 0), null);
});

test("the tree rolls subcategory product counts into the parent", () => {
  const rows = [
    cat({ id: "p", name: "Parent", slug: "parent", display_order: 1 }),
    cat({ id: "z", name: "Zed", slug: "zed", display_order: 0 }),
    cat({ id: "c1", name: "Child B", slug: "child-b", parent_id: "p", display_order: 1 }),
    cat({ id: "c2", name: "Child A", slug: "child-a", parent_id: "p", display_order: 0 }),
  ];
  const counts = new Map([["p", 2], ["c1", 3], ["c2", 4]]);
  const tree = buildCategoryTree(rows, counts);

  assert.deepEqual(tree.map((node) => node.id), ["z", "p"], "display_order wins over name");
  const parent = tree.find((node) => node.id === "p")!;
  assert.deepEqual(parent.children.map((child) => child.id), ["c2", "c1"]);
  assert.equal(parent.directProductCount, 2);
  assert.equal(parent.totalProductCount, 9);
});

test("breadcrumbs and listing scope follow the hierarchy", () => {
  const rows = [
    cat({ id: "p", name: "Parent", slug: "parent" }),
    cat({ id: "c", name: "Child", slug: "child", parent_id: "p" }),
  ];

  assert.deepEqual(categoryTrail("c", rows).map((row) => row.id), ["p", "c"]);
  assert.deepEqual(categoryTrail("p", rows).map((row) => row.id), ["p"]);
  assert.deepEqual(categoryTrail(null, rows), []);
  assert.deepEqual(categoryTrail("missing", rows), []);

  assert.deepEqual(categoryScopeIds("p", rows).sort(), ["c", "p"], "a parent listing includes its subcategories");
  assert.deepEqual(categoryScopeIds("c", rows), ["c"]);
});

// --- migration safety ----------------------------------------------------

const MIGRATION_FILES = [
  "supabase/migrations/20260802020000_product_categories.sql",
  "supabase/migrations/20260802020100_product_purchase_modes.sql",
  "supabase/migrations/20260802020200_carts_and_wishlists.sql",
  "supabase/migrations/20260802020300_discount_codes.sql",
  "supabase/migrations/20260802020400_direct_orders_and_reviews.sql",
];

/**
 * Statements the migration itself executes, with `$$ … $$` function bodies
 * removed. A DELETE inside a function body is that function's runtime
 * behavior, not something the migration does to existing data, and the two
 * must not be confused.
 */
function migrationStatements(sql: string): string {
  return sql.replace(/\$\$[\s\S]*?\$\$/g, " FUNCTION_BODY ");
}

test("every commerce migration is additive at migration time", () => {
  for (const file of MIGRATION_FILES) {
    const sql = read(file);
    const statements = migrationStatements(sql);

    assert.ok(!/drop\s+table/i.test(statements), `${file} drops a table`);
    assert.ok(!/drop\s+column/i.test(statements), `${file} drops a column`);
    assert.ok(!/truncate/i.test(statements), `${file} truncates`);
    assert.ok(!/delete\s+from/i.test(statements), `${file} deletes existing rows`);
    assert.ok(!/alter\s+column/i.test(statements), `${file} alters an existing column`);
    assert.ok(/^begin;/m.test(sql) && /^commit;/m.test(sql), `${file} is not wrapped in a transaction`);
  }
});

test("migrations only ever add to tables that already existed", () => {
  // products, orders, and the option tables predate this work. Touching them
  // is allowed, but only by adding columns, indexes, constraints, or policies.
  const existingTables = ["products", "orders", "product_option_groups", "product_option_values"];

  for (const file of MIGRATION_FILES) {
    const statements = migrationStatements(read(file));
    for (const table of existingTables) {
      for (const match of statements.matchAll(new RegExp(`alter table (?:public\\.)?${table}\\s+([^;]+);`, "gi"))) {
        const body = match[1].toLowerCase();
        const allowed =
          body.includes("add column if not exists") ||
          body.includes("add constraint") ||
          body.includes("enable row level security");
        assert.ok(allowed, `${file} performs a non-additive alter on ${table}: ${match[1].trim().slice(0, 80)}`);
      }
    }
  }
});

test("purchase mode backfills to the mode that preserves today's behavior", () => {
  const sql = read("supabase/migrations/20260802020100_product_purchase_modes.sql");
  assert.match(sql, /purchase_mode text not null default 'request_only'/);
  assert.ok(!/update public\.products\s+set purchase_mode/i.test(sql), "no product is silently made purchasable");
});

test("cart and wishlist tables are unreachable from the browser client", () => {
  const sql = read("supabase/migrations/20260802020200_carts_and_wishlists.sql");
  for (const table of ["carts", "cart_items", "shared_carts", "wishlists", "wishlist_items"]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(sql, new RegExp(`revoke all on public\\.${table} from anon, authenticated`));
  }
  assert.ok(!/grant[^;]*to anon/i.test(sql.replace(/revoke[^;]+;/g, "")), "nothing is granted to anon");
});

test("discount tables never expose codes or limits to customers", () => {
  const sql = read("supabase/migrations/20260802020300_discount_codes.sql");
  for (const table of ["discount_codes", "discount_code_targets", "discount_redemptions"]) {
    assert.match(sql, new RegExp(`revoke all on public\\.${table} from anon, authenticated`));
  }
  assert.match(sql, /for update/, "redemption must lock the code row");
  assert.match(sql, /get diagnostics inserted_count = row_count/, "repeat redemption must be detected");
});

test("cart items carry no price columns, so prices cannot be tampered with", () => {
  const sql = read("supabase/migrations/20260802020200_carts_and_wishlists.sql");
  const cartItems = sql.slice(sql.indexOf("create table if not exists public.cart_items"), sql.indexOf("create index if not exists cart_items_cart_idx"));
  for (const field of ["price", "amount", "total", "subtotal"]) {
    assert.ok(!cartItems.includes(field), `cart_items must not store ${field}`);
  }
});

// --- cart service invariants --------------------------------------------

test("the cart service is the only place prices are decided", () => {
  const service = read("src/lib/commerce/cartService.ts");

  // Prices are read from live products, never from a request payload.
  assert.match(service, /loadPricedProducts/);
  assert.match(service, /priceCart\(products, lines\)/);
  assert.ok(
    !/body\.(unitPrice|price|subtotal|total|amount)/i.test(service),
    "the cart service must not read a price from client input"
  );

  // The drawer, the cart page, and checkout all resolve through one function.
  assert.match(service, /export async function resolveCart/);
  assert.match(service, /export async function resolveLines/);
});

test("guest and share tokens use CSPRNG entropy", () => {
  const service = read("src/lib/commerce/cartService.ts");
  assert.match(service, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.ok(!/Math\.random/.test(service), "tokens must not come from Math.random");
});

test("stored option payloads are bounded and string-only", () => {
  const service = read("src/lib/commerce/cartService.ts");
  const start = service.indexOf("function sanitizeOptions");
  const body = service.slice(start, service.indexOf("\n}", start));
  assert.match(body, /typeof entry !== "string"/);
  assert.match(body, /\.slice\(0, 30\)/, "option count is capped");
  assert.match(body, /\.slice\(0, 60\)/, "option keys are capped");
  assert.match(body, /\.slice\(0, 120\)/, "option values are capped");
});

test("the serialized cart carries no owner identity", () => {
  const service = read("src/lib/commerce/cartService.ts");
  const start = service.indexOf("export function serializeCart");
  const body = service.slice(start, service.indexOf("\nexport type SerializedCart", start));
  for (const leak of ["customer_id", "customerId", "guest_token", "guestToken", "email", "created_by"]) {
    assert.ok(!body.includes(leak), `serialized cart must not expose ${leak}`);
  }
});

test("category management routes all require the category permission", () => {
  for (const file of [
    "src/app/api/staff/catalog/categories/route.ts",
    "src/app/api/staff/catalog/categories/[id]/route.ts",
  ]) {
    const source = read(file);
    const handlers = source.match(/export async function (GET|POST|PATCH|PUT|DELETE)/g) ?? [];
    const guards = source.match(/requirePermission\(req, "catalog\.categories\.manage"\)/g) ?? [];
    assert.ok(handlers.length > 0, `${file} defines no handlers`);
    assert.equal(guards.length, handlers.length, `${file}: every handler must check the permission`);
  }
});

test("deleting a category in use is refused with an archive alternative", () => {
  const source = read("src/app/api/staff/catalog/categories/[id]/route.ts");
  assert.match(source, /deletionProblem\(current, rows, productCount\)/);
  assert.match(source, /canArchive: true/);
  assert.match(source, /status: 409/);
});

test("the new commerce permissions are registered in the typed list", () => {
  const permissions = read("src/lib/permissions.ts");
  for (const key of ["catalog.categories.manage", "catalog.discounts.manage", "catalog.reviews.moderate"]) {
    assert.ok(permissions.includes(`"${key}"`), `${key} is not registered`);
  }
});

// --- Regression tests for defects found in the phase 1-3 foundation ---

test("option values are fetched scoped to the loaded groups, never table-wide", () => {
  const source = read("src/lib/commerce/cartService.ts");
  const valuesQuery = source.slice(source.indexOf('from("product_option_values")'));
  // An unfiltered read returns every option value on the site and stops at
  // PostgREST's row cap, which silently drops real values and makes a required
  // option unresolvable — rejecting a line the customer legitimately chose.
  assert.match(
    valuesQuery.slice(0, 400),
    /\.in\("option_group_id", groupIds\)/,
    "product_option_values must be filtered by the option groups actually loaded"
  );
});

test("a priced line carries the storage row it came from", () => {
  const line = priceLine(product({ id: "p1", starting_price_cents: 1000 }), {
    productId: "p1",
    quantity: 1,
    selectedOptions: {},
    lineId: "cart-item-7",
  });
  assert.ok(!isRejected(line));
  assert.equal(line.lineId, "cart-item-7");
});

test("a rejected line also carries its storage row so the cart can point at it", () => {
  const line = priceLine(product({ id: "p1", purchase_mode: "request_only" }), {
    productId: "p1",
    quantity: 1,
    selectedOptions: {},
    lineId: "cart-item-8",
  });
  assert.ok(isRejected(line));
  assert.equal(line.lineId, "cart-item-8");
});

test("line identity distinguishes the same product configured two ways", () => {
  const walnut = lineSignature("p1", { wood: "walnut" });
  const maple = lineSignature("p1", { wood: "maple" });
  assert.notEqual(walnut, maple);

  // Key order must not change identity, or a merge would duplicate a line.
  assert.equal(
    lineSignature("p1", { wood: "walnut", size: "large" }),
    lineSignature("p1", { size: "large", wood: "walnut" })
  );
});

test("the guest cart merge keys on product and options, not product alone", () => {
  const source = read("src/lib/commerce/cartService.ts");
  assert.match(source, /lineSignature\(item\.product_id, item\.selected_options\)/);
  assert.doesNotMatch(
    source,
    /new Map\(existing\.map\(\(item\) => \[item\.product_id, item\]\)\)/,
    "merging by product id alone sums two different configurations into one line"
  );
});

test("staff commerce actions are actually written to the audit log", () => {
  const source = read("src/lib/audit.ts");
  // Category, catalog, and pricing events are logged under a `staff.` prefix.
  // Without it they were dropped for every staff role except admin.
  assert.match(source, /type\.startsWith\("staff\."\)/);
});
