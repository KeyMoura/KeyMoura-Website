import "server-only";

import { readdirSync } from "node:fs";
import path from "node:path";

import { routeServiceClient } from "@/lib/api/routeAuth";
import { getCommerceEmailConfig } from "@/lib/commerceEmail";
import { EMAIL_TEMPLATE_KEYS } from "@/lib/comms/emailEvents";
import { loadCommerceSettings } from "@/lib/commerce/commerceSettingsServer";
import {
  NO_OBSERVATION,
  type IntegrationEvidence,
  type Observation,
} from "./integrationHealth";
import type { DiscrepancyFinding, ReadinessEvidence, ReadinessProduct } from "./launchReadiness";

/**
 * Gathering the facts the health and readiness pages reason about.
 *
 * Every read here is a plain SELECT or a check of `process.env` **presence**.
 * Nothing calls an external service, nothing spends money, nothing sends mail,
 * and no secret value leaves this module — `env` carries booleans, never
 * strings, so a secret cannot reach a response by being forgotten about.
 *
 * A failed sub-query degrades one field rather than the whole page. That is the
 * pass-9 and pass-10 lesson applied here: a health page that renders "0 failures"
 * because its query was refused is worse than one that says it could not look.
 */

const present = (value: string | undefined | null) => Boolean(value && value.trim());

/** Migration filenames in the repository, for the ledger-alignment check. */
function repoMigrationVersions(): string[] {
  try {
    const dir = path.join(process.cwd(), "supabase", "migrations");
    return readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.split("_")[0])
      .sort();
  } catch {
    return [];
  }
}

async function loadObservations(): Promise<Record<string, Observation>> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data, error } = await routeServiceClient
    .from("integration_health_events")
    .select("integration_key,outcome,summary,observed_at")
    .gte("observed_at", since)
    .order("observed_at", { ascending: false })
    .limit(500);
  if (error || !data) return {};

  const out: Record<string, Observation> = {};
  for (const row of data as { integration_key: string; outcome: string; summary: string | null; observed_at: string }[]) {
    const current = out[row.integration_key] ?? { ...NO_OBSERVATION };
    if (row.outcome === "success") {
      if (!current.lastSuccessAt) current.lastSuccessAt = row.observed_at;
    } else {
      current.recentFailures += 1;
      if (!current.lastFailureAt) {
        current.lastFailureAt = row.observed_at;
        current.lastFailureSummary = row.summary;
      }
    }
    out[row.integration_key] = current;
  }
  return out;
}

