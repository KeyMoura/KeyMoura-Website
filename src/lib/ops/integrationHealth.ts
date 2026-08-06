/**
 * Integration health — what is configured, and what is actually *known* to work.
 *
 * Pure and dependency-free. The route gathers evidence; this module decides what
 * the evidence means. That split is what makes the rules testable without a
 * database, and it is what stops the page inventing an answer.
 *
 * ## The distinction the whole page exists for
 *
 * An environment variable being present proves **configuration**. It does not
 * prove the key is valid, the account is live, the domain is verified, the
 * endpoint is subscribed, or the service is reachable. Every previous pass in
 * this project has been bitten by exactly that gap:
 *
 *   * pass 5a — four tables were created, RLS was correct, permissions were
 *     correct, and every read failed, because the grants were missing. Nothing
 *     in the configuration was wrong.
 *   * pass 5 — Vercel Analytics was installed and mounted and the script was
 *     served, and a recorded pageview still could not be observed, because the
 *     script refuses to run under automation.
 *   * pass 7 — the refund webhook handler was deployed and correct, and the
 *     endpoint was not subscribed to the events, so it was never called.
 *
 * So a check reports one of two confidences:
 *
 *   * `verified` — something actually happened. A webhook arrived and its
 *     signature checked out. An email was accepted by the provider. A query
 *     returned rows.
 *   * `assumed` — configuration is present and coherent, and nothing has
 *     exercised it. **This is not the same as healthy**, and the page says so
 *     in those words rather than showing a green tick.
 *
 * Nothing here makes a destructive or billable call. No test charge, no test
 * refund, no real email. A health page that has to spend money to tell you it
 * is healthy is a health page nobody runs.
 */

export type IntegrationStatus = "healthy" | "degraded" | "failing" | "incomplete" | "not_configured";
export type IntegrationConfidence = "verified" | "assumed";

export type IntegrationCheck = {
  key: string;
  label: string;
  /** What this integration does, in the shop's terms rather than the vendor's. */
  purpose: string;
  status: IntegrationStatus;
  confidence: IntegrationConfidence;
  /** One sentence stating what is known. Never a secret, never a raw provider payload. */
  summary: string;
  /** ISO timestamp of the last observed success, when one is recorded. */
  lastSuccessAt: string | null;
  /** A safe, already-classified description of the last failure. Never a provider string. */
  lastFailure: { at: string; summary: string } | null;
  /** Where to go to fix or configure it. */
  settingsHref: string | null;
  settingsLabel: string | null;
  /** Where the relevant records live, when there are any. */
  recordsHref: string | null;
  recordsLabel: string | null;
  /** What would have to happen for this to become `verified`. */
  verificationNote: string | null;
};

export const STATUS_LABELS: Readonly<Record<IntegrationStatus, string>> = {
  healthy: "Working",
  degraded: "Degraded",
  failing: "Failing",
  incomplete: "Incomplete",
  not_configured: "Not configured",
};

/** Worst first, so the page can sort by "what should I look at". */
export const STATUS_RANK: Readonly<Record<IntegrationStatus, number>> = {
  failing: 0,
  incomplete: 1,
  degraded: 2,
  not_configured: 3,
  healthy: 4,
};

/** One integration's observed history, as gathered by the route. */
export type Observation = {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureSummary: string | null;
  /** Failures in the recent window, used to tell a blip from a broken thing. */
  recentFailures: number;
};

export const NO_OBSERVATION: Observation = {
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureSummary: null,
  recentFailures: 0,
};

/**
 * Everything the route measures. Deliberately a flat record of *facts*, never
 * of conclusions — the conclusions are this module's job, and keeping them
 * apart is what lets the tests state a fact and assert a verdict.
 */
