import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_COMMERCE_SETTINGS,
  type CommerceSettings,
} from "../src/lib/commerce/commerceSettings.ts";
import {
  REQUIRED_STRIPE_EVENTS,
  buildIntegrationChecks,
  summarizeIntegrations,
  type IntegrationEvidence,
} from "../src/lib/ops/integrationHealth.ts";
import {
  applyAcknowledgements,
  buildReadinessChecks,
  summarizeReadiness,
  type ReadinessEvidence,
  type ReadinessProduct,
} from "../src/lib/ops/launchReadiness.ts";
import {
  DELIVERY_PAGE_SIZE,
  DELIVERY_STATUSES,
  DELIVERY_STATUS_HELP,
  FILTERABLE_DELIVERY_STATUSES,
  PROVIDER_CONFIRMED_STATUSES,
  parseDeliveryFilters,
  deliveryFiltersToQuery,
  resendEventKey,
  toDeliveryView,
  type DeliveryRow,
} from "../src/lib/comms/deliveryCenter.ts";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const NOW = new Date("2026-08-06T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Integration health
// ---------------------------------------------------------------------------

function evidence(overrides: Partial<IntegrationEvidence> = {}): IntegrationEvidence {
  return {
    env: {
      supabaseUrl: true,
      supabaseAnonKey: true,
      supabaseServiceRoleKey: true,
      stripeSecretKey: true,
      stripeWebhookSecret: true,
      stripeLiveMode: true,
      resendApiKey: true,
      sentryDsn: true,
      turnstileSiteKey: true,
      turnstileSecretKey: true,
      googleOAuth: true,
      facebookOAuth: true,
      siteUrl: true,
      ...(overrides.env ?? {}),
    },
    mounted: { vercelAnalytics: true, speedInsights: true, sentry: true, ...(overrides.mounted ?? {}) },
    database: {
      reachable: true,
      migrationRowCount: 43,
      repoMigrationCount: 43,
      migrationDrift: [],
      ...(overrides.database ?? {}),
    },
    stripe: {
      receivedEventTypes: [...REQUIRED_STRIPE_EVENTS],
      lastEventAt: "2026-08-06T10:00:00.000Z",
      unprocessedCount: 0,
      ...(overrides.stripe ?? {}),
    },
    email: {
      configuredSender: true,
      configuredReplyTo: true,
      staffRecipientConfigured: true,
      templateCount: 43,
      expectedTemplateCount: 43,
      sentLast30Days: 12,
      failedLast30Days: 0,
      lastSentAt: "2026-08-06T09:00:00.000Z",
      ...(overrides.email ?? {}),
    },
    deployment: { environment: "production", commitSha: "abcdef1234", ...(overrides.deployment ?? {}) },
    storage: { buckets: ["product-assets"], productionJobFileCount: 0, ...(overrides.storage ?? {}) },
    inventory: { activeReservations: 1, expiredUnsweptReservations: 0, ...(overrides.inventory ?? {}) },
    observations: overrides.observations ?? {},
  };
}

const check = (checks: ReturnType<typeof buildIntegrationChecks>, key: string) => {
  const found = checks.find((candidate) => candidate.key === key);
  assert.ok(found, `no check named ${key}`);
  return found;
};

test("a present environment variable is never enough to call something verified", () => {
  /*
   * The point of the whole page. Pass 5a had correct RLS, correct permissions
   * and correct queries, and every read failed because the grants were missing.
   * Pass 7 deployed a correct refund handler that was never called because the
   * endpoint was not subscribed. Configuration proves configuration.
   */
  const checks = buildIntegrationChecks(evidence({ stripe: { receivedEventTypes: [], lastEventAt: null, unprocessedCount: 0 } }), NOW);
  const stripe = check(checks, "stripe");
  assert.equal(stripe.confidence, "assumed");
  assert.ok(stripe.verificationNote, "an assumed check must say what would verify it");
});

test("a signature-verified webhook is what makes Stripe verified", () => {
  const checks = buildIntegrationChecks(evidence(), NOW);
  assert.equal(check(checks, "stripe").confidence, "verified");
});

test("a missing webhook signing secret is incomplete, not healthy", () => {
  const checks = buildIntegrationChecks(evidence({ env: { ...evidence().env, stripeWebhookSecret: false } }), NOW);
  const stripe = check(checks, "stripe");
  assert.equal(stripe.status, "incomplete");
  assert.match(stripe.summary, /never settled here/);
});

test("an unseen webhook event type degrades and says why it might be a false alarm", () => {
  const checks = buildIntegrationChecks(
    evidence({ stripe: { receivedEventTypes: ["checkout.session.completed"], lastEventAt: "2026-08-06T10:00:00.000Z", unprocessedCount: 0 } }),
    NOW
  );
  const sub = check(checks, "stripe_webhook_events");
  assert.equal(sub.status, "degraded");
  // A shop with no refunds has never had a refund event; that is not proof of
  // an unsubscribed endpoint.
  assert.match(sub.verificationNote ?? "", /not proof it is unsubscribed/);
});

test("any one refund event alias satisfies the refund subscription", () => {
  const checks = buildIntegrationChecks(
    evidence({
      stripe: {
        receivedEventTypes: [
          "checkout.session.completed",
          "checkout.session.expired",
          "checkout.session.async_payment_succeeded",
          "checkout.session.async_payment_failed",
          // The older API-version alias only.
          "charge.refund.updated",
        ],
        lastEventAt: "2026-08-06T10:00:00.000Z",
        unprocessedCount: 0,
      },
    }),
    NOW
  );
  assert.equal(check(checks, "stripe_webhook_events").status, "healthy");
});

test("an unprocessed webhook is reported, and several is a failure", () => {
  const one = buildIntegrationChecks(evidence({ stripe: { ...evidence().stripe, unprocessedCount: 1 } }), NOW);
  assert.equal(check(one, "stripe_webhook_processing").status, "degraded");
  const many = buildIntegrationChecks(evidence({ stripe: { ...evidence().stripe, unprocessedCount: 6 } }), NOW);
  assert.equal(check(many, "stripe_webhook_processing").status, "failing");
});

test("Stripe Tax is always reported as deliberately not enabled", () => {
  const checks = buildIntegrationChecks(evidence(), NOW);
  const tax = check(checks, "stripe_tax");
  assert.equal(tax.status, "not_configured");
  assert.match(tax.summary, /Deliberately not integrated/);
  assert.match(tax.summary, /always zero/);
  // Never presented as complete, whatever else is green.
  assert.notEqual(tax.status, "healthy");
});

test("Vercel Analytics can never be verified from inside the application", () => {
  const checks = buildIntegrationChecks(evidence(), NOW);
  const analytics = check(checks, "vercel_analytics");
  // The served script bails on `navigator.webdriver`, so no automated session
  // can ever observe a recorded pageview. Claiming otherwise would be a lie the
  // page could never detect.
  assert.equal(analytics.confidence, "assumed");
  assert.match(analytics.verificationNote ?? "", /refuses to run under automation/);
});

test("no resend key means every email is silently suppressed, and that is failing-level", () => {
  const checks = buildIntegrationChecks(evidence({ env: { ...evidence().env, resendApiKey: false } }), NOW);
  const resend = check(checks, "resend");
  assert.equal(resend.status, "not_configured");
  assert.match(resend.summary, /recorded as suppressed/);
});

test("ledger drift is reported as bookkeeping rather than as a broken schema", () => {
  const checks = buildIntegrationChecks(
    evidence({ database: { reachable: true, migrationRowCount: 41, repoMigrationCount: 43, migrationDrift: ["x", "y"] } }),
    NOW
  );
  const ledger = check(checks, "migration_ledger");
  assert.equal(ledger.status, "degraded");
  assert.match(ledger.verificationNote ?? "", /does not by itself mean the schema is wrong/);
});

test("the health route makes no write and no outbound call", () => {
  const source = read("src/app/api/staff/integrations/route.ts");
  for (const forbidden of [".insert(", ".update(", ".delete(", ".rpc("]) {
    assert.ok(!source.includes(forbidden), `the health route must not ${forbidden}`);
  }
  const evidenceSource = read("src/lib/ops/evidence.ts");
  assert.ok(!/fetch\(/.test(evidenceSource), "gathering evidence must not call an external service");
  assert.ok(!/stripeClient|resend\.emails/.test(evidenceSource), "no provider call, no charge, no email");
});

test("no secret value can leave the evidence gatherer", () => {
  const source = read("src/lib/ops/evidence.ts");
  // Booleans only. `present()` is what makes a forgotten field a `true`, not a key.
  assert.match(source, /const present = \(value: string \| undefined \| null\) => Boolean/);
  // The one derived string is a key *prefix*, which is the mode and not the key.
  assert.match(source, /startsWith\("sk_live_"\)/);
  assert.ok(
    !/process\.env\.(STRIPE_SECRET_KEY|RESEND_API_KEY|SUPABASE_SERVICE_ROLE_KEY)\s*(\?\?|\|\|)?\s*[,}]/.test(source),
    "a raw secret must never be placed in the evidence object"
  );
});

test("the summary counts what it says it counts", () => {
  const checks = buildIntegrationChecks(evidence(), NOW);
  const summary = summarizeIntegrations(checks);
  assert.equal(summary.total, checks.length);
  assert.equal(summary.verified, checks.filter((c) => c.confidence === "verified").length);
});

// ---------------------------------------------------------------------------
// Launch readiness
// ---------------------------------------------------------------------------

function product(overrides: Partial<ReadinessProduct> = {}): ReadinessProduct {
  return {
    id: "p1",
    name: "Shift knob",
    slug: "shift-knob",
    is_published: true,
    purchase_mode: "direct",
    base_price_cents: 12000,
    image_url: "https://example.test/a.png",
    mediaCount: 1,
    category_id: "c1",
    requires_shipping: true,
    pickup_eligible: true,
    fulfillment_required: true,
    inventory_policy: "none",
    inventory_quantity: null,
    made_to_order: false,
    lead_time_text: null,
    short_description: "A knob.",
    ...overrides,
  };
}

function settings(overrides: Partial<CommerceSettings> = {}): CommerceSettings {
  const base = structuredClone(DEFAULT_COMMERCE_SETTINGS);
  return {
    ...base,
    ...overrides,
    shipping: { ...base.shipping, ...(overrides.shipping ?? {}) },
    pickup: { ...base.pickup, ...(overrides.pickup ?? {}) },
    inventory: { ...base.inventory, ...(overrides.inventory ?? {}) },
    email: { ...base.email, ...(overrides.email ?? {}) },
    business: { ...base.business, ...(overrides.business ?? {}) },
    returnAddress: { ...base.returnAddress, ...(overrides.returnAddress ?? {}) },
  };
}

function readiness(overrides: Partial<ReadinessEvidence> = {}): ReadinessEvidence {
  return {
    settings: overrides.settings ?? settings({ pickup: { ...DEFAULT_COMMERCE_SETTINGS.pickup, enabled: true, locationName: "Shop", address: { name: "", line1: "1 Main St", line2: "", city: "Town", region: "NY", postalCode: "12345", country: "US", phone: "" } } }),
    products: overrides.products ?? [product()],
    integrations: overrides.integrations ?? buildIntegrationChecks(evidence(), NOW),
    email: {
      senderConfigured: true,
      replyToConfigured: true,
      staffRecipientConfigured: true,
      missingTemplates: [],
      recentFailures: 0,
      ...(overrides.email ?? {}),
    },
    discrepancies: overrides.discrepancies ?? [],
    policyPages: overrides.policyPages ?? [
      { slug: "terms", present: true },
      { slug: "privacy", present: true },
      { slug: "refunds", present: true },
      { slug: "shipping", present: true },
    ],
    reliability: {
      migrationLedgerAligned: true,
      unprocessedWebhooks: 0,
      inventoryLedgerMismatches: 0,
      backupAcknowledged: true,
      ...(overrides.reliability ?? {}),
    },
  };
}

const find = (checks: ReturnType<typeof buildReadinessChecks>, id: string) => {
  const found = checks.find((candidate) => candidate.id === id);
  assert.ok(found, `no readiness check named ${id}`);
  return found;
};

test("every readiness check states why it matters and where to fix it", () => {
  for (const candidate of buildReadinessChecks(readiness())) {
    assert.ok(candidate.because.length > 30, `${candidate.id} does not say why it matters`);
    assert.ok(candidate.fingerprint.length > 0, `${candidate.id} has no fingerprint`);
    if (candidate.state !== "passed" && candidate.state !== "info") {
      assert.ok(candidate.fixHref, `${candidate.id} is actionable but links nowhere`);
    }
  }
});

test("no delivery method at all is a blocker", () => {
  const checks = buildReadinessChecks(readiness({ settings: settings() }));
  assert.equal(find(checks, "commerce.fulfillment_method").state, "blocker");
  assert.equal(summarizeReadiness(checks).readyToLaunch, false);
});

test("valid pickup passes and valid shipping passes", () => {
  const pickupOnly = buildReadinessChecks(readiness());
  assert.equal(find(pickupOnly, "commerce.fulfillment_method").state, "passed");
  assert.equal(find(pickupOnly, "commerce.pickup_location").state, "passed");
  // Shipping is off, so its checks are informational rather than failures.
  assert.equal(find(pickupOnly, "commerce.shipping_methods").state, "info");

  const shipping = buildReadinessChecks(
    readiness({
      settings: settings({
        shipping: {
          ...DEFAULT_COMMERCE_SETTINGS.shipping,
          enabled: true,
          methods: [{ id: "std", name: "Standard", description: "", enabled: true } as never],
          destinationCountries: ["US"],
          originAddress: { name: "", line1: "1 Works Rd", line2: "", city: "Town", region: "NY", postalCode: "12345", country: "US", phone: "" },
        },
      }),
    })
  );
  assert.equal(find(shipping, "commerce.shipping_methods").state, "passed");
  assert.equal(find(shipping, "commerce.origin_address").state, "passed");
});

test("shipping enabled with no method is a blocker", () => {
  const checks = buildReadinessChecks(
    readiness({ settings: settings({ shipping: { ...DEFAULT_COMMERCE_SETTINGS.shipping, enabled: true, methods: [] } }) })
  );
  assert.equal(find(checks, "commerce.shipping_methods").state, "blocker");
});

test("pickup enabled with no address is a blocker", () => {
  const checks = buildReadinessChecks(
    readiness({ settings: settings({ pickup: { ...DEFAULT_COMMERCE_SETTINGS.pickup, enabled: true, locationName: "Shop" } }) })
  );
  assert.equal(find(checks, "commerce.pickup_location").state, "blocker");
});

test("a missing return address warns rather than blocks", () => {
  const checks = buildReadinessChecks(readiness());
  const check = find(checks, "commerce.return_address");
  assert.equal(check.state, "warning");
  assert.match(check.detail, /staff must type the address/);
});

test("a missing sender is a blocker and a missing reply-to is a warning", () => {
  const noSender = buildReadinessChecks(readiness({ email: { senderConfigured: false, replyToConfigured: false, staffRecipientConfigured: true, missingTemplates: [], recentFailures: 0 } }));
  assert.equal(find(noSender, "communications.sender").state, "blocker");

  const noReplyTo = buildReadinessChecks(readiness({ email: { senderConfigured: true, replyToConfigured: false, staffRecipientConfigured: true, missingTemplates: [], recentFailures: 0 } }));
  assert.equal(find(noReplyTo, "communications.sender").state, "warning");
});

test("Stripe Tax appears as information and is never a passed tick", () => {
  const check = find(buildReadinessChecks(readiness()), "payments.stripe_tax");
  assert.equal(check.state, "info");
  assert.notEqual(check.state, "passed");
  assert.match(check.detail, /No tax is calculated, collected or reported/);
  assert.match(check.because, /business obligation/);
});

test("an unprocessed webhook is a blocker on the readiness page", () => {
  const checks = buildReadinessChecks(readiness({ reliability: { migrationLedgerAligned: true, unprocessedWebhooks: 2, inventoryLedgerMismatches: 0, backupAcknowledged: true } }));
  assert.equal(find(checks, "payments.webhook_processing").state, "blocker");
  assert.equal(summarizeReadiness(checks).readyToLaunch, false);
});

test("a product that can neither ship nor be collected is a blocker", () => {
  const checks = buildReadinessChecks(
    readiness({ products: [product({ requires_shipping: false, pickup_eligible: false })] })
  );
  const check = find(checks, "storefront.fulfillment_eligibility");
  assert.equal(check.state, "blocker");
  assert.match(check.because, /this order cannot be delivered/);
});

test("a directly purchasable product with no price is a blocker", () => {
  const checks = buildReadinessChecks(readiness({ products: [product({ base_price_cents: 0 })] }));
  assert.equal(find(checks, "storefront.direct_price").state, "blocker");
});

test("a made-to-order product with no lead time warns", () => {
  const checks = buildReadinessChecks(readiness({ products: [product({ made_to_order: true })] }));
  assert.equal(find(checks, "storefront.lead_time").state, "warning");
});

test("a missing policy page warns and names it", () => {
  const checks = buildReadinessChecks(
    readiness({ policyPages: [{ slug: "terms", present: true }, { slug: "refunds", present: false }] })
  );
  const check = find(checks, "reliability.policy_pages");
  assert.equal(check.state, "warning");
  assert.match(check.detail, /refunds/);
});

// ---------------------------------------------------------------------------
// Historical discrepancies
// ---------------------------------------------------------------------------

test("an unreviewed historical discrepancy is a warning naming the order", () => {
  const checks = buildReadinessChecks(
    readiness({
      discrepancies: [
        { orderId: "o1", orderNumber: "KM-0001", kind: "payment_total_mismatch", recordedCents: 2500, evidenceCents: 0, reviewed: false },
        { orderId: "o2", orderNumber: "KM-0002", kind: "payment_total_mismatch", recordedCents: 100, evidenceCents: 0, reviewed: false },
      ],
    })
  );
  const check = find(checks, "reliability.payment_discrepancies");
  assert.equal(check.state, "warning");
  assert.match(check.detail, /KM-0001/);
  assert.match(check.detail, /KM-0002/);
  // Never a blocker, and never repaired.
  assert.notEqual(check.state, "blocker");
  assert.match(check.because, /Nothing automated touches them/);
});

test("a reviewed discrepancy becomes informational rather than disappearing", () => {
  const checks = buildReadinessChecks(
    readiness({
      discrepancies: [
        { orderId: "o1", orderNumber: "KM-0001", kind: "payment_total_mismatch", recordedCents: 2500, evidenceCents: 0, reviewed: true },
      ],
    })
  );
  const check = find(checks, "reliability.payment_discrepancies");
  assert.equal(check.state, "info");
  assert.match(check.detail, /KM-0001/, "a reviewed discrepancy stays visible");
});

test("the discrepancy route never writes to orders or payments", () => {
  const source = read("src/app/api/staff/launch-readiness/discrepancies/route.ts");
  // The one insert is into the review table; nothing else is written.
  const writes = [...source.matchAll(/\.from\("([a-z_]+)"\)[\s\S]{0,120}?\.(insert|update|delete)\(/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(writes)],
    ["payment_discrepancy_reviews"],
    "reviewing must never write to orders, order_payments or order_refunds"
  );
  assert.ok(!/stripeClient|stripe\./.test(source), "reviewing must never contact Stripe");
  assert.match(source, /changed_financial_data: false/, "the audit event should state that no money moved");
});

// ---------------------------------------------------------------------------
// Acknowledgement
// ---------------------------------------------------------------------------

test("a blocker cannot be acknowledged away, whatever was recorded", () => {
  const checks = buildReadinessChecks(readiness({ settings: settings() }));
  const blocker = find(checks, "commerce.fulfillment_method");
  const applied = applyAcknowledgements(checks, [{ check_id: blocker.id, fingerprint: blocker.fingerprint }]);
  const after = applied.find((candidate) => candidate.id === blocker.id);
  assert.equal(after?.acknowledged, false, "the one part of the page that must be believed cannot be silenced");
  assert.equal(summarizeReadiness(applied).readyToLaunch, false);
});

test("an acknowledged warning is recorded and drops out of the live warning count", () => {
  const checks = buildReadinessChecks(readiness());
  const warning = find(checks, "commerce.return_address");
  const applied = applyAcknowledgements(checks, [{ check_id: warning.id, fingerprint: warning.fingerprint }]);
  const after = applied.find((candidate) => candidate.id === warning.id);
  assert.equal(after?.acknowledged, true);
  assert.equal(after?.acknowledgementStale, false);
  assert.ok(summarizeReadiness(applied).warnings < summarizeReadiness(checks).warnings);
});

test("an acknowledgement goes stale when the situation moves", () => {
  const checks = buildReadinessChecks(readiness());
  const warning = find(checks, "commerce.return_address");
  const applied = applyAcknowledgements(checks, [{ check_id: warning.id, fingerprint: "what it looked like before" }]);
  const after = applied.find((candidate) => candidate.id === warning.id);
  assert.equal(after?.acknowledgementStale, true, "accepting three missing images must not keep accepting eleven");
});

test("the acknowledgement route recomputes severity rather than trusting the client", () => {
  const source = read("src/app/api/staff/launch-readiness/route.ts");
  assert.match(source, /buildReadinessChecks\(evidence\)\.find/);
  assert.match(source, /if \(check\.state === "blocker"\)/);
  assert.match(source, /A blocker cannot be acknowledged/);
  // The fingerprint stored is the server's, never the client's.
  assert.match(source, /fingerprint: check\.fingerprint/);
});

test("the readiness payload refuses to claim compliance", () => {
  const source = read("src/app/api/staff/launch-readiness/route.ts");
  assert.match(source, /not a legal, tax, accessibility or security compliance assessment/);
  assert.match(read("src/app/staff/launch-readiness/page.tsx"), /compliance assessment/);
});

// ---------------------------------------------------------------------------
// Delivery centre and resend
// ---------------------------------------------------------------------------

function delivery(overrides: Partial<DeliveryRow> = {}): DeliveryRow {
  return {
    id: "d1",
    order_id: "o1",
    template_key: "order_shipped",
    recipient: "customer@example.com",
    subject: "KM-0001 has shipped",
    status: "sent",
    provider_id: "resend-123",
    error_message: null,
    failure_category: null,
    event_key: "fulfillment-o1-shipped",
    audience: "customer",
    attempt_count: 1,
    delivered_at: null,
    resend_of_id: null,
    created_at: "2026-08-06T09:00:00.000Z",
    updated_at: "2026-08-06T09:00:00.000Z",
    ...overrides,
  };
}

test("a delivery view never carries the full address, the provider id or the event key", () => {
  const view = toDeliveryView(delivery());
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes("customer@example.com"), "the full address must not reach the client");
  assert.ok(!serialized.includes("resend-123"), "the provider id is an internal handle");
  assert.ok(!serialized.includes("fulfillment-o1-shipped"), "an idempotency key on a screen is a key somebody can reuse");
});

test("a raw provider error never reaches the client", () => {
  const view = toDeliveryView(
    delivery({ status: "failed", failure_category: "invalid_recipient", error_message: "rejected address customer@example.com" })
  );
  assert.equal(view.failureSummary, "The address was rejected");
  assert.ok(!JSON.stringify(view).includes("rejected address"));
});

test("a staff alert is not resendable and says why", () => {
  const view = toDeliveryView(delivery({ template_key: "staff_new_request", audience: "staff" }));
  assert.equal(view.canResend, false);
  assert.match(view.resendBlockedReason ?? "", /Staff alerts are not re-sendable/);
});

test("an in-flight send is not resendable", () => {
  const view = toDeliveryView(delivery({ status: "queued" }));
  assert.equal(view.canResend, false);
  assert.match(view.resendBlockedReason ?? "", /still in flight/);
});

test("a delivery with no recipient is not resendable", () => {
  const view = toDeliveryView(delivery({ recipient: "not configured" }));
  assert.equal(view.canResend, false);
});

test("a failed customer message is resendable", () => {
  assert.equal(toDeliveryView(delivery({ status: "failed", failure_category: "provider_unavailable" })).canResend, true);
});

test("two resends decided at the same moment compute the same key", () => {
  assert.equal(resendEventKey("fulfillment-o1-shipped", 1), resendEventKey("fulfillment-o1-shipped", 1));
  // A deliberate later resend is a genuinely new event.
  assert.notEqual(resendEventKey("fulfillment-o1-shipped", 1), resendEventKey("fulfillment-o1-shipped", 2));
  // Derived from the original, never minted from a clock.
  assert.match(resendEventKey("fulfillment-o1-shipped", 1), /^resend:fulfillment-o1-shipped:1$/);
});

test("the resend route accepts no recipient, subject or body", () => {
  const source = read("src/app/api/staff/emails/deliveries/[id]/resend/route.ts");
  const body = source.slice(source.indexOf("type ResendBody"), source.indexOf("const SELECT"));
  for (const field of ["to", "recipient", "subject", "html", "body?", "text"]) {
    assert.ok(!new RegExp(`\\b${field.replace("?", "")}\\??:`).test(body), `the resend body must not accept ${field}`);
  }
  // The address comes from the stored row and nowhere else.
  assert.match(source, /to: row\.recipient/);
});

test("re-sending needs its own permission, not merely read access", () => {
  const source = read("src/app/api/staff/emails/deliveries/[id]/resend/route.ts");
  const post = source.slice(source.indexOf("export async function POST"));
  assert.match(post, /requirePermission\(req, "emails\.resend"\)/);
  // Reading the preview is allowed with view access; sending is not.
  const get = source.slice(source.indexOf("export async function GET"), source.indexOf("export async function POST"));
  assert.match(get, /requireAnyPermission\(req, \["emails\.view", "emails\.resend"\]\)/);
});

test("the original delivery is never modified by a resend", () => {
  const source = read("src/app/api/staff/emails/deliveries/[id]/resend/route.ts");
  assert.ok(
    !/from\("email_deliveries"\)[\s\S]{0,120}?\.update\(/.test(source),
    "a resend writes a new row; it must not rewrite the record of what happened first"
  );
  assert.match(source, /resendOfId: row\.id/);
});

test("the resend is audited before it is attempted", () => {
  const source = read("src/app/api/staff/emails/deliveries/[id]/resend/route.ts");
  const auditAt = source.indexOf('eventType: "staff.email.resend"');
  const sendAt = source.indexOf("await sendCommerceEmail(");
  assert.ok(auditAt > 0 && sendAt > auditAt, "an audit trail holding only successes cannot answer who tried");
  // And the audit event carries no recipient, subject or body — the audit log
  // is read more widely and kept longer than the delivery centre.
  const metadata = /metadata: \{([^}]*)\}/.exec(source.slice(auditAt))?.[1] ?? "";
  assert.ok(metadata.length > 0, "the resend audit event should carry some metadata");
  for (const banned of ["recipient", "subject", "body", "email"]) {
    assert.ok(!metadata.includes(banned), `the resend audit metadata must not carry ${banned}`);
  }
});

test("the delivery list never filters on the recipient column", () => {
  const source = read("src/app/api/staff/emails/deliveries/route.ts");
  assert.ok(
    !/\.ilike\("recipient"|\.eq\("recipient"/.test(source),
    "searching by address would make this a way to confirm somebody is a customer"
  );
  assert.match(source, /ilike\("order_number"/);
});

test("a failed delivery query is a 502, never an empty list", () => {
  const source = read("src/app/api/staff/emails/deliveries/route.ts");
  assert.match(source, /status: 502/);
  assert.ok(!/deliveries: \[\]/.test(source), "an empty array and a refusal must not render identically");
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

test("filters are total and drop unknown values", () => {
  const filters = parseDeliveryFilters({ status: "sent,not-a-status", audience: "martian", page: "-4" }, ["order_shipped"]);
  assert.deepEqual(filters.status, ["sent"]);
  assert.deepEqual(filters.audience, []);
  assert.equal(filters.page, 1);
});

test("an impossible date is refused rather than silently shifted", () => {
  // `new Date("2026-02-31")` rolls forward to March in JavaScript.
  assert.equal(parseDeliveryFilters({ from: "2026-02-31" }).from, null);
  assert.equal(parseDeliveryFilters({ from: "2026-02-28" }).from, "2026-02-28");
});

test("an inverted range is swapped, because that is a typo", () => {
  const filters = parseDeliveryFilters({ from: "2026-08-06", to: "2026-08-01" });
  assert.equal(filters.from, "2026-08-01");
  assert.equal(filters.to, "2026-08-06");
});

test("filters round-trip canonically", () => {
  const filters = parseDeliveryFilters({ status: "failed,sent", template: "order_shipped" }, ["order_shipped"]);
  const query = deliveryFiltersToQuery(filters);
  assert.deepEqual(parseDeliveryFilters(new URLSearchParams(query), ["order_shipped"]), filters);
});

test("the page size is bounded and stated", () => {
  assert.ok(DELIVERY_PAGE_SIZE > 0 && DELIVERY_PAGE_SIZE <= 50);
});

// ---------------------------------------------------------------------------
// The delivery status lifecycle
//
// A live dry-run probe against production caught this before it shipped: the
// original CHECK admitted only `sent`, `failed` and `skipped`, and the new
// claim-before-send flow writes `queued` *first*. Every transactional email
// would have died with 23514 at the claim, before the provider was reached.
// These assertions are what stop the constraint and the code drifting again.
// ---------------------------------------------------------------------------

const MIGRATION = read("supabase/migrations/20260806030000_communications_center.sql");

test("REGRESSION the status constraint admits every value the code writes", () => {
  const statusCheck = /check \(status in \(([^)]*)\)\)/.exec(MIGRATION)?.[1] ?? "";
  assert.ok(statusCheck.length > 0, "the migration must widen the status constraint");
  for (const status of DELIVERY_STATUSES) {
    assert.ok(
      statusCheck.includes(`'${status}'`),
      `the constraint does not admit '${status}', which the application uses`
    );
  }
});

test("REGRESSION 'queued' is admitted, because the claim writes it before sending", () => {
  assert.ok(DELIVERY_STATUSES.includes("queued"));
  assert.match(MIGRATION, /'queued'/);
  // And the sender really does write it first.
  const sender = read("src/lib/commerceEmail.ts");
  assert.match(sender, /status: "queued"/);
});

test("REGRESSION every previously legal value stays legal", () => {
  // Production holds 25 `sent` and 1 `skipped`. Narrowing would make a stored
  // row illegal and the ALTER would fail on a live table.
  const statusCheck = /check \(status in \(([^)]*)\)\)/.exec(MIGRATION)?.[1] ?? "";
  for (const previous of ["sent", "failed", "skipped"]) {
    assert.ok(statusCheck.includes(`'${previous}'`), `${previous} was legal before and must stay legal`);
  }
});

test("REGRESSION the constraint is widened by add-then-drop, not drop-then-add", () => {
  /*
   * Ordering is the whole safety property on a live table. Adding the wider
   * constraint first validates every stored row while the narrower one is still
   * in force; if a row could not satisfy it, the ADD fails and nothing has been
   * dropped. Drop-then-add leaves a window with no constraint at all.
   */
  const addAt = MIGRATION.indexOf("add constraint email_deliveries_status_check_v2");
  const dropAt = MIGRATION.indexOf("drop constraint if exists email_deliveries_status_check");
  const renameAt = MIGRATION.indexOf("rename constraint email_deliveries_status_check_v2");
  assert.ok(addAt > 0 && dropAt > addAt, "the wider constraint must be added before the old one is dropped");
  assert.ok(renameAt > dropAt, "the new constraint should take the canonical name afterwards");
});

test("REGRESSION widening the constraint is idempotent", () => {
  // Re-running the migration must not try to add a constraint that is already
  // there, which would abort the whole transaction.
  assert.match(MIGRATION, /pg_get_constraintdef\(oid\) like '%queued%'/);
});

test("no unused status was invented", () => {
  /*
   * The brief listed `sending` and `retried` as candidates. Neither is here:
   * `sending` would duplicate `queued` for the same window, and `retried` would
   * leave a row claiming it was retried without saying whether the retry
   * worked. A retry re-claims back to `queued`; the count lives in
   * `attempt_count`.
   */
  assert.deepEqual([...DELIVERY_STATUSES], ["queued", "sent", "delivered", "failed", "skipped"]);
  assert.ok(!MIGRATION.includes("'sending'"), "a separate sending state would duplicate queued");
  assert.ok(!MIGRATION.includes("'retried'"), "a retry is an attempt count, not a terminal status");
  // "Suppressed" is a *label* on the stored `skipped`, not a sixth value: a
  // rename would migrate live rows to say the same thing.
  assert.ok(!MIGRATION.includes("'suppressed'"));
});

test("a status nothing can produce is not offered as a filter", () => {
  // A filter that always returns nothing reads as "nothing has been delivered",
  // when the truth is that delivery confirmation is not tracked at all.
  assert.deepEqual([...PROVIDER_CONFIRMED_STATUSES], ["delivered"]);
  assert.ok(!FILTERABLE_DELIVERY_STATUSES.includes("delivered"));
  assert.deepEqual([...FILTERABLE_DELIVERY_STATUSES], ["queued", "sent", "failed", "skipped"]);
  // And the help text says so rather than leaving it to be inferred.
  assert.match(DELIVERY_STATUS_HELP.delivered, /not wired/);
});

test("the filterable list is derived, so it cannot drift from the full one", () => {
  const source = read("src/lib/comms/deliveryCenter.ts");
  assert.match(source, /DELIVERY_STATUSES\.filter\(/);
  for (const status of FILTERABLE_DELIVERY_STATUSES) {
    assert.ok(DELIVERY_STATUSES.includes(status), `${status} is filterable but not a legal status`);
  }
});

test("the page offers only the filterable statuses", () => {
  const page = read("src/app/staff/emails/deliveries/page.tsx");
  assert.match(page, /FILTERABLE_DELIVERY_STATUSES\.map/);
  assert.ok(!/\{DELIVERY_STATUSES\.map/.test(page), "the page must not offer a status nothing produces");
});

test("the API still accepts every legal status, including one only the provider writes", () => {
  // The filter list is narrower than the constraint on purpose, but a row that
  // somehow holds `delivered` must still render and still be filterable by URL.
  assert.equal(parseDeliveryFilters({ status: "delivered" }).status[0], "delivered");
  assert.equal(toDeliveryView(delivery({ status: "delivered" })).statusLabel, "Delivered");
});

test("a delivered message is treated as already sent and is not resendable twice", () => {
  const sender = read("src/lib/commerceEmail.ts");
  assert.match(sender, /row\.status === "sent" \|\| row\.status === "delivered"/);
});

test("an unknown status renders without throwing and is not resendable", () => {
  const view = toDeliveryView(delivery({ status: "something-else" }));
  assert.equal(view.status, "unknown");
  assert.equal(view.statusLabel, "Unknown");
});