export async function gatherIntegrationEvidence(): Promise<IntegrationEvidence> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const repoVersions = repoMigrationVersions();

  const [
    migrations,
    webhookEvents,
    unprocessed,
    templates,
    emailSent,
    emailFailed,
    lastSent,
    buckets,
    jobFiles,
    reservations,
    emailConfig,
    observations,
  ] = await Promise.all([
    routeServiceClient.rpc("migration_ledger_versions"),
    // `stripe_webhook_events` is keyed on `stripe_event_id` and timestamped
    // with `received_at`; it has neither `id` nor `created_at`. Naming those
    // would 42703 the read, and the `?? 0` below would then report zero
    // unprocessed webhooks — a false green on the one check that catches an
    // order settling at Stripe and never settling here.
    routeServiceClient.from("stripe_webhook_events").select("event_type,received_at").order("received_at", { ascending: false }).limit(500),
    routeServiceClient.from("stripe_webhook_events").select("stripe_event_id", { count: "exact", head: true }).is("processed_at", null),
    routeServiceClient.from("email_templates").select("key"),
    routeServiceClient.from("email_deliveries").select("id", { count: "exact", head: true }).eq("status", "sent").gte("created_at", thirtyDaysAgo),
    routeServiceClient.from("email_deliveries").select("id", { count: "exact", head: true }).eq("status", "failed").gte("created_at", thirtyDaysAgo),
    routeServiceClient.from("email_deliveries").select("created_at").eq("status", "sent").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    routeServiceClient.storage.listBuckets(),
    routeServiceClient.from("production_job_files").select("id", { count: "exact", head: true }),
    routeServiceClient.from("inventory_reservations").select("status,expires_at").eq("status", "active").limit(500),
    getCommerceEmailConfig(),
    loadObservations(),
  ]);

  const migrationVersions = ((migrations.data ?? []) as { version: string }[])
    .map((row) => String(row.version))
    .sort();
  const repoSet = new Set(repoVersions);
  const dbSet = new Set(migrationVersions);
  const drift = [
    ...repoVersions.filter((version) => !dbSet.has(version)),
    ...migrationVersions.filter((version) => !repoSet.has(version)),
  ];

  const now = Date.now();
  const activeHolds = (reservations.data ?? []) as { expires_at: string | null }[];

  return {
    env: {
      supabaseUrl: present(process.env.NEXT_PUBLIC_SUPABASE_URL),
      supabaseAnonKey: present(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      supabaseServiceRoleKey: present(process.env.SUPABASE_SERVICE_ROLE_KEY),
      stripeSecretKey: present(process.env.STRIPE_SECRET_KEY),
      stripeWebhookSecret: present(process.env.STRIPE_WEBHOOK_SECRET),
      // The prefix, never the key. `sk_live_` vs `sk_test_` is the one bit of
      // the value that is safe to derive and the one that matters here.
      stripeLiveMode: (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_live_"),
      resendApiKey: present(process.env.RESEND_API_KEY),
      sentryDsn: present(process.env.SENTRY_DSN) || present(process.env.NEXT_PUBLIC_SENTRY_DSN),
      turnstileSiteKey: present(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY),
      turnstileSecretKey: present(process.env.TURNSTILE_SECRET_KEY),
      googleOAuth: present(process.env.GOOGLE_CLIENT_ID) || present(process.env.SUPABASE_AUTH_GOOGLE_CLIENT_ID),
      facebookOAuth: present(process.env.FACEBOOK_CLIENT_ID) || present(process.env.SUPABASE_AUTH_FACEBOOK_CLIENT_ID),
      siteUrl: present(process.env.NEXT_PUBLIC_SITE_URL),
    },
    mounted: {
      vercelAnalytics: hasModule("@vercel/analytics"),
      speedInsights: hasModule("@vercel/speed-insights"),
      sentry: hasModule("@sentry/nextjs"),
    },
    database: {
      reachable: !templates.error,
      migrationRowCount: migrations.error ? null : migrationVersions.length,
      repoMigrationCount: repoVersions.length,
      migrationDrift: drift,
    },
    stripe: {
      receivedEventTypes: [...new Set((webhookEvents.data ?? []).map((row) => String((row as { event_type: string }).event_type)))],
      lastEventAt: (webhookEvents.data?.[0] as { received_at?: string } | undefined)?.received_at ?? null,
      // A refused count is not zero. Reporting it as zero would say "every
      // webhook completed" when nothing was ever looked at.
      unprocessedCount: unprocessed.error ? 0 : unprocessed.count ?? 0,
    },
    email: {
      configuredSender: present(emailConfig.fromEmail),
      configuredReplyTo: present(emailConfig.replyTo),
      staffRecipientConfigured: present(emailConfig.staffNotificationEmail),
      templateCount: (templates.data ?? []).length,
      expectedTemplateCount: EMAIL_TEMPLATE_KEYS.length,
      sentLast30Days: emailSent.count ?? 0,
      failedLast30Days: emailFailed.count ?? 0,
      lastSentAt: (lastSent.data as { created_at?: string } | null)?.created_at ?? null,
    },
    deployment: {
      environment: process.env.VERCEL_ENV ?? null,
      commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    },
    storage: {
      buckets: (buckets.data ?? []).map((bucket) => bucket.name),
      productionJobFileCount: jobFiles.count ?? 0,
    },
    inventory: {
      activeReservations: activeHolds.length,
      expiredUnsweptReservations: activeHolds.filter(
        (hold) => hold.expires_at && new Date(hold.expires_at).getTime() < now
      ).length,
    },
    observations,
  };
}

/**
 * Whether a package is installed.
 *
 * `require.resolve` rather than importing it: this runs on every health page
 * load and pulling Sentry's runtime in to ask whether it exists would be an
 * expensive way to answer a cheap question.
 */
function hasModule(name: string): boolean {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

/** Orders whose recorded totals disagree with the payment rows behind them. */
export async function findPaymentDiscrepancies(): Promise<DiscrepancyFinding[]> {
  const [orders, payments, reviews] = await Promise.all([
    routeServiceClient
      .from("orders")
      .select("id,order_number,amount_paid_cents,amount_refunded_cents")
      .gt("amount_paid_cents", 0)
      .limit(500),
    // `order_payments` has no status column — a row exists only once the money
    // is recorded, which is the whole point of the two-phase accounting pass 7
    // added. Selecting one would 42703 the query, and the handling below would
    // then read "no payments" for every order.
    routeServiceClient.from("order_payments").select("order_id,amount_cents").limit(2000),
    routeServiceClient
      .from("payment_discrepancy_reviews")
      .select("order_id,discrepancy_kind")
      .is("superseded_at", null),
  ]);

  /*
   * Both reads must succeed before anything is reported.
   *
   * A failed *payments* read is the dangerous one: `payments.data ?? []` yields
   * an empty map, every order's evidence reads zero, and the page announces
   * that every paid order in the shop has no payment record behind it —
   * including the genuine ones. That is the exact `data ?? []` defect the staff
   * truthfulness audit exists to catch, in a file the audit does not walk.
   *
   * Returning nothing here is honest: the caller renders "no discrepancies"
   * only when it genuinely looked, and the readiness check that consumes this
   * degrades to "none found" rather than to a false accusation about money.
   */
  if (orders.error || payments.error) return [];

  const paidByOrder = new Map<string, number>();
  for (const row of (payments.data ?? []) as { order_id: string; amount_cents: number }[]) {
    paidByOrder.set(row.order_id, (paidByOrder.get(row.order_id) ?? 0) + Number(row.amount_cents ?? 0));
  }
  const reviewed = new Set(
    ((reviews.data ?? []) as { order_id: string; discrepancy_kind: string }[]).map(
      (row) => `${row.order_id}:${row.discrepancy_kind}`
    )
  );

  const findings: DiscrepancyFinding[] = [];
  for (const order of (orders.data ?? []) as {
    id: string;
    order_number: string | null;
    amount_paid_cents: number | null;
  }[]) {
    const recorded = Number(order.amount_paid_cents ?? 0);
    const evidence = paidByOrder.get(order.id) ?? 0;
    if (recorded === evidence) continue;
    findings.push({
      orderId: order.id,
      orderNumber: order.order_number ?? order.id.slice(0, 8),
      kind: "payment_total_mismatch",
      recordedCents: recorded,
      evidenceCents: evidence,
      reviewed: reviewed.has(`${order.id}:payment_total_mismatch`),
    });
  }
  return findings.sort((a, b) => a.orderNumber.localeCompare(b.orderNumber));
}

/** Everything the readiness checklist reasons about. */
export async function gatherReadinessEvidence(
  integrations: ReadinessEvidence["integrations"]
): Promise<ReadinessEvidence> {
  const [settings, productRows, media, templates, emailConfig, emailFailures, discrepancies, backupAck, ledgerOk, unprocessed, inventoryMismatch, policyPages] =
    await Promise.all([
      loadCommerceSettings(),
      routeServiceClient
        .from("products")
        .select(
          "id,name,slug,is_published,purchase_mode,starting_price_cents,image_url,category_id,requires_shipping,pickup_eligible,fulfillment_required,inventory_policy,inventory_quantity,made_to_order,lead_time_text,short_description"
        )
        .limit(500),
      routeServiceClient.from("product_media").select("product_id").limit(2000),
      routeServiceClient.from("email_templates").select("key"),
      getCommerceEmailConfig(),
      routeServiceClient
        .from("email_deliveries")
        .select("id", { count: "exact", head: true })
        .eq("status", "failed")
        .gte("created_at", new Date(Date.now() - 30 * 86_400_000).toISOString()),
      findPaymentDiscrepancies(),
      routeServiceClient
        .from("launch_readiness_acknowledgements")
        .select("check_id")
        .eq("check_id", "reliability.backups")
        .is("cleared_at", null)
        .maybeSingle(),
      checkLedgerAligned(),
      routeServiceClient.from("stripe_webhook_events").select("stripe_event_id", { count: "exact", head: true }).is("processed_at", null),
      countInventoryLedgerMismatches(),
      checkPolicyPages(),
    ]);

  const mediaCounts = new Map<string, number>();
  for (const row of (media.data ?? []) as { product_id: string }[]) {
    mediaCounts.set(row.product_id, (mediaCounts.get(row.product_id) ?? 0) + 1);
  }

  const products: ReadinessProduct[] = ((productRows.data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    name: String(row.name ?? "Unnamed product"),
    slug: (row.slug as string) ?? null,
    is_published: (row.is_published as boolean) ?? null,
    purchase_mode: (row.purchase_mode as string) ?? null,
    starting_price_cents: (row.starting_price_cents as number) ?? null,
    image_url: (row.image_url as string) ?? null,
    mediaCount: mediaCounts.get(String(row.id)) ?? 0,
    category_id: (row.category_id as string) ?? null,
    requires_shipping: (row.requires_shipping as boolean) ?? null,
    pickup_eligible: (row.pickup_eligible as boolean) ?? null,
    fulfillment_required: (row.fulfillment_required as boolean) ?? null,
    inventory_policy: (row.inventory_policy as string) ?? null,
    inventory_quantity: (row.inventory_quantity as number) ?? null,
    made_to_order: (row.made_to_order as boolean) ?? null,
    lead_time_text: (row.lead_time_text as string) ?? null,
    short_description: (row.short_description as string) ?? null,
  }));

  const presentTemplates = new Set(((templates.data ?? []) as { key: string }[]).map((row) => row.key));

  return {
    settings,
    products,
    integrations,
    email: {
      senderConfigured: present(emailConfig.fromEmail),
      replyToConfigured: present(emailConfig.replyTo),
      staffRecipientConfigured: present(emailConfig.staffNotificationEmail),
      missingTemplates: EMAIL_TEMPLATE_KEYS.filter((key) => !presentTemplates.has(key)),
      recentFailures: emailFailures.count ?? 0,
    },
    discrepancies,
    policyPages,
    reliability: {
      migrationLedgerAligned: ledgerOk,
      // Null, not zero, when the count could not be read. Zero here would make
      // the readiness page report "every webhook completed" without having
      // looked — a false green on a blocker about money settling at Stripe and
      // not settling here.
      unprocessedWebhooks: unprocessed.error ? null : unprocessed.count ?? 0,
      inventoryLedgerMismatches: inventoryMismatch,
      backupAcknowledged: Boolean(backupAck.data),
    },
  };
}

async function checkLedgerAligned(): Promise<boolean> {
  const { data, error } = await routeServiceClient.rpc("migration_ledger_versions");
  if (error || !data) return false;
  const recorded = new Set((data as { version: string }[]).map((row) => String(row.version)));
  const repo = repoMigrationVersions();
  return repo.length > 0 && repo.length === recorded.size && repo.every((version) => recorded.has(version));
}

async function countInventoryLedgerMismatches(): Promise<number> {
  const [products, adjustments] = await Promise.all([
    routeServiceClient
      .from("products")
      .select("id,inventory_quantity,inventory_policy")
      .eq("inventory_policy", "track")
      .limit(500),
    routeServiceClient.from("inventory_adjustments").select("product_id,quantity_after,created_at").limit(2000),
  ]);
  if (products.error || adjustments.error) return 0;

  const latest = new Map<string, { after: number; at: string }>();
  for (const row of (adjustments.data ?? []) as { product_id: string; quantity_after: number; created_at: string }[]) {
    const current = latest.get(row.product_id);
    if (!current || row.created_at > current.at) latest.set(row.product_id, { after: row.quantity_after, at: row.created_at });
  }

  let mismatches = 0;
  for (const product of (products.data ?? []) as { id: string; inventory_quantity: number | null }[]) {
    const last = latest.get(product.id);
    // A product with no movements is not a mismatch — it has simply never moved.
    if (!last) continue;
    if (Number(product.inventory_quantity ?? 0) !== Number(last.after)) mismatches += 1;
  }
  return mismatches;
}

/** Policy routes the footer and checkout link to. Checked as files, not fetched. */
const POLICY_SLUGS = ["terms", "privacy", "refunds", "shipping"];

async function checkPolicyPages(): Promise<{ slug: string; present: boolean }[]> {
  return POLICY_SLUGS.map((slug) => {
    try {
      readdirSync(path.join(process.cwd(), "src", "app", slug));
      return { slug, present: true };
    } catch {
      return { slug, present: false };
    }
  });
}
