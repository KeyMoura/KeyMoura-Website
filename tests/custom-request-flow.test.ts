import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("src/app/orders/new/page.tsx", "utf8");
const customRoute = readFileSync("src/app/api/orders/custom/route.ts", "utf8");
const quoteRoute = readFileSync("src/app/api/orders/[id]/quote/route.ts", "utf8");
const checkout = readFileSync("src/app/api/orders/[id]/checkout/route.ts", "utf8");
const webhook = readFileSync("src/app/api/webhooks/stripe/route.ts", "utf8");
const migration = readFileSync("supabase/migrations/20260801010000_custom_request_quotes_payments.sql", "utf8");

test("custom request is a guided draftable review flow", () => {
  for (const label of ["Project", "Specs & files", "Delivery", "Review", "Save draft", "Submit request — no charge"]) assert.match(page, new RegExp(label));
  assert.match(page, /order_request_drafts/);
  assert.match(page, /multiple/);
});

test("custom uploads are customer-scoped and request input is bounded", () => {
  assert.match(customRoute, /startsWith\(`\$\{user\.id\}\//);
  assert.match(customRoute, /slice\(0, 10\)/);
  assert.match(customRoute, /description\.length < 20/);
});

test("quote approval is customer-owned and revision-specific", () => {
  assert.match(quoteRoute, /eq\("customer_id", user\.id\)/);
  assert.match(quoteRoute, /eq\("quote_revision", order\.quote_revision\)/);
  assert.match(migration, /unique\(order_id, revision\)/);
});

test("stripe supports deposit then remaining balance without overpayment", () => {
  assert.match(checkout, /amountDue/);
  assert.match(checkout, /payment_kind/);
  assert.match(webhook, /newNetCollected > order\.agreed_price_cents/);
  assert.match(webhook, /payment_status: fullyPaid \? "paid" : "partial"/);
  assert.match(webhook, /from\("order_status_history"\)\.insert/);
  assert.match(webhook, /Deposit received; production started/);
});

test("drafts and quotes have explicit RLS boundaries", () => {
  assert.match(migration, /enable row level security/g);
  assert.match(migration, /auth\.uid\(\)\) = customer_id/);
  assert.match(migration, /staff manage order quotes/);
});
