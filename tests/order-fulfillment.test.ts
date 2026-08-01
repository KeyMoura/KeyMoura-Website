import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("fulfillment migration adds protected shipping data and email templates", () => {
  const sql = read("supabase/migrations/20260731170000_order_fulfillment.sql");
  for (const field of ["fulfillment_method", "shipping_address", "tracking_number", "tracking_url", "shipped_at", "delivered_at"]) assert.match(sql, new RegExp(field));
  assert.match(sql, /order_shipped/);
  assert.match(sql, /order_delivered/);
});

test("staff fulfillment actions validate tracking and send idempotent emails", () => {
  const route = read("src/app/api/staff/orders/[id]/route.ts");
  assert.match(route, /Add a tracking number before marking this order shipped/);
  assert.match(route, /order-fulfillment-\$\{id\}-\$\{templateKey\}/);
  assert.match(route, /Tracking link must use https:\/\//);
  assert.match(route, /customer must approve the finished order before fulfillment/i);
  assert.match(route, /remaining balance must be paid before fulfillment/i);
  assert.match(route, /Mark this order shipped or ready for pickup first/);
  assert.match(route, /update\.completed_at/);
});

test("staff and customer order pages expose the fulfillment workflow", () => {
  const staff = read("src/app/staff/orders/[id]/page.tsx");
  const customer = read("src/app/orders/[id]/page.tsx");
  assert.match(staff, /Activity timeline/);
  assert.match(staff, /Mark shipped \+ email/);
  assert.match(staff, /Mark delivered \+ email/);
  assert.match(customer, /Track shipment/);
});

test("staff and customer activity timelines show each recorded payment", () => {
  const staff = read("src/app/staff/orders/[id]/page.tsx");
  const customer = read("src/app/orders/[id]/page.tsx");
  for (const page of [staff, customer]) {
    assert.match(page, /from\("order_payments"\)/);
    assert.match(page, /Payment received/);
    assert.match(page, /payment\.amount_cents/);
    assert.match(page, /payment\.received_at/);
  }
});

test("staff and customer activity timelines show each recorded refund", () => {
  const staff = read("src/app/staff/orders/[id]/page.tsx");
  const customer = read("src/app/orders/[id]/page.tsx");
  for (const page of [staff, customer]) {
    assert.match(page, /from\("order_refunds"\)/);
    assert.match(page, /Refund issued/);
    assert.match(page, /refund\.amount_cents/);
    assert.match(page, /refund\.reason/);
    assert.match(page, /refund\.created_at/);
  }
});

test("finished-product review is distinct from quote review and customer approval is recorded", () => {
  const migration = read("supabase/migrations/20260801010000_order_final_review.sql");
  const staffRoute = read("src/app/api/staff/orders/[id]/route.ts");
  const approvalRoute = read("src/app/api/orders/[id]/final-review/route.ts");
  const customer = read("src/app/orders/[id]/page.tsx");
  assert.match(migration, /'final_review'/);
  assert.match(staffRoute, /"final_review"/);
  assert.match(approvalRoute, /status !== "final_review"/);
  assert.match(approvalRoute, /from_status:"final_review", to_status:"ready"/);
  assert.match(approvalRoute, /Finished order approved by customer/);
  assert.match(customer, /Approve finished order/);
});
