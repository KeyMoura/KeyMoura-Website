import type { CommerceSettings } from "@/lib/commerce/commerceSettings";
import type { IntegrationCheck } from "./integrationHealth";

/**
 * Launch readiness — what would stop this shop taking a real order today.
 *
 * Pure and dependency-free. The route gathers facts; this module turns them
 * into a verdict. Keeping the two apart is what lets the tests state "shipping
 * is enabled with no methods" and assert "blocker", without a database.
 *
 * ## What this page will not claim
 *
 * It does not certify legal, tax, accessibility or security compliance, and it
 * says so on the page rather than only here. A checklist that reports "compliant"
 * because a policy page exists is worse than no checklist: it converts an
 * unanswered question into a false answer, and the person who most needs to ask
 * it is exactly the person who will read the tick and stop.
 *
 * What it does check is narrower and honest: whether the *configuration this
 * application reads* is coherent and complete enough for the flows it runs.
 *
 * ## Severity means something specific
 *
 *   * `blocker` — a customer trying to buy right now would fail, or money would
 *     move incorrectly. Not "important": *broken*.
 *   * `warning` — it works, but something is missing that a shop would want
 *     before opening the doors, or a discrepancy needs a human decision.
 *   * `info` — a deliberate choice worth restating so nobody assumes otherwise.
 */

export type CheckSeverity = "blocker" | "warning" | "info";
export type CheckState = CheckSeverity | "passed";

export type ReadinessCheck = {
  id: string;
  group: ReadinessGroup;
  title: string;
  state: CheckState;
  /** What is true right now, in one or two sentences. */
  detail: string;
  /** Why this matters — which workflow depends on it. Always present. */
  because: string;
  /** Where to fix it. */
  fixHref: string | null;
  fixLabel: string | null;
  /**
   * A stable digest of what the check saw. An acknowledgement is scoped to this
   * value, so accepting "3 products have no cover image" does not silently keep
   * accepting it once there are eleven.
   */
  fingerprint: string;
  /** Whether acknowledging is offered. A blocker never is. */
  acknowledgeable: boolean;
};

export type ReadinessGroup =
  | "storefront"
  | "commerce"
  | "payments"
  | "communications"
  | "reliability";

export const GROUP_LABELS: Readonly<Record<ReadinessGroup, string>> = {
  storefront: "Storefront and products",
  commerce: "Commerce configuration",
  payments: "Payments and tax",
  communications: "Communications",
  reliability: "Security and reliability",
};

export const STATE_RANK: Readonly<Record<CheckState, number>> = {
  blocker: 0,
  warning: 1,
  info: 2,
  passed: 3,
};

/** One product, reduced to only what readiness asks about. */
export type ReadinessProduct = {
  id: string;
  name: string;
  slug: string | null;
  is_published: boolean | null;
  purchase_mode: string | null;
  /** Named for the column: `products.starting_price_cents`. */
  starting_price_cents: number | null;
  image_url: string | null;
  mediaCount: number;
  category_id: string | null;
  requires_shipping: boolean | null;
  pickup_eligible: boolean | null;
  fulfillment_required: boolean | null;
  inventory_policy: string | null;
  inventory_quantity: number | null;
  made_to_order: boolean | null;
  lead_time_text: string | null;
  short_description: string | null;
};

export type DiscrepancyFinding = {
  orderId: string;
  orderNumber: string;
  kind: "payment_total_mismatch" | "refund_total_mismatch";
  recordedCents: number;
  evidenceCents: number;
  /** True when somebody has recorded a conclusion about it. */
  reviewed: boolean;
};

export type ReadinessEvidence = {
  settings: CommerceSettings;
  products: ReadinessProduct[];
  integrations: readonly IntegrationCheck[];
  email: {
    senderConfigured: boolean;
    replyToConfigured: boolean;
    staffRecipientConfigured: boolean;
    missingTemplates: string[];
    recentFailures: number;
  };
  discrepancies: DiscrepancyFinding[];
  policyPages: { slug: string; present: boolean }[];
  reliability: {
    migrationLedgerAligned: boolean;
    /** Null when the count could not be read. Not the same answer as zero. */
    unprocessedWebhooks: number | null;
    inventoryLedgerMismatches: number;
    backupAcknowledged: boolean;
  };
};

