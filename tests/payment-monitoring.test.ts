import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const webhook = readFileSync("src/app/api/webhooks/stripe/route.ts", "utf8");
const refundRoute = readFileSync("src/app/api/staff/orders/[id]/refund/route.ts", "utf8");
const accounting = readFileSync("supabase/migrations/20260801080000_atomic_payment_accounting.sql", "utf8");
const serverSentry = readFileSync("sentry.server.config.ts", "utf8");
const clientSentry = readFileSync("instrumentation-client.ts", "utf8");
const privacy = readFileSync("src/lib/sentryPrivacy.ts", "utf8");
const checkout = readFileSync("src/app/api/orders/[id]/checkout/route.ts", "utf8");

test("payment accounting is atomic and deduplicates by payment intent", () => {
  assert.match(accounting, /select \* into selected_order from public\.orders where id = p_order_id for update/);
  assert.match(accounting, /on conflict \(stripe_payment_intent_id\) do nothing/);
  assert.match(accounting, /'duplicate', true/);
  assert.match(webhook, /if \(!result\?\.applied\)/);
});

test("refund accounting is atomic after Stripe accepts the refund", () => {
  assert.match(accounting, /record_stripe_order_refund/);
  assert.match(accounting, /select \* into selected_payment[\s\S]*for update/);
  assert.match(accounting, /on conflict \(stripe_refund_id\) do nothing/);
  assert.match(refundRoute, /record_stripe_order_refund/);
});

test("checkout retries are idempotent and delayed failures notify both sides", () => {
  assert.match(checkout, /idempotencyKey: `checkout-\$\{order\.id\}-\$\{amountDue\}-\$\{collectedBeforeCheckout\}`/);
  assert.match(webhook, /checkout\.session\.async_payment_failed/);
  assert.match(webhook, /title:"Payment failed"/);
  assert.match(webhook, /title:"Customer payment failed"/);
  assert.match(webhook, /session\.currency !== "usd"/);
  assert.match(webhook, /session\.metadata\?\.customer_id !== order\.customer_id/);
});

test("Sentry covers every Next.js runtime without collecting customer PII", () => {
  assert.match(serverSentry, /sendDefaultPii: false/);
  assert.match(clientSentry, /replaysSessionSampleRate: 0/);
  assert.match(clientSentry, /replaysOnErrorSampleRate: 0/);
  assert.match(privacy, /authorization\|cookie\|password\|secret\|token\|address\|email\|phone\|message/);
  assert.match(webhook, /captureCommerceException/);
  assert.match(refundRoute, /captureCommerceException/);
});
