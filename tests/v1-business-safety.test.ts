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
const lifecycleServer = readFileSync("src/lib/commerce/orderLifecycleServer.ts", "utf8");
const lifecyclePanel = readFileSync("src/components/staff/OrderLifecyclePanel.tsx", "utf8");

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
  // Tightened by the order-lifecycle pass. `orders.manage` used to gate
  // refunds, which meant anyone who could update tracking could also send
  // money out; `refunds.issue` is a narrower key granted to nobody by default.
  assert.match(refundRoute, /requirePermission\(req, "refunds\.issue"\)/);
  assert.equal(/requirePermission\(req, "orders\.manage"\)/.test(refundRoute), false);

  // Bounded — and now against a figure that also subtracts refunds still in
  // flight, which the old `amount_paid - amount_refunded` did not.
  assert.match(refundRoute, /is left to refund on this order/);
  assert.match(refundRoute, /Number\(amount\) > lifecycle\.refundableCents/);

  assert.match(refundRoute, /idempotency_key|idempotencyKey/);
  assert.match(lifecycleServer, /idempotencyKey: leg\.idempotency_key/);

  // The confirmation copy moved with the controls into OrderLifecyclePanel,
  // which is the single place lifecycle actions now live. Pass 11 moved the
  // confirmation itself off `window.confirm` and into a dialog that states the
  // remaining balance on its own line rather than inside a paragraph.
  assert.match(lifecyclePanel, /cannot be taken back/);
  assert.match(lifecyclePanel, /would remain refundable/);
  assert.match(lifecyclePanel, /<ConsequentialAction/);
  assert.match(lifecyclePanel, /tone="money"/);
  assert.match(staffPage, /OrderLifecyclePanel/);
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