const digest = (...parts: (string | number | boolean | null | undefined)[]) =>
  parts.map((part) => String(part ?? "")).join("|").slice(0, 200);

const hasAddress = (address: { line1: string; city: string; postalCode?: string; country: string } | undefined) =>
  Boolean(address?.line1?.trim() && address?.city?.trim() && address?.country?.trim());

export function buildReadinessChecks(evidence: ReadinessEvidence): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  const add = (check: ReadinessCheck) => checks.push(check);
  const { settings, products } = evidence;

  const published = products.filter((product) => product.is_published);
  const directSellable = published.filter(
    (product) => product.purchase_mode === "direct" || product.purchase_mode === "direct_or_request"
  );

  // ------------------------------------------------------ storefront and products
  add({
    id: "storefront.published_product",
    group: "storefront",
    title: "At least one published product",
    state: published.length > 0 ? "passed" : "blocker",
    detail: published.length > 0
      ? `${published.length} published product(s).`
      : "Nothing is published, so the catalog is empty to a customer.",
    because: "The catalog, the homepage and search all read published products. With none, there is nothing to buy.",
    fixHref: "/staff/catalog",
    fixLabel: "Products",
    fingerprint: digest("published", published.length),
    acknowledgeable: false,
  });

  const missingPrice = directSellable.filter(
    (product) => !product.starting_price_cents || product.starting_price_cents <= 0
  );
  add({
    id: "storefront.direct_price",
    group: "storefront",
    title: "Directly purchasable products have a price",
    state: missingPrice.length === 0 ? "passed" : "blocker",
    detail: missingPrice.length === 0
      ? `All ${directSellable.length} directly purchasable product(s) carry a price.`
      : `${missingPrice.length} product(s) can be bought outright with no price set: ${names(missingPrice)}.`,
    because: "Checkout prices from the live product row. A product with no price cannot produce a total, so the cart refuses it.",
    fixHref: "/staff/catalog",
    fixLabel: "Products",
    fingerprint: digest("price", missingPrice.map((p) => p.id).sort().join(",")),
    acknowledgeable: false,
  });

  const missingCover = published.filter((product) => !product.image_url && product.mediaCount === 0);
  add({
    id: "storefront.cover_image",
    group: "storefront",
    title: "Published products have a cover image",
    state: missingCover.length === 0 ? "passed" : "warning",
    detail: missingCover.length === 0
      ? "Every published product has at least one image."
      : `${missingCover.length} published product(s) have no image and fall back to the brand mark: ${names(missingCover)}.`,
    because: "The catalog card, the cart line and the product gallery all resolve the same image. With none they render a placeholder.",
    fixHref: "/staff/catalog",
    fixLabel: "Products",
    fingerprint: digest("cover", missingCover.map((p) => p.id).sort().join(",")),
    acknowledgeable: true,
  });

  const missingCategory = published.filter((product) => !product.category_id);
  add({
    id: "storefront.category",
    group: "storefront",
    title: "Published products are categorised",
    state: missingCategory.length === 0 ? "passed" : "warning",
    detail: missingCategory.length === 0
      ? "Every published product has a category."
      : `${missingCategory.length} published product(s) have no category: ${names(missingCategory)}.`,
    because: "The catalog sidebar, the breadcrumb and category filtering all read the category. An uncategorised product is only findable by browsing everything.",
    fixHref: "/staff/catalog",
    fixLabel: "Products",
    fingerprint: digest("category", missingCategory.map((p) => p.id).sort().join(",")),
    acknowledgeable: true,
  });

  const badPurchaseMode = published.filter(
    (product) => !["direct", "request_only", "direct_or_request"].includes(String(product.purchase_mode))
  );
  add({
    id: "storefront.purchase_mode",
    group: "storefront",
    title: "Every published product has a valid purchase mode",
    state: badPurchaseMode.length === 0 ? "passed" : "blocker",
    detail: badPurchaseMode.length === 0
      ? "Every published product is buyable, quotable, or both."
      : `${badPurchaseMode.length} product(s) carry an unrecognised purchase mode: ${names(badPurchaseMode)}.`,
    because: "The product page picks its primary action from this. An unrecognised value renders no way to buy or ask.",
    fixHref: "/staff/catalog",
    fixLabel: "Products",
    fingerprint: digest("mode", badPurchaseMode.map((p) => p.id).sort().join(",")),
    acknowledgeable: false,
  });

  // A product that must be fulfilled but can neither ship nor be collected is
  // the pairing pass 9 called out where it is set; here it is a blocker,
  // because checkout refuses it outright.
  const unfulfillable = directSellable.filter(
    (product) => product.fulfillment_required !== false && !product.requires_shipping && !product.pickup_eligible
  );
  add({
    id: "storefront.fulfillment_eligibility",
    group: "storefront",
    title: "Buyable products can be shipped or collected",
    state: unfulfillable.length === 0 ? "passed" : "blocker",
    detail: unfulfillable.length === 0
      ? "Every buyable product offers at least one delivery route."
      : `${unfulfillable.length} product(s) need fulfilling but can neither ship nor be collected: ${names(unfulfillable)}.`,
    because: "Checkout asks which delivery methods the whole cart supports. A product supporting none makes the cart refuse with \"this order cannot be delivered\".",
    fixHref: "/staff/catalog",
    fixLabel: "Product delivery fields",
    fingerprint: digest("fulfil", unfulfillable.map((p) => p.id).sort().join(",")),
    acknowledgeable: false,
  });

  const trackedNoStock = directSellable.filter(
    (product) =>
      product.inventory_policy === "track" &&
      !product.made_to_order &&
      (product.inventory_quantity ?? 0) <= 0
  );
  add({
    id: "storefront.inventory",
    group: "storefront",
    title: "Tracked products have stock",
    state: trackedNoStock.length === 0 ? "passed" : "warning",
    detail: trackedNoStock.length === 0
      ? "No tracked, buyable product is at zero."
      : `${trackedNoStock.length} tracked product(s) are at zero and will refuse at checkout: ${names(trackedNoStock)}.`,
    because: "Reservations check availability before a Stripe session is created. At zero the customer is refused at the last step.",
    fixHref: "/staff/inventory",
    fixLabel: "Inventory",
    fingerprint: digest("stock", trackedNoStock.map((p) => p.id).sort().join(",")),
    acknowledgeable: true,
  });

  const madeToOrderNoLeadTime = published.filter(
    (product) => product.made_to_order && !product.lead_time_text?.trim()
  );
  add({
    id: "storefront.lead_time",
    group: "storefront",
    title: "Made-to-order products state a lead time",
    state: madeToOrderNoLeadTime.length === 0 ? "passed" : "warning",
    detail: madeToOrderNoLeadTime.length === 0
      ? "Every made-to-order product states how long it takes."
      : `${madeToOrderNoLeadTime.length} made-to-order product(s) state no lead time: ${names(madeToOrderNoLeadTime)}.`,
    because: "A made-to-order product is not on a shelf. Without a stated lead time the customer has no idea whether that is three days or three weeks.",
    fixHref: "/staff/catalog",
    fixLabel: "Products",
    fingerprint: digest("lead", madeToOrderNoLeadTime.map((p) => p.id).sort().join(",")),
    acknowledgeable: true,
  });

  const missingCopy = published.filter((product) => !product.short_description?.trim());
  add({
    id: "storefront.required_content",
    group: "storefront",
    title: "Published products have a summary",
    state: missingCopy.length === 0 ? "passed" : "warning",
    detail: missingCopy.length === 0
      ? "Every published product has a short description."
      : `${missingCopy.length} published product(s) have no short description: ${names(missingCopy)}.`,
    because: "The catalog card, search results and link previews all read the short description.",
    fixHref: "/staff/catalog",
    fixLabel: "Products",
    fingerprint: digest("copy", missingCopy.map((p) => p.id).sort().join(",")),
    acknowledgeable: true,
  });

  // ---------------------------------------------------------- commerce settings
  const anyFulfillment = settings.shipping.enabled || settings.pickup.enabled;
  add({
    id: "commerce.fulfillment_method",
    group: "commerce",
    title: "At least one delivery method is enabled",
    state: anyFulfillment ? "passed" : "blocker",
    detail: anyFulfillment
      ? `${[settings.shipping.enabled && "shipping", settings.pickup.enabled && "local pickup"].filter(Boolean).join(" and ")} enabled.`
      : "Neither shipping nor local pickup is enabled. A cart holding a physical product refuses at checkout.",
    because: "Checkout requires a delivery method for anything that needs fulfilling. Both ship disabled by default so an unconfigured shop cannot invent a delivery price.",
    fixHref: "/staff/settings/commerce",
    fixLabel: "Shipping, pickup & policy",
    fingerprint: digest("fulfilment", settings.shipping.enabled, settings.pickup.enabled),
    acknowledgeable: false,
  });

  const enabledMethods = settings.shipping.methods.filter((method) => method.enabled);
  add({
    id: "commerce.shipping_methods",
    group: "commerce",
    title: "Shipping has at least one enabled method",
    state: !settings.shipping.enabled ? "info" : enabledMethods.length > 0 ? "passed" : "blocker",
    detail: !settings.shipping.enabled
      ? "Shipping is switched off, so no method is needed."
      : enabledMethods.length > 0
        ? `${enabledMethods.length} enabled method(s).`
        : "Shipping is on with no enabled method, so the customer is offered delivery and then refused.",
    because: "The delivery step lists enabled methods and the server reprices the chosen one. With none the cart cannot quote.",
    fixHref: "/staff/settings/commerce",
    fixLabel: "Shipping methods",
    fingerprint: digest("methods", settings.shipping.enabled, enabledMethods.length),
    acknowledgeable: false,
  });

  add({
    id: "commerce.shipping_destinations",
    group: "commerce",
    title: "Shipping has supported destinations",
    state: !settings.shipping.enabled
      ? "info"
      : settings.shipping.destinationCountries.length > 0
        ? "passed"
        : "blocker",
    detail: !settings.shipping.enabled
      ? "Shipping is switched off."
      : settings.shipping.destinationCountries.length > 0
        ? `Ships to ${settings.shipping.destinationCountries.join(", ")}.`
        : "Shipping is on with no supported country, so every address is refused.",
    because: "The address is checked against the supported list before a price is quoted.",
    fixHref: "/staff/settings/commerce",
    fixLabel: "Destinations",
    fingerprint: digest("dest", settings.shipping.enabled, settings.shipping.destinationCountries.join(",")),
    acknowledgeable: false,
  });

  add({
    id: "commerce.origin_address",
    group: "commerce",
    title: "Shipping origin address is set",
    state: !settings.shipping.enabled ? "info" : hasAddress(settings.shipping.originAddress) ? "passed" : "warning",
    detail: !settings.shipping.enabled
      ? "Shipping is switched off, so no origin is needed."
      : hasAddress(settings.shipping.originAddress)
        ? "An origin address is recorded."
        : "No origin address. Orders snapshot a blank origin and labels have no return-to address.",
    because: "Each order snapshots the origin at purchase so a later settings change cannot rewrite where a parcel came from. The street is deliberately never copied onto the order row.",
    fixHref: "/staff/settings/commerce",
    fixLabel: "Origin address",
    fingerprint: digest("origin", settings.shipping.enabled, hasAddress(settings.shipping.originAddress)),
    acknowledgeable: true,
  });

  add({
    id: "commerce.pickup_location",
    group: "commerce",
    title: "Local pickup has a location",
    state: !settings.pickup.enabled
      ? "info"
      : settings.pickup.locationName.trim() && hasAddress(settings.pickup.address)
        ? "passed"
        : "blocker",
    detail: !settings.pickup.enabled
      ? "Local pickup is switched off."
      : settings.pickup.locationName.trim() && hasAddress(settings.pickup.address)
        ? `Collection from ${settings.pickup.locationName}.`
        : "Pickup is on with no named location or no address, so a customer choosing it is told to collect from nowhere.",
    because: "The pickup snapshot on the order and the ready-for-pickup email both read this. The address is withheld from the customer until the order is ready unless that is deliberately turned on.",
    fixHref: "/staff/settings/commerce",
    fixLabel: "Pickup location",
    fingerprint: digest("pickup", settings.pickup.enabled, settings.pickup.locationName, hasAddress(settings.pickup.address)),
    acknowledgeable: false,
  });

  add({
    id: "commerce.return_address",
    group: "commerce",
    title: "Return address is set",
    state: hasAddress(settings.returnAddress) ? "passed" : "warning",
    detail: hasAddress(settings.returnAddress)
      ? "A return address is recorded and is snapshotted when a return is approved."
      : "No return address. Approving a return snapshots nothing, and staff must type the address into the instructions each time.",
    because: "The address is copied onto the return at approval, so a later change cannot redirect a parcel already in the post.",
    fixHref: "/staff/settings/commerce",
    fixLabel: "Return address",
    fingerprint: digest("returnaddr", hasAddress(settings.returnAddress)),
    acknowledgeable: true,
  });

  add({
    id: "commerce.reservation_window",
    group: "commerce",
    title: "Stock hold window is sane",
    state: settings.inventory.reservationMinutes >= 30 ? "passed" : "warning",
    detail: `Checkout holds stock for ${settings.inventory.reservationMinutes} minutes.`,
    because: "The Stripe session is pinned to expire with the hold. Below Stripe's 30-minute floor the session outlives the hold, and a customer can pay for stock already released.",
    fixHref: "/staff/settings/commerce",
    fixLabel: "Inventory rules",
    fingerprint: digest("hold", settings.inventory.reservationMinutes),
    acknowledgeable: true,
  });

  // ------------------------------------------------------------ payments and tax
  const stripe = evidence.integrations.find((check) => check.key === "stripe");
  const stripeBroken = stripe?.status === "not_configured" || stripe?.status === "incomplete";
  add({
    id: "payments.stripe",
    group: "payments",
    title: "Stripe is configured for production",
    state: stripeBroken ? "blocker" : "passed",
    detail: stripe?.summary ?? "Stripe configuration could not be read.",
    because: "Checkout creates a Stripe session and the webhook settles it. Without both the key and the signing secret, money is taken and never recorded here.",
    fixHref: "/staff/integrations",
    fixLabel: "Integration health",
    fingerprint: digest("stripe", stripe?.status),
    acknowledgeable: false,
  });

  const webhookSub = evidence.integrations.find((check) => check.key === "stripe_webhook_events");
  add({
    id: "payments.webhook_events",
    group: "payments",
    title: "Required webhook events have been seen",
    state: webhookSub?.status === "healthy" ? "passed" : "warning",
    detail: webhookSub?.summary ?? "Webhook subscription could not be read.",
    because: "Stripe only delivers what the endpoint subscribes to. A refund issued from the Stripe dashboard never reaches this database unless the refund events are subscribed.",
    fixHref: "/staff/integrations",
    fixLabel: "Integration health",
    fingerprint: digest("webhookevents", webhookSub?.status, webhookSub?.summary),
    acknowledgeable: true,
  });

  const unprocessed = evidence.reliability.unprocessedWebhooks;
  add({
    id: "payments.webhook_processing",
    group: "payments",
    title: "No webhook was left unprocessed",
    // Unknown is a warning, never a pass. "Every webhook completed" has to mean
    // somebody counted them.
    state: unprocessed === null ? "warning" : unprocessed === 0 ? "passed" : "blocker",
    detail: unprocessed === null
      ? "This could not be checked — the webhook log did not answer."
      : unprocessed === 0
        ? "Every received webhook completed."
        : `${unprocessed} received webhook(s) were never marked processed, so an order may have settled at Stripe and not here.`,
    because: "A half-processed payment event is the one failure that leaves the money and the order disagreeing.",
    fixHref: "/staff/reconciliation",
    fixLabel: "Reconciliation",
    fingerprint: digest("unprocessed", unprocessed),
    acknowledgeable: false,
  });

  add({
    id: "payments.stripe_tax",
    group: "payments",
    title: "Stripe Tax is deliberately not enabled",
    // Info, never passed. A tick beside a tax line reads as "tax is handled",
    // which is the single most expensive thing this page could imply.
    state: "info",
    detail:
      "No tax is calculated, collected or reported. Every order records $0.00 tax. This is a recorded owner decision, not an oversight.",
    because: "Enabling it needs Stripe Tax on the account, a tax registration, a product tax code per product and tax-aware refund arithmetic. Registration and filing remain a business obligation that no integration performs.",
    fixHref: "/staff/integrations",
    fixLabel: "Integration health",
    fingerprint: digest("tax", "disabled"),
    acknowledgeable: false,
  });

  add({
    id: "payments.refund_support",
    group: "payments",
    title: "Refunds can be issued and reconciled",
    state: stripeBroken ? "blocker" : "passed",
    detail: stripeBroken
      ? "Refunds depend on the same Stripe configuration, which is incomplete."
      : "Refunds are claimed in Postgres before Stripe is called, and a dashboard-issued refund is adopted by the webhook.",
    because: "Without the claim, two staff reading the same screen can refund the same money twice.",
    fixHref: "/staff/reconciliation",
    fixLabel: "Reconciliation",
    fingerprint: digest("refunds", stripeBroken),
    acknowledgeable: false,
  });

  // ------------------------------------------------------------- communications
  const resend = evidence.integrations.find((check) => check.key === "resend");
  add({
    id: "communications.provider",
    group: "communications",
    title: "Email provider is configured",
    state: resend?.status === "not_configured" ? "blocker" : resend?.status === "failing" ? "blocker" : resend?.status === "incomplete" ? "warning" : "passed",
    detail: resend?.summary ?? "Email configuration could not be read.",
    because: "Every order confirmation, quote, shipping notice and refund notice goes through it. With no key, each one is silently recorded as suppressed.",
    fixHref: "/staff/emails",
    fixLabel: "Email settings",
    fingerprint: digest("resend", resend?.status),
    acknowledgeable: false,
  });

  add({
    id: "communications.sender",
    group: "communications",
    title: "Sender and Reply-To are set",
    state: evidence.email.senderConfigured && evidence.email.replyToConfigured ? "passed" : evidence.email.senderConfigured ? "warning" : "blocker",
    detail: evidence.email.senderConfigured && evidence.email.replyToConfigured
      ? "Both a from address and a reply-to address are configured."
      : evidence.email.senderConfigured
        ? "A from address is set but no reply-to. A customer replying reaches the sending mailbox, which may be unmonitored."
        : "No from address is configured.",
    because: "The from address must be on a domain verified with the provider or the message is refused; the reply-to is where a customer's reply actually lands.",
    fixHref: "/staff/emails",
    fixLabel: "Email settings",
    fingerprint: digest("sender", evidence.email.senderConfigured, evidence.email.replyToConfigured),
    acknowledgeable: false,
  });

  add({
    id: "communications.staff_recipient",
    group: "communications",
    title: "A staff alert address is configured",
    state: evidence.email.staffRecipientConfigured ? "passed" : "warning",
    detail: evidence.email.staffRecipientConfigured
      ? "New requests, new orders, cancellations and returns are emailed to the staff address."
      : "No staff alert address. Those alerts reach the in-app bell only, which needs somebody signed in to see them.",
    because: "A new order arriving overnight is the case this exists for.",
    fixHref: "/staff/emails",
    fixLabel: "Email settings",
    fingerprint: digest("staffemail", evidence.email.staffRecipientConfigured),
    acknowledgeable: true,
  });

  add({
    id: "communications.templates",
    group: "communications",
    title: "Every transactional template is present",
    state: evidence.email.missingTemplates.length === 0 ? "passed" : "warning",
    detail: evidence.email.missingTemplates.length === 0
      ? "Every template the code can send has a row."
      : `${evidence.email.missingTemplates.length} template(s) have no row: ${evidence.email.missingTemplates.join(", ")}. Those still send, with a generic subject and body.`,
    because: "A missing template degrades to a generic message rather than to silence, which is safe but reads as though the shop does not know what it just did.",
    fixHref: "/staff/emails",
    fixLabel: "Edit templates",
    fingerprint: digest("templates", evidence.email.missingTemplates.sort().join(",")),
    acknowledgeable: true,
  });

  add({
    id: "communications.recent_failures",
    group: "communications",
    title: "No recent delivery failures",
    state: evidence.email.recentFailures === 0 ? "passed" : evidence.email.recentFailures > 5 ? "blocker" : "warning",
    detail: evidence.email.recentFailures === 0
      ? "No transactional email has failed in the last 30 days."
      : `${evidence.email.recentFailures} email(s) failed in the last 30 days.`,
    because: "A failed order confirmation is a customer who does not know their order exists. Each one can be re-sent from the delivery history.",
    fixHref: "/staff/emails/deliveries",
    fixLabel: "Delivery history",
    fingerprint: digest("failures", evidence.email.recentFailures),
    acknowledgeable: true,
  });

  // --------------------------------------------------- security and reliability
  add({
    id: "reliability.migration_ledger",
    group: "reliability",
    title: "Migration ledger matches the repository",
    state: evidence.reliability.migrationLedgerAligned ? "passed" : "warning",
    detail: evidence.reliability.migrationLedgerAligned
      ? "Every migration file has exactly one recorded row under the same version."
      : "The ledger and the repository disagree. That is a bookkeeping fault; check the objects themselves before assuming the schema is wrong.",
    because: "A drifted ledger makes the next migration unpredictable and has already caused three separate repairs in this project.",
    fixHref: "/staff/integrations",
    fixLabel: "Integration health",
    fingerprint: digest("ledger", evidence.reliability.migrationLedgerAligned),
    acknowledgeable: true,
  });

  add({
    id: "reliability.inventory_ledger",
    group: "reliability",
    title: "Stock agrees with its own ledger",
    state: evidence.reliability.inventoryLedgerMismatches === 0 ? "passed" : "warning",
    detail: evidence.reliability.inventoryLedgerMismatches === 0
      ? "Every tracked product's count matches the movements recorded against it."
      : `${evidence.reliability.inventoryLedgerMismatches} product(s) disagree with their movement history.`,
    because: "Reservations and availability are computed from the count. A count that its own history cannot explain means either an untracked edit or a lost movement.",
    fixHref: "/staff/reconciliation",
    fixLabel: "Reconciliation",
    fingerprint: digest("invledger", evidence.reliability.inventoryLedgerMismatches),
    acknowledgeable: true,
  });

  /**
   * Historical payment discrepancies.
   *
   * KM-0001 and KM-0002 record collected amounts with no payment rows behind
   * them. They are **warnings that need a person**, never something this page
   * repairs: a missing payment row does not prove no payment was taken, and
   * writing one to make a report go green would put a fabricated financial
   * record in the ledger. Reviewing one records a conclusion; it changes no
   * money.
   */
  const unreviewed = evidence.discrepancies.filter((finding) => !finding.reviewed);
  add({
    id: "reliability.payment_discrepancies",
    group: "reliability",
    title: "Historical payment discrepancies are reviewed",
    state: evidence.discrepancies.length === 0 ? "passed" : unreviewed.length === 0 ? "info" : "warning",
    detail: evidence.discrepancies.length === 0
      ? "No order's recorded total disagrees with its payment rows."
      : unreviewed.length === 0
        ? `${evidence.discrepancies.length} historical discrepancy(ies), all reviewed and explained: ${evidence.discrepancies.map((f) => f.orderNumber).join(", ")}.`
        : `${unreviewed.length} historical discrepancy(ies) awaiting review: ${unreviewed.map((f) => f.orderNumber).join(", ")}.`,
    because: "These are almost certainly early or manual orders that predate the atomic payment accounting. Nothing automated touches them, and reviewing one records a conclusion rather than changing a number.",
    fixHref: "/staff/launch-readiness/discrepancies",
    fixLabel: "Review discrepancies",
    fingerprint: digest("discrepancies", evidence.discrepancies.map((f) => `${f.orderNumber}:${f.reviewed}`).sort().join(",")),
    acknowledgeable: true,
  });

  const turnstile = evidence.integrations.find((check) => check.key === "turnstile");
  add({
    id: "reliability.turnstile",
    group: "reliability",
    title: "Bot protection on public forms",
    state: turnstile?.status === "healthy" ? "passed" : turnstile?.status === "incomplete" ? "warning" : "info",
    detail: turnstile?.summary ?? "Turnstile configuration could not be read.",
    because: "Public request forms are reachable without an account. Rate limiting alone slows a flood; it does not stop one.",
    fixHref: "/staff/integrations",
    fixLabel: "Integration health",
    fingerprint: digest("turnstile", turnstile?.status),
    acknowledgeable: true,
  });

  const sentry = evidence.integrations.find((check) => check.key === "sentry");
  add({
    id: "reliability.sentry",
    group: "reliability",
    title: "Exception reporting",
    state: sentry?.status === "healthy" ? "passed" : "warning",
    detail: sentry?.summary ?? "Sentry configuration could not be read.",
    because: "Without it, a server exception in a payment path is visible only in platform logs somebody has to think to open.",
    fixHref: "/staff/integrations",
    fixLabel: "Integration health",
    fingerprint: digest("sentry", sentry?.status),
    acknowledgeable: true,
  });

  add({
    id: "reliability.backups",
    group: "reliability",
    title: "Backup and restore acknowledged",
    // Deliberately never `passed` from evidence: this application cannot see
    // the platform's backup schedule, and claiming a backup exists because a
    // checkbox was ticked would be the most dangerous false green on the page.
    state: evidence.reliability.backupAcknowledged ? "info" : "warning",
    detail: evidence.reliability.backupAcknowledged
      ? "An owner has acknowledged that backups and a restore path have been checked. This application cannot verify that; the acknowledgement records who checked and when."
      : "Nobody has recorded checking that database backups exist and can be restored.",
    because: "Every order, payment and customer record lives in one database. This application has no visibility of the platform's backup schedule and will never claim it does.",
    fixHref: "https://supabase.com/dashboard/project/_/database/backups",
    fixLabel: "Supabase backups",
    fingerprint: digest("backups", evidence.reliability.backupAcknowledged),
    acknowledgeable: true,
  });

  const missingPolicies = evidence.policyPages.filter((page) => !page.present);
  add({
    id: "reliability.policy_pages",
    group: "reliability",
    title: "Policy pages are published",
    state: missingPolicies.length === 0 ? "passed" : "warning",
    detail: missingPolicies.length === 0
      ? "Every policy page the footer links to resolves."
      : `${missingPolicies.length} policy page(s) are missing: ${missingPolicies.map((page) => page.slug).join(", ")}.`,
    because: "The footer and the checkout both link to these. A customer following one to a 404 immediately before paying is the worst possible moment for it.",
    fixHref: "/staff/catalog",
    fixLabel: "Content",
    fingerprint: digest("policies", missingPolicies.map((page) => page.slug).sort().join(",")),
    acknowledgeable: true,
  });

  return checks;
}

