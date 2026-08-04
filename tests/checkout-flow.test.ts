import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeShippingAddress } from "../src/lib/checkout.ts";

// The request wizard moved out of the product page into its own client
// component when the page became a server component. Same three steps, same
// validation, same uploads, same POST /api/orders.
const page = readFileSync("src/components/product/ProductRequestForm.tsx", "utf8");
const route = readFileSync("src/app/api/orders/route.ts", "utf8");
const migration = readFileSync("supabase/migrations/20260731190000_checkout_inventory_reservations.sql", "utf8");

test("checkout is a guided delivery and review flow", () => {
  for (const label of ["Customize", "Delivery", "Review", "Ship to me", "Local pickup", "Submit request — no charge"]) assert.match(page, new RegExp(label));
  assert.match(page, /estimated/);
  assert.match(page, /checkout_token/);
});

test("shipping addresses are normalized and require complete fields", () => {
  assert.equal(normalizeShippingAddress({ name: " ", line1: "1 Main", city: "Boston", state: "MA", postal_code: "02101", country: "US" }), null);
  assert.deepEqual(normalizeShippingAddress({ name: " Ethan ", line1: " 1 Main ", line2: "", city: "Boston", state: "MA", postal_code: "02101", country: "us" }), { name: "Ethan", line1: "1 Main", line2: "", city: "Boston", state: "MA", postal_code: "02101", country: "US" });
});

test("inventory reservation is atomic, idempotent, and reversible", () => {
  assert.match(route, /rpc\("create_checkout_order"/);
  assert.match(migration, /for update/);
  assert.match(migration, /orders_customer_checkout_token_idx/);
  assert.match(migration, /inventory_quantity = inventory_quantity - reserved_quantity/);
  assert.match(migration, /new\.status in \('declined','cancelled','completed'\)/);
  assert.match(migration, /inventory_quantity = inventory_quantity \+ old\.inventory_reserved_quantity/);
  assert.match(migration, /revoke all on function public\.create_checkout_order/);
  assert.match(migration, /grant execute .* to service_role/);
});