export type IntegrationEvidence = {
  /** Presence only. The values themselves never leave the server. */
  env: {
    supabaseUrl: boolean;
    supabaseAnonKey: boolean;
    supabaseServiceRoleKey: boolean;
    stripeSecretKey: boolean;
    stripeWebhookSecret: boolean;
    /** True when the Stripe secret key is a live key rather than a test key. */
    stripeLiveMode: boolean;
    resendApiKey: boolean;
    sentryDsn: boolean;
    turnstileSiteKey: boolean;
    turnstileSecretKey: boolean;
    googleOAuth: boolean;
    facebookOAuth: boolean;
    siteUrl: boolean;
  };
  /** True when the package is installed and mounted in the root layout. */
  mounted: {
    vercelAnalytics: boolean;
    speedInsights: boolean;
    sentry: boolean;
  };
  database: {
    /** A real query returned. This is a verified success by construction. */
    reachable: boolean;
    migrationRowCount: number | null;
    repoMigrationCount: number;
    /** Versions present in one and not the other, either direction. */
    migrationDrift: string[];
  };
  stripe: {
    /** Distinct event types seen in `stripe_webhook_events`. */
    receivedEventTypes: string[];
    lastEventAt: string | null;
    /** Events with no `processed_at`, which is a delivery that failed midway. */
    unprocessedCount: number;
  };
  email: {
    configuredSender: boolean;
    configuredReplyTo: boolean;
    staffRecipientConfigured: boolean;
    templateCount: number;
    expectedTemplateCount: number;
    sentLast30Days: number;
    failedLast30Days: number;
    lastSentAt: string | null;
  };
  deployment: {
    /** From `VERCEL_ENV`; absent locally, which is not a fault. */
    environment: string | null;
    commitSha: string | null;
  };
  storage: {
    /** Buckets that exist. Empty is meaningful: production job files need one. */
    buckets: string[];
    productionJobFileCount: number;
  };
  inventory: {
    activeReservations: number;
    expiredUnsweptReservations: number;
  };
  observations: Record<string, Observation>;
};

const observation = (evidence: IntegrationEvidence, key: string): Observation =>
  evidence.observations[key] ?? NO_OBSERVATION;

/**
 * The Stripe webhook event types this application actually handles.
 *
 * Listed here rather than in the route so the launch checklist and the health
 * page ask the same question. Missing any of these is not a code fault — the
 * handler is deployed either way — it is a *subscription* fault at Stripe, and
 * it is invisible until the day it matters.
 */
export const REQUIRED_STRIPE_EVENTS = [
  "checkout.session.completed",
  "checkout.session.expired",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "refund.created",
  "refund.updated",
  "refund.failed",
] as const;

/** Refund events, any one of which proves the refund subscription exists. */
const REFUND_EVENT_ALIASES = ["refund.created", "refund.updated", "refund.failed", "charge.refund.updated"];

