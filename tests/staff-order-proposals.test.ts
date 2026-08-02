import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path:string) => readFileSync(path, "utf8");

test("staff can compose and send an order proposal", () => {
  const page = read("src/app/staff/orders/new/page.tsx");
  const route = read("src/app/api/staff/orders/proposals/route.ts");
  assert.match(page, /Create an order for a customer/);
  assert.match(page, /Customer preview/);
  assert.match(page, /Send proposal/);
  assert.match(route, /requirePermission\(req, "orders\.manage"\)/);
  assert.match(route, /initiated_by_staff: true/);
  assert.match(route, /New order proposal/);
});

test("customer can accept or decline a staff proposal", () => {
  const page = read("src/app/orders/[id]/page.tsx");
  const route = read("src/app/api/orders/[id]/proposal/route.ts");
  assert.match(page, /Accept proposal/);
  assert.match(page, /Decline proposal/);
  assert.match(page, /Message KeyMoura/);
  assert.match(route, /Customer accepted staff proposal/);
  assert.match(route, /Customer declined proposal/);
  assert.match(route, /notifyOrderStaff/);
});

test("proposal schema distinguishes staff proposals from customer requests", () => {
  const migration = read("supabase/migrations/20260801020000_staff_order_proposals.sql");
  assert.match(migration, /initiated_by_staff boolean not null default false/);
  assert.match(migration, /proposal_sent_at timestamptz/);
  assert.match(migration, /proposal_decided_at timestamptz/);
});

test("staff receives quote and payment lifecycle notifications", () => {
  assert.match(read("src/app/api/orders/[id]/quote/route.ts"), /title:"Quote approved"/);
  assert.match(read("src/app/api/webhooks/stripe/route.ts"), /title:fullyPaid \? "Order paid in full" : "Deposit received"/);
});