/** Apply recorded acknowledgements. A blocker is never silenced, whatever was recorded. */
export function applyAcknowledgements(
  checks: readonly ReadinessCheck[],
  acknowledgements: readonly { check_id: string; fingerprint: string }[]
): (ReadinessCheck & { acknowledged: boolean; acknowledgementStale: boolean })[] {
  const byId = new Map(acknowledgements.map((ack) => [ack.check_id, ack.fingerprint]));
  return checks.map((check) => {
    const recorded = byId.get(check.id);
    // A blocker cannot be acknowledged away. If the shop is broken, the page
    // says so however many times somebody has ticked it off.
    const acknowledged = Boolean(recorded) && check.acknowledgeable && check.state !== "blocker";
    return {
      ...check,
      acknowledged,
      // The situation moved since somebody accepted it, so the acceptance no
      // longer describes what is on screen.
      acknowledgementStale: Boolean(recorded) && recorded !== check.fingerprint,
    };
  });
}

export function summarizeReadiness(
  checks: readonly (ReadinessCheck & { acknowledged?: boolean })[]
) {
  const live = (state: CheckState) =>
    checks.filter((check) => check.state === state && !(check.acknowledged && state !== "blocker")).length;
  return {
    blockers: checks.filter((check) => check.state === "blocker").length,
    warnings: live("warning"),
    acknowledged: checks.filter((check) => check.acknowledged).length,
    info: checks.filter((check) => check.state === "info").length,
    passed: checks.filter((check) => check.state === "passed").length,
    total: checks.length,
    /** True only when nothing is broken. Warnings do not block; blockers do. */
    readyToLaunch: checks.every((check) => check.state !== "blocker"),
  };
}

function names(products: readonly ReadinessProduct[], max = 3): string {
  const shown = products.slice(0, max).map((product) => product.name);
  const rest = products.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}