export function buildIntegrationChecks(evidence: IntegrationEvidence, now: Date): IntegrationCheck[] {
  const checks: IntegrationCheck[] = [];
  const daysAgo = (iso: string | null) =>
    iso ? Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000) : null;

  // ------------------------------------------------------------------ database
  const ledgerAligned =
    evidence.database.migrationRowCount !== null &&
    evidence.database.migrationRowCount === evidence.database.repoMigrationCount &&
    evidence.database.migrationDrift.length === 0;

  checks.push({
    key: "supabase_database",
    label: "Supabase database",
    purpose: "Every order, product, payment and setting lives here.",
    status: evidence.database.reachable ? "healthy" : "failing",
    // Reading rows *is* the verification. There is no weaker form of this check.
    confidence: "verified",
    summary: evidence.database.reachable
      ? "Queries are returning against the production database."
      : "The database did not answer. Nothing on this site will work until it does.",
    lastSuccessAt: evidence.database.reachable ? now.toISOString() : null,
    lastFailure: null,
    settingsHref: null,
    settingsLabel: null,
    recordsHref: null,
    recordsLabel: null,
    verificationNote: null,
  });

  checks.push({
    key: "migration_ledger",
    label: "Migration ledger",
    purpose: "Proves the deployed schema matches the migrations in the repository.",
    status: evidence.database.migrationRowCount === null ? "degraded" : ledgerAligned ? "healthy" : "degraded",
    confidence: evidence.database.migrationRowCount === null ? "assumed" : "verified",
    summary:
      evidence.database.migrationRowCount === null
        ? "The ledger could not be read, so alignment is unknown."
        : ledgerAligned
          ? `${evidence.database.migrationRowCount} recorded migrations, matching the ${evidence.database.repoMigrationCount} files in the repository.`
          : `${evidence.database.migrationRowCount} recorded against ${evidence.database.repoMigrationCount} files, with ${evidence.database.migrationDrift.length} version(s) on one side only.`,
    lastSuccessAt: ledgerAligned ? now.toISOString() : null,
    lastFailure: null,
    settingsHref: null,
    settingsLabel: null,
    recordsHref: null,
    recordsLabel: null,
    // Drift is bookkeeping, not schema: pass 3 found 17 applied-but-unrecorded
    // migrations against a schema that was entirely correct.
    verificationNote: ledgerAligned
      ? null
      : "Drift here means the bookkeeping disagrees with the files. It does not by itself mean the schema is wrong — check the objects, not the row count.",
  });

  // -------------------------------------------------------------------- Stripe
  checks.push({
    key: "stripe",
    label: "Stripe payments",
    purpose: "Takes payment at checkout and sends refunds back.",
    status: !evidence.env.stripeSecretKey
      ? "not_configured"
      : !evidence.env.stripeWebhookSecret
        ? "incomplete"
        : "healthy",
    // A secret key being present says nothing about whether it is valid. Only a
    // signature-verified webhook proves the account and this deployment agree.
    confidence: evidence.stripe.lastEventAt ? "verified" : "assumed",
    summary: !evidence.env.stripeSecretKey
      ? "No Stripe secret key is set. Checkout cannot take payment."
      : !evidence.env.stripeWebhookSecret
        ? "A secret key is set but no webhook signing secret is. Payments would be taken and never settled here."
        : evidence.stripe.lastEventAt
          ? `${evidence.env.stripeLiveMode ? "Live" : "Test"} mode. Last verified webhook ${describeAge(daysAgo(evidence.stripe.lastEventAt))}.`
          : `${evidence.env.stripeLiveMode ? "Live" : "Test"} mode configured. No webhook has been received yet, so the wiring is unproven.`,
    lastSuccessAt: evidence.stripe.lastEventAt,
    lastFailure: failureOf(observation(evidence, "stripe_webhook")),
    settingsHref: null,
    settingsLabel: null,
    recordsHref: "/staff/reconciliation",
    recordsLabel: "Reconciliation",
    verificationNote: evidence.stripe.lastEventAt
      ? null
      : "A signature-verified webhook is the proof. Until one arrives this is configuration only.",
  });

  const seen = new Set(evidence.stripe.receivedEventTypes);
  const missingEvents = REQUIRED_STRIPE_EVENTS.filter((type) => {
    if (REFUND_EVENT_ALIASES.includes(type)) return !REFUND_EVENT_ALIASES.some((alias) => seen.has(alias));
    return !seen.has(type);
  });
  checks.push({
    key: "stripe_webhook_events",
    label: "Stripe webhook subscription",
    purpose: "Stripe only delivers the event types the endpoint is subscribed to.",
    // Never `healthy`: not having *seen* an event type is not proof it is
    // unsubscribed — a shop with no refunds has never had a refund event.
    status: missingEvents.length === 0 ? "healthy" : "degraded",
    confidence: missingEvents.length === 0 ? "verified" : "assumed",
    summary:
      missingEvents.length === 0
        ? "Every event type this application handles has been received at least once."
        : `${missingEvents.length} of ${REQUIRED_STRIPE_EVENTS.length} handled event types have never been received: ${missingEvents.join(", ")}.`,
    lastSuccessAt: evidence.stripe.lastEventAt,
    lastFailure: null,
    settingsHref: null,
    settingsLabel: null,
    recordsHref: null,
    recordsLabel: null,
    verificationNote:
      missingEvents.length === 0
        ? null
        : "Never having received a type is not proof it is unsubscribed — a shop with no refunds has no refund events. Confirm the subscription in the Stripe dashboard.",
  });

  checks.push({
    key: "stripe_webhook_processing",
    label: "Stripe webhook processing",
    purpose: "A delivered event that is never processed is money settled at Stripe and not here.",
    status: evidence.stripe.unprocessedCount === 0 ? "healthy" : evidence.stripe.unprocessedCount > 2 ? "failing" : "degraded",
    confidence: "verified",
    summary:
      evidence.stripe.unprocessedCount === 0
        ? "Every received webhook completed processing."
        : `${evidence.stripe.unprocessedCount} received webhook(s) were never marked processed.`,
    lastSuccessAt: evidence.stripe.lastEventAt,
    lastFailure: failureOf(observation(evidence, "stripe_webhook")),
    settingsHref: null,
    settingsLabel: null,
    recordsHref: "/staff/reconciliation",
    recordsLabel: "Reconciliation",
    verificationNote: null,
  });

  checks.push({
    key: "stripe_tax",
    label: "Stripe Tax",
    purpose: "Automatic sales-tax calculation at checkout.",
    // Not a fault. An owner decision recorded on 2026-08-05, restated here so
    // the page never reads as though tax were handled.
    status: "not_configured",
    confidence: "verified",
    summary:
      "Deliberately not integrated. No tax is calculated, collected or reported, and `tax_cents` is always zero.",
    lastSuccessAt: null,
    lastFailure: null,
    settingsHref: null,
    settingsLabel: null,
    recordsHref: null,
    recordsLabel: null,
    verificationNote:
      "Enabling it needs Stripe Tax on the account, at least one tax registration, a product tax code per product, and tax-aware refund arithmetic. Stripe Tax does not handle registration or filing — that is a business obligation.",
  });

  // -------------------------------------------------------------------- Resend
  const emailObs = observation(evidence, "resend");
  const emailFailing = evidence.email.failedLast30Days > 0 && evidence.email.sentLast30Days === 0;
  checks.push({
    key: "resend",
    label: "Resend email",
    purpose: "Sends every order, quote, fulfillment, cancellation and refund message.",
    status: !evidence.env.resendApiKey
      ? "not_configured"
      : !evidence.email.configuredSender
        ? "incomplete"
        : emailFailing
          ? "failing"
          : evidence.email.failedLast30Days > 0
            ? "degraded"
            : "healthy",
    confidence: evidence.email.lastSentAt ? "verified" : "assumed",
    summary: !evidence.env.resendApiKey
      ? "No Resend API key is set. Every transactional email is recorded as suppressed and nothing reaches a customer."
      : !evidence.email.configuredSender
        ? "A key is set but no sender address is configured."
        : evidence.email.lastSentAt
          ? `${evidence.email.sentLast30Days} sent and ${evidence.email.failedLast30Days} failed in the last 30 days. Last send ${describeAge(daysAgo(evidence.email.lastSentAt))}.`
          : "Configured, but nothing has been sent yet, so the key and domain are unproven.",
    lastSuccessAt: evidence.email.lastSentAt,
    lastFailure: failureOf(emailObs),
    settingsHref: "/staff/emails",
    settingsLabel: "Email settings",
    recordsHref: "/staff/emails/deliveries",
    recordsLabel: "Delivery history",
    verificationNote: evidence.email.lastSentAt
      ? null
      : "A send accepted by the provider is the proof. A test send from the email settings page produces one without touching a customer.",
  });

  checks.push({
    key: "email_templates",
    label: "Email templates",
    purpose: "The wording every transactional message is rendered from.",
    status: evidence.email.templateCount >= evidence.email.expectedTemplateCount ? "healthy" : "incomplete",
    confidence: "verified",
    summary:
      evidence.email.templateCount >= evidence.email.expectedTemplateCount
        ? `All ${evidence.email.expectedTemplateCount} templates are present.`
        : `${evidence.email.templateCount} of ${evidence.email.expectedTemplateCount} templates are present. A missing template still sends, using a generic subject and body.`,
    lastSuccessAt: null,
    lastFailure: null,
    settingsHref: "/staff/emails",
    settingsLabel: "Edit templates",
    recordsHref: null,
    recordsLabel: null,
    verificationNote: null,
  });

  // ---------------------------------------------------------------- deployment
  checks.push({
    key: "vercel_deployment",
    label: "Vercel deployment",
    purpose: "Builds and serves the site.",
    status: "healthy",
    // This code is executing, which is the only proof of deployment that
    // matters and the only one available from inside it.
    confidence: "verified",
    summary: evidence.deployment.environment
      ? `Serving from the ${evidence.deployment.environment} environment${evidence.deployment.commitSha ? ` at ${evidence.deployment.commitSha.slice(0, 7)}` : ""}.`
      : "Serving. No Vercel environment is reported, which is normal for a local run.",
    lastSuccessAt: now.toISOString(),
    lastFailure: null,
    settingsHref: null,
    settingsLabel: null,
    recordsHref: null,
    recordsLabel: null,
    verificationNote: null,
  });

  checks.push({
    key: "vercel_analytics",
    label: "Vercel Web Analytics",
    purpose: "Counts page views.",
    status: evidence.mounted.vercelAnalytics ? "healthy" : "not_configured",
    // Deliberately never `verified`. The served script refuses to run when
    // `navigator.webdriver` is set, so no automated session can ever observe a
    // recorded pageview — pass 5 established this and it has not changed.
    confidence: "assumed",
    summary: evidence.mounted.vercelAnalytics
      ? "The analytics component is mounted in the root layout."
      : "Not mounted. No page views are being recorded.",
    lastSuccessAt: null,
    lastFailure: null,
    settingsHref: null,
    settingsLabel: null,
    recordsHref: null,
    recordsLabel: null,
    verificationNote:
      "Cannot be verified from inside the application: the tracking script refuses to run under automation, so a recorded view is only observable in a normal browser and in the Vercel dashboard.",
  });

  checks.push({
    key: "speed_insights",
    label: "Speed Insights",
    purpose: "Reports real-user performance.",
    status: evidence.mounted.speedInsights ? "healthy" : "not_configured",
    confidence: "assumed",
    summary: evidence.mounted.speedInsights
      ? "The Speed Insights component is mounted in the root layout."
      : "Not mounted.",
    lastSuccessAt: null,
    lastFailure: null,
    settingsHref: null,
    settingsLabel: null,
    recordsHref: null,
    recordsLabel: null,
    verificationNote: "Confirmed in the Vercel dashboard rather than from here.",
  });

  checks.push({
    key: "sentry",
    label: "Sentry",
    purpose: "Captures server and browser exceptions.",
    status: evidence.env.sentryDsn && evidence.mounted.sentry ? "healthy" : evidence.mounted.sentry ? "incomplete" : "not_configured",
    confidence: "assumed",
    summary:
      evidence.env.sentryDsn && evidence.mounted.sentry
        ? "A DSN is set and the instrumentation is present."
        : evidence.mounted.sentry
          ? "Instrumentation is present but no DSN is set, so nothing is reported."
          : "No Sentry instrumentation found.",
    lastSuccessAt: null,
    lastFailure: null,
    settingsHref: null,
    settingsLabel: null,
    recordsHref: null,
    recordsLabel: null,
    verificationNote:
      "Verifying this means deliberately throwing an exception in production, which this page will not do. Confirm in the Sentry dashboard.",
  });

  // ------------------------------------------------------------------ identity
  for (const [key, label, present] of [
    ["google_oauth", "Google sign-in", evidence.env.googleOAuth],
    ["facebook_oauth", "Facebook sign-in", evidence.env.facebookOAuth],
  ] as const) {
    checks.push({
      key,
      label,
      purpose: "Lets customers sign in without a password.",
      status: present ? "healthy" : "not_configured",
      confidence: "assumed",
      summary: present
        ? "Configured in the Supabase authentication providers."
        : "Not configured. Customers cannot use this provider to sign in.",
      lastSuccessAt: null,
      lastFailure: null,
      settingsHref: null,
      settingsLabel: null,
      recordsHref: null,
      recordsLabel: null,
      verificationNote:
        "Verifying it means completing a real sign-in, which needs a password and a consent screen. Configuration presence is what this page can honestly report.",
    });
  }

  checks.push({
    key: "turnstile",
    label: "Cloudflare Turnstile",
    purpose: "Keeps automated submissions off the public forms.",
    status:
      evidence.env.turnstileSiteKey && evidence.env.turnstileSecretKey
        ? "healthy"
        : evidence.env.turnstileSiteKey || evidence.env.turnstileSecretKey
          ? "incomplete"
          : "not_configured",
    confidence: "assumed",
    summary:
      evidence.env.turnstileSiteKey && evidence.env.turnstileSecretKey
        ? "Both the site key and the secret key are set."
        : evidence.env.turnstileSiteKey || evidence.env.turnstileSecretKey
          ? "Only one of the two keys is set. A half-configured Turnstile either blocks everybody or nobody."
          : "Not configured. Public forms rely on rate limiting alone.",
    lastSuccessAt: null,
    lastFailure: null,
    settingsHref: null,
    settingsLabel: null,
    recordsHref: null,
    recordsLabel: null,
    verificationNote: null,
  });

  // ------------------------------------------------------------------- storage
  checks.push({
    key: "supabase_storage",
    label: "Supabase Storage",
    purpose: "Holds product media.",
    status: evidence.storage.buckets.length > 0 ? "healthy" : "not_configured",
    confidence: evidence.storage.buckets.length > 0 ? "verified" : "assumed",
    summary: evidence.storage.buckets.length
      ? `${evidence.storage.buckets.length} bucket(s) present.`
      : "No storage buckets were found.",
    lastSuccessAt: null,
    lastFailure: null,
    settingsHref: null,
    settingsLabel: null,
    recordsHref: null,
    recordsLabel: null,
    verificationNote: null,
  });

  const jobFilesBucket = evidence.storage.buckets.includes("production-job-files");
  checks.push({
    key: "production_job_files",
    label: "Production job file storage",
    purpose: "Somewhere to keep CAD, CAM and drawing files against a job.",
    status: jobFilesBucket ? "healthy" : evidence.storage.productionJobFileCount > 0 ? "degraded" : "not_configured",
    confidence: "verified",
    summary: jobFilesBucket
      ? "A private bucket for job files exists."
      : evidence.storage.productionJobFileCount > 0
        ? `${evidence.storage.productionJobFileCount} job file reference(s) exist with no bucket behind them, so they must all be external links.`
        : "No bucket. Job files can only be recorded as external links or paths, which is what the schema supports today.",
    lastSuccessAt: null,
    lastFailure: null,
    settingsHref: null,
    settingsLabel: null,
    recordsHref: "/staff/production",
    recordsLabel: "Production",
    verificationNote:
      "Uploads are not built. `production_job_files` records references only; direct upload needs a private bucket, an upload route and expiring signed URLs.",
  });

  // ----------------------------------------------------------------- inventory
  checks.push({
    key: "inventory_reservations",
    label: "Inventory reservations",
    purpose: "Stops two customers buying the last unit.",
    status: evidence.inventory.expiredUnsweptReservations > 5 ? "degraded" : "healthy",
    confidence: "verified",
    summary:
      evidence.inventory.expiredUnsweptReservations > 0
        ? `${evidence.inventory.activeReservations} active hold(s); ${evidence.inventory.expiredUnsweptReservations} lapsed hold(s) not yet swept.`
        : `${evidence.inventory.activeReservations} active hold(s), none lapsed.`,
    lastSuccessAt: null,
    lastFailure: null,
    settingsHref: "/staff/settings/commerce",
    settingsLabel: "Inventory rules",
    recordsHref: "/staff/inventory",
    recordsLabel: "Inventory",
    // Expiry is not load-bearing on a scheduler by design: availability ignores
    // a lapsed hold whether or not it has been swept.
    verificationNote:
      "A lapsed hold never reduces availability, whether or not it has been swept, so this degrades rather than fails.",
  });

  checks.push({
    key: "scheduled_cleanup",
    label: "Scheduled cleanup",
    purpose: "Sweeping lapsed holds, expiring quotes, sending reminders.",
    status: "not_configured",
    confidence: "verified",
    summary:
      "There is no scheduled job runner. Sweeping happens when a reservation is taken and when the inventory page loads, which is enough for holds and not enough for reminders.",
    lastSuccessAt: null,
    lastFailure: null,
    settingsHref: null,
    settingsLabel: null,
    recordsHref: null,
    recordsLabel: null,
    verificationNote:
      "Quote expiry and payment reminders are the two features waiting on this. Both are specified and unbuilt rather than half-wired.",
  });

  return checks.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.label.localeCompare(b.label));
}

function failureOf(obs: Observation): { at: string; summary: string } | null {
  if (!obs.lastFailureAt) return null;
  return { at: obs.lastFailureAt, summary: obs.lastFailureSummary ?? "A failure was recorded." };
}

function describeAge(days: number | null): string {
  if (days === null) return "at an unknown time";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return `${Math.floor(days / 30)} month(s) ago`;
}

/** A one-line roll-up for the dashboard and the launch checklist. */
export function summarizeIntegrations(checks: readonly IntegrationCheck[]) {
  return {
    failing: checks.filter((check) => check.status === "failing").length,
    incomplete: checks.filter((check) => check.status === "incomplete").length,
    degraded: checks.filter((check) => check.status === "degraded").length,
    notConfigured: checks.filter((check) => check.status === "not_configured").length,
    healthy: checks.filter((check) => check.status === "healthy").length,
    verified: checks.filter((check) => check.confidence === "verified").length,
    total: checks.length,
  };
}
