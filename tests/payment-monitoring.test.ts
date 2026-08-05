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
const lifecycleServer = readFileSync("src/lib/commerce/orderLifecycleServer.ts", "utf8");
const lifecycleAccounting = readFileSync(
  "supabase/migrations/20260805010000_order_lifecycle_cancellations_refunds_returns.sql",
  "utf8"
);

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

  // The route no longer calls `record_stripe_order_refund`. That RPC recorded a
  // refund as *complete* the moment Stripe's API returned, which was wrong
  // twice over: a Stripe refund can come back `pending` and settle later, and
  // it can fail after acceptance. `20260805010000` replaced it with a two-phase
  // pair, and this assertion is the stronger version of the same requirement —
  // the claim is made under a row lock before Stripe is called, and only
  // Stripe's own answer moves the accounting.
  assert.match(refundRoute, /issueOrderRefund/);
  assert.match(lifecycleServer, /rpc\("begin_order_refund"/);
  assert.match(lifecycleServer, /rpc\("settle_order_refund"/);
  assert.match(lifecycleAccounting, /select \* into selected_order from public\.orders where id = p_order_id for update/);
  assert.match(lifecycleAccounting, /if refund_row\.status <> 'pending' then/);

  // And the old immediate-completion path is genuinely gone from the route,
  // not merely unused alongside the new one.
  assert.equal(/record_stripe_order_refund/.test(refundRoute), false);
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

  // Refund exceptions still reach Sentry; they now go through
  // `logLifecycleFailure`, which adds SQLSTATE and hint and is shared by every
  // lifecycle path. Asserting the wrapper is stricter than asserting the raw
  // call, because it also pins what must *not* be logged.
  assert.match(lifecycleServer, /captureCommerceException\(error, \{ operation, \.\.\.context \}\)/);
  assert.match(lifecycleServer, /logLifecycleFailure\("stripe_refund_create"/);
  assert.equal(
    /details/.test(lifecycleServer.slice(lifecycleServer.indexOf("export function logLifecycleFailure"), lifecycleServer.indexOf("// ---", 2000))),
    false,
    "Postgres `details` echoes row values back and must not be logged"
  );
});
