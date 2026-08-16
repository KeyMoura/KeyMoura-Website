import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * `/orders/new` is a server component since Custom Project Request 3.0 — it
 * loads the catalog so the "change something we already make" journey can offer
 * one — and the wizard itself moved to `components/orders`. The flow is read
 * from where it now lives; what this file asserts about it is unchanged.
 */
const page = readFileSync("src/components/orders/CustomRequestWizard.tsx", "utf8");
const customRoute = readFileSync("src/app/api/orders/custom/route.ts", "utf8");
const quoteRoute = readFileSync("src/app/api/orders/[id]/quote/route.ts", "utf8");
const checkout = readFileSync("src/app/api/orders/[id]/checkout/route.ts", "utf8");
const webhook = readFileSync("src/app/api/webhooks/stripe/route.ts", "utf8");
const migration = readFileSync("supabase/migrations/20260801010000_custom_request_quotes_payments.sql", "utf8");
const accountingMigration = readFileSync("supabase/migrations/20260801080000_atomic_payment_accounting.sql", "utf8");

test("custom request is a guided draftable review flow", () => {
  // The step names changed with 3.0 — "Specs & files" became a Details step and
  // a Files step, and "Delivery" became "Quantity & delivery" once budget and
  // timing joined it. They are declared in the domain module now, so the flow
  // is one list rather than a set of strings in the markup.
  const domain = readFileSync("src/lib/orders/customRequest.ts", "utf8");
  for (const label of ["Project", "Details", "Files", "Quantity & delivery", "Review"]) {
    assert.match(domain, new RegExp(label));
  }
  // Drafts are autosaved now rather than waiting for a button, and the request
  // still cannot be mistaken for a purchase.
  assert.match(page, /Draft saved/);
  assert.match(page, /Submit project request/);
  assert.match(page, /order_request_drafts/);
  // Several reference files, not one.
  assert.match(readFileSync("src/components/orders/RequestFiles.tsx", "utf8"), /multiple/);
});

test("custom uploads are customer-scoped and request input is bounded", () => {
  assert.match(customRoute, /startsWith\(`\$\{user\.id\}\/`\)/);
  assert.match(customRoute, /slice\(0, MAX_REQUEST_FILES\)/);
  // The 20-character floor moved into the shared validator both sides run.
  assert.match(readFileSync("src/lib/orders/customRequest.ts", "utf8"), /MIN_DESCRIPTION = 20/);
  assert.match(customRoute, /validateAll\(form\)/);
});

test("quote approval is customer-owned and revision-specific", () => {
  assert.match(quoteRoute, /eq\("customer_id", user\.id\)/);
  assert.match(quoteRoute, /eq\("quote_revision", order\.quote_revision\)/);
  assert.match(migration, /unique\(order_id, revision\)/);
});

test("stripe supports deposit then remaining balance without overpayment", () => {
  assert.match(checkout, /amountDue/);
  assert.match(checkout, /payment_kind/);
  assert.match(webhook, /record_stripe_order_payment/);
  assert.match(accountingMigration, /new_net > selected_order\.agreed_price_cents/);
  assert.match(accountingMigration, /when fully_paid then 'paid' else 'partial'/);
  assert.match(accountingMigration, /insert into public\.order_status_history/);
  assert.match(accountingMigration, /Deposit received; production started/);
});

test("drafts and quotes have explicit RLS boundaries", () => {
  assert.match(migration, /enable row level security/g);
  assert.match(migration, /auth\.uid\(\)\) = customer_id/);
  assert.match(migration, /staff manage order quotes/);
});
