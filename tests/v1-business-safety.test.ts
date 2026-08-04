import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync("supabase/migrations/20260801050000_order_refunds_and_quote_expiration.sql", "utf8");
const refundRoute = readFileSync("src/app/api/staff/orders/[id]/refund/route.ts", "utf8");
const checkoutRoute = readFileSync("src/app/api/orders/[id]/checkout/route.ts", "utf8");
const quoteRoute = readFileSync("src/app/api/orders/[id]/quote/route.ts", "utf8");
const webhook = readFileSync("src/app/api/webhooks/stripe/route.ts", "utf8");
const staffPage = readFileSync("src/app/staff/orders/[id]/page.tsx", "utf8");
const footer = readFileSync("src/components/SiteFooter.tsx", "utf8");
const accountingMigration = readFileSync("supabase/migrations/20260801080000_atomic_payment_accounting.sql", "utf8");

test("payments and refunds have protected, itemized records", () => {
  assert.match(migration, /create table if not exists public\.order_payments/);
  assert.match(migration, /create table if not exists public\.order_refunds/);
  assert.match(migration, /stripe_payment_intent_id text not null unique/);
  assert.match(migration, /enable row level security/);
  assert.match(webhook, /record_stripe_order_payment/);
  assert.match(accountingMigration, /insert into public\.order_payments/);
  assert.match(accountingMigration, /on conflict \(stripe_payment_intent_id\) do nothing/);
});

test("staff refunds are permission checked, bounded, confirmed, and idempotent", () => {
  assert.match(refundRoute, /requirePermission\(req, "orders\.manage"\)/);
  assert.match(refundRoute, /Refund exceeds the refundable amount/);
  assert.match(refundRoute, /idempotencyKey/);
  assert.match(refundRoute, /record_stripe_order_refund/);
  assert.match(staffPage, /This cannot be undone/);
  assert.match(staffPage, /Cancelling an order does not move money/);
});

test("expired quotes cannot be approved or paid", () => {
  assert.match(checkoutRoute, /quote has expired/i);
  assert.match(quoteRoute, /quote has expired/i);
  assert.match(staffPage, /Quote valid through/);
});

test("customer policy pages are discoverable", () => {
  // The footer's columns come from the shared navigation module now, so the
  // policy links are asserted where they are defined rather than as literals
  // in the component that maps over them.
  const nav = readFileSync("src/lib/navigation.ts", "utf8");
  for (const href of ["/shipping", "/refunds", "/terms", "/privacy", "/contact"]) {
    assert.match(nav, new RegExp(`href: "${href}"`), `${href} must stay in the footer navigation`);
  }
  assert.match(footer, /footerNav\.map/);
  for (const file of ["src/app/privacy/page.tsx", "src/app/terms/page.tsx", "src/app/shipping/page.tsx", "src/app/refunds/page.tsx"]) {
    assert.match(readFileSync(file, "utf8"), /support@keymoura\.com|PolicyPage/);
  }
});
