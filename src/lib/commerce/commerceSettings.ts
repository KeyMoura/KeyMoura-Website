/**
 * Commerce settings — shipping, local pickup, inventory and email, stated once.
 *
 * Pure and dependency-free, exactly like `orderLifecycle.ts`, because the
 * checkout route, the staff settings form, the customer order page, the
 * printable documents and the tests all import these definitions. A shipping
 * price computed one way in the cart and another way at checkout is not a
 * rounding difference, it is a customer charged an amount they never saw.
 *
 * Anything needing the database belongs in `commerceSettingsServer.ts`.
 *
 * Reminder timing lives in `lib/automation/settings.ts` and is folded in here as
 * `automation`, so one settings read serves checkout and the worker alike.
 *
 * Three separate addresses, on purpose. The shop's *origin* address is where
 * parcels are posted from, the *return* address is where they come back to,
 * and the *pickup* address is where a customer is invited to stand. For a
 * business run out of a home these are frequently the same building, and
 * publishing one because another was configured is how a private address ends
 * up on a public page. `publicCommerceSettings` is the only thing a customer
 * surface may read, and it carries no origin address at all.
 */

/*
 * The one import this module has, and it is to another pure module.
 *
 * Relative and extension-bearing so the file stays loadable by
 * `node --experimental-strip-types`, the same convention `permissions.ts` uses
 * for `./roles.ts`. A path alias here would make the four tests that import this
 * file need a resolver they currently do without.
 */
import {
  DEFAULT_AUTOMATION_SETTINGS,
  parseAutomationSettings,
  type AutomationSettings,
} from "../automation/settings.ts";

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export type Address = {
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  phone: string;
};

export const EMPTY_ADDRESS: Address = {
  name: "",
  line1: "",
  line2: "",
  city: "",
  region: "",
  postalCode: "",
  country: "US",
  phone: "",
};

/**
 * The keys an address has actually been *stored* under, which is not the same
 * set as the ones `Address` declares.
 *
 * `orders.shipping_address` is `jsonb` with no shape constraint, and it has
 * been written by more than one generation of this code. Orders placed before
 * the current checkout carry Stripe's own naming — `state` and `postal_code`
 * — and carry no `region`, `postalCode` or `phone` at all. `Address` says every
 * field is a `string`; for those rows several of them are `undefined`, and a
 * formatter that believed the type crashed on the first `.trim()`.
 *
 * Aliases rather than a migration: the rows are correct, they are simply older
 * than the names. Rewriting historical order snapshots to satisfy a formatter
 * would edit what a customer was actually told at purchase time.
 */
const ADDRESS_KEY_ALIASES: Readonly<Record<keyof Address, readonly string[]>> = {
  // `originName` is how `shipping_origin_snapshot` names the shop itself, and
  // the packing slip renders that snapshot through this same formatter.
  name: ["name", "fullName", "full_name", "recipient", "originName", "locationName"],
  line1: ["line1", "line_1", "address1", "address_line1"],
  line2: ["line2", "line_2", "address2", "address_line2"],
  city: ["city", "locality"],
  region: ["region", "state", "province"],
  postalCode: ["postalCode", "postal_code", "zip", "zipcode", "postcode"],
  country: ["country", "country_code"],
  phone: ["phone", "telephone"],
};

const asAddressRecord = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

/**
 * Any stored address-shaped JSON, read as an `Address`.
 *
 * Total: every field is a trimmed string afterwards, whatever went in. This is
 * the boundary where "a column with no shape" becomes "a type", and it is the
 * only place allowed to assume anything about what a historical row contains.
 */
export function coerceStoredAddress(raw: unknown): Address {
  const record = asAddressRecord(raw);
  const pick = (field: keyof Address): string => {
    for (const key of ADDRESS_KEY_ALIASES[field]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    return "";
  };
  return {
    name: pick("name"),
    line1: pick("line1"),
    line2: pick("line2"),
    city: pick("city"),
    region: pick("region"),
    postalCode: pick("postalCode"),
    country: pick("country"),
    phone: pick("phone"),
  };
}

/** Enough of an address to actually post a parcel to. */
export function isDeliverableAddress(address: Address | null | undefined): boolean {
  if (!address) return false;
  const parts = coerceStoredAddress(address);
  return Boolean(parts.name && parts.line1 && parts.city && parts.postalCode && parts.country);
}

/**
 * One-line rendering for confirmations and printed documents.
 *
 * Reads through `coerceStoredAddress`, so a legacy `state`/`postal_code` row
 * renders its state and postcode rather than merely failing to crash — the
 * point is that the customer still sees the address they gave.
 */
export function formatAddressLines(address: Address | null | undefined): string[] {
  return formatStoredAddressLines(address);
}

/**
 * The same rendering, for a value straight out of a `jsonb` column.
 *
 * Separate entry point so call sites reading the database say so, instead of
 * casting through `as unknown as Address` — a cast that asserted exactly the
 * thing that was not true and hid this defect from the type checker.
 */
export function formatStoredAddressLines(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const address = coerceStoredAddress(raw);
  const region = [address.city, address.region].filter(Boolean).join(", ");
  return [
    address.name,
    address.line1,
    address.line2,
    [region, address.postalCode].filter(Boolean).join(" "),
    address.country,
  ].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Pickup location snapshots
// ---------------------------------------------------------------------------

/**
 * What `orders.pickup_location_snapshot` actually holds.
 *
 * Deliberately **not** an `Address`: it is written by `planFulfillment` as a
 * location name plus *already formatted* address lines, because the shop's
 * pickup address is rendered once at purchase time and then frozen. Feeding it
 * to the address formatter was the defect — the two types share no field
 * names, so every lookup missed and the first `.trim()` threw.
 */
export type PickupLocationSnapshot = {
  locationName: string;
  addressLines: string[];
  instructions: string;
  hoursText: string;
  requireConfirmation: boolean;
};

/** A stored pickup snapshot, or null when the order predates local pickup. */
export function coercePickupSnapshot(raw: unknown): PickupLocationSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const lines = Array.isArray(record.addressLines)
    ? record.addressLines.map(text).filter(Boolean)
    : [];
  const locationName = text(record.locationName);
  // `locationName` and `addressLines` are the two keys only a pickup snapshot
  // has; neither present means this is some other shape, and saying so lets
  // the caller fall back instead of rendering an empty location. Deliberately
  // not falling back to `name` — an ordinary address has one, and reading it
  // would turn a delivery recipient into a collection point.
  if (!locationName && !lines.length) return null;
  return {
    locationName,
    addressLines: lines,
    instructions: text(record.instructions),
    hoursText: text(record.hoursText),
    requireConfirmation: record.requireConfirmation === true,
  };
}

/**
 * Where a customer is being asked to stand, as display lines.
 *
 * Falls back to reading the value as an address, so a snapshot written in some
 * other shape still renders something truthful instead of nothing.
 */
export function formatPickupLocationLines(raw: unknown): string[] {
  const snapshot = coercePickupSnapshot(raw);
  if (!snapshot) return formatStoredAddressLines(raw);
  return [snapshot.locationName, ...snapshot.addressLines].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Shipping methods
// ---------------------------------------------------------------------------

export type ShippingMethod = {
  /** Stable across edits: an order's snapshot refers to it. */
  id: string;
  name: string;
  description: string;
  priceCents: number;
  /** null means this method is never free on subtotal alone. */
  freeThresholdCents: number | null;
  deliveryEstimate: string;
  enabled: boolean;
};

export type TrackingTemplate = {
  carrier: string;
  label: string;
  /** Must contain `{tracking}` and be an https URL. */
  urlTemplate: string;
};

/**
 * Carrier tracking links are generated from templates rather than pasted,
 * because a pasted URL is attacker-controlled text that this application then
 * renders as a link on a customer's order page.
 */
export const DEFAULT_TRACKING_TEMPLATES: TrackingTemplate[] = [
  { carrier: "usps", label: "USPS", urlTemplate: "https://tools.usps.com/go/TrackConfirmAction?tLabels={tracking}" },
  { carrier: "ups", label: "UPS", urlTemplate: "https://www.ups.com/track?tracknum={tracking}" },
  { carrier: "fedex", label: "FedEx", urlTemplate: "https://www.fedex.com/fedextrack/?trknbr={tracking}" },
  { carrier: "dhl", label: "DHL", urlTemplate: "https://www.dhl.com/en/express/tracking.html?AWB={tracking}" },
];

// ---------------------------------------------------------------------------
// The settings shape
// ---------------------------------------------------------------------------

export type CommerceSettings = {
  business: {
    publicName: string;
    supportEmail: string;
    timezone: string;
    /** Lowercase ISO-4217. Only `usd` is wired end to end; see the ledger. */
    currency: string;
  };
  shipping: {
    enabled: boolean;
    originName: string;
    originAddress: Address;
    /** Uppercase ISO-3166-1 alpha-2. Empty means nowhere is supported. */
    destinationCountries: string[];
    /** country -> allowed region codes. An absent or empty list means "all". */
    destinationRegions: Record<string, string[]>;
    methods: ShippingMethod[];
    /** Applies across every method when set; a method's own threshold wins if lower. */
    freeShippingThresholdCents: number | null;
    availableForDirectOrders: boolean;
    availableForCustomOrders: boolean;
    defaultPackageWeightGrams: number;
    defaultPackageLengthMm: number;
    defaultPackageWidthMm: number;
    defaultPackageHeightMm: number;
    trackingTemplates: TrackingTemplate[];
    handlingNote: string;
  };
  pickup: {
    enabled: boolean;
    locationName: string;
    address: Address;
    instructions: string;
    hoursText: string;
    notifyWhenReady: boolean;
    requireConfirmation: boolean;
    /**
     * Off by default. Until an order is ready, a customer has no reason to be
     * given the address of the building the stock is in.
     */
    revealAddressBeforeReady: boolean;
  };
  inventory: {
    trackByDefault: boolean;
    lowStockThresholdDefault: number;
    /** How long a checkout holds stock. Clamped to Stripe's 30-minute floor. */
    reservationMinutes: number;
    backordersByDefault: boolean;
    allowOverselling: boolean;
    releaseOnPaymentFailure: boolean;
    lowStockRecipients: string[];
  };
  email: {
    senderName: string;
    replyTo: string;
    staffAlertRecipients: string[];
    categories: {
      orders: boolean;
      production: boolean;
      fulfillment: boolean;
      cancellations: boolean;
      returns: boolean;
      staffAlerts: boolean;
    };
  };
  /**
   * Who may buy and who may ask.
   *
   * Both default **on**, unlike shipping and pickup. Those default off because
   * an unconfigured shop must not invent a delivery price; there is no
   * equivalent hazard in letting somebody buy without first making an account,
   * and requiring one is the thing the owner asked to remove. The switches
   * exist so turning it back off is a setting rather than a deploy.
   */
  guest: {
    allowCheckout: boolean;
    allowRequests: boolean;
  };
  /**
   * Scheduled reminder timing. Shape and defaults live in
   * `lib/automation/settings.ts`, which is imported rather than restated so the
   * worker and this form cannot disagree about what "3 days" means.
   */
  automation: AutomationSettings;
  returnAddress: Address;
};

/**
 * Safe defaults: shipping and pickup are **off** until the owner configures
 * them. A default-on shipping method with a $0 price and no origin address
 * would let a customer check out for delivery to an address the shop cannot
 * post to, which is worse than an unconfigured shop refusing clearly.
 */
export const DEFAULT_COMMERCE_SETTINGS: CommerceSettings = {
  business: {
    publicName: "KeyMoura",
    supportEmail: "support@keymoura.com",
    timezone: "America/New_York",
    currency: "usd",
  },
  shipping: {
    enabled: false,
    originName: "",
    originAddress: { ...EMPTY_ADDRESS },
    destinationCountries: ["US"],
    destinationRegions: {},
    methods: [],
    freeShippingThresholdCents: null,
    availableForDirectOrders: true,
    availableForCustomOrders: true,
    defaultPackageWeightGrams: 0,
    defaultPackageLengthMm: 0,
    defaultPackageWidthMm: 0,
    defaultPackageHeightMm: 0,
    trackingTemplates: DEFAULT_TRACKING_TEMPLATES,
    handlingNote: "",
  },
  pickup: {
    enabled: false,
    locationName: "",
    address: { ...EMPTY_ADDRESS },
    instructions: "",
    hoursText: "",
    notifyWhenReady: true,
    requireConfirmation: false,
    revealAddressBeforeReady: false,
  },
  inventory: {
    trackByDefault: false,
    lowStockThresholdDefault: 2,
    reservationMinutes: 60,
    backordersByDefault: false,
    allowOverselling: false,
    releaseOnPaymentFailure: true,
    lowStockRecipients: [],
  },
  email: {
    senderName: "KeyMoura",
    replyTo: "support@keymoura.com",
    staffAlertRecipients: [],
    categories: {
      orders: true,
      production: true,
      fulfillment: true,
      cancellations: true,
      returns: true,
      staffAlerts: true,
    },
  },
  guest: {
    allowCheckout: true,
    allowRequests: true,
  },
  automation: DEFAULT_AUTOMATION_SETTINGS,
  returnAddress: { ...EMPTY_ADDRESS },
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const text = (value: unknown, max: number, fallback = "") =>
  typeof value === "string" ? value.slice(0, max) : fallback;

const trimmed = (value: unknown, max: number, fallback = "") => text(value, max, fallback).trim();

const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

const boundedInt = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
};

const nullableCents = (value: unknown, fallback: number | null): number | null => {
  if (value === null) return null;
  if (value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(100_000_00, Math.trunc(parsed));
};

export function parseAddress(raw: unknown, fallback: Address = EMPTY_ADDRESS): Address {
  const record = asRecord(raw);
  return {
    name: trimmed(record.name, 120, fallback.name),
    line1: trimmed(record.line1, 200, fallback.line1),
    line2: trimmed(record.line2, 200, fallback.line2),
    city: trimmed(record.city, 120, fallback.city),
    region: trimmed(record.region, 120, fallback.region),
    postalCode: trimmed(record.postalCode, 32, fallback.postalCode),
    country: (trimmed(record.country, 2, fallback.country) || "US").toUpperCase(),
    phone: trimmed(record.phone, 40, fallback.phone),
  };
}

/**
 * A method id must survive being put in a URL, an HTML attribute and an order
 * snapshot, so it is reduced to a slug rather than validated and rejected.
 */
export function normalizeMethodId(raw: unknown, index: number): string {
  const slug = trimmed(raw, 40)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `method-${index + 1}`;
}

function parseShippingMethods(raw: unknown): ShippingMethod[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const methods: ShippingMethod[] = [];
  for (const [index, entry] of raw.slice(0, 20).entries()) {
    const record = asRecord(entry);
    const name = trimmed(record.name, 80);
    if (!name) continue;
    let id = normalizeMethodId(record.id ?? name, index);
    // Two methods sharing an id would make an order's snapshot ambiguous about
    // which one the customer actually chose.
    while (seen.has(id)) id = `${id}-${seen.size + 1}`;
    seen.add(id);
    methods.push({
      id,
      name,
      description: trimmed(record.description, 240),
      priceCents: boundedInt(record.priceCents, 0, 0, 100_000_00),
      freeThresholdCents: nullableCents(record.freeThresholdCents, null),
      deliveryEstimate: trimmed(record.deliveryEstimate, 120),
      enabled: bool(record.enabled, true),
    });
  }
  return methods;
}

/** Only https, and only a template that actually has somewhere to put the number. */
export function isValidTrackingTemplate(urlTemplate: string): boolean {
  if (!urlTemplate.includes("{tracking}")) return false;
  let parsed: URL;
  try {
    parsed = new URL(urlTemplate.replace("{tracking}", "TRACKINGNUMBER"));
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && Boolean(parsed.hostname);
}

function parseTrackingTemplates(raw: unknown): TrackingTemplate[] {
  if (!Array.isArray(raw)) return DEFAULT_TRACKING_TEMPLATES;
  const templates: TrackingTemplate[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, 24)) {
    const record = asRecord(entry);
    const carrier = trimmed(record.carrier, 40).toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const urlTemplate = trimmed(record.urlTemplate, 500);
    if (!carrier || seen.has(carrier)) continue;
    if (!isValidTrackingTemplate(urlTemplate)) continue;
    seen.add(carrier);
    templates.push({ carrier, label: trimmed(record.label, 60) || carrier.toUpperCase(), urlTemplate });
  }
  return templates;
}

const emailList = (raw: unknown, max: number): string[] => {
  const source = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\s;]+/) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of source) {
    const value = trimmed(entry, 200).toLowerCase();
    // Deliberately loose: this is a delivery target, not an identity claim.
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
};

const countryList = (raw: unknown, fallback: string[]): string[] => {
  if (!Array.isArray(raw)) return fallback;
  const seen = new Set<string>();
  for (const entry of raw.slice(0, 250)) {
    const code = trimmed(entry, 2).toUpperCase();
    if (/^[A-Z]{2}$/.test(code)) seen.add(code);
  }
  return [...seen];
};

/**
 * Total: any input at all yields usable settings. The column has only an
 * object CHECK behind it, so a hand-edited row must not be able to make the
 * shop unable to quote a price — it degrades to the safe defaults instead.
 */
export function parseCommerceSettings(raw: unknown): CommerceSettings {
  const root = asRecord(raw);
  const defaults = DEFAULT_COMMERCE_SETTINGS;
  const business = asRecord(root.business);
  const shipping = asRecord(root.shipping);
  const pickup = asRecord(root.pickup);
  const inventory = asRecord(root.inventory);
  const email = asRecord(root.email);
  const categories = asRecord(email.categories);
  const guest = asRecord(root.guest);

  const regionsRaw = asRecord(shipping.destinationRegions);
  const destinationRegions: Record<string, string[]> = {};
  for (const [country, values] of Object.entries(regionsRaw).slice(0, 250)) {
    const code = country.slice(0, 2).toUpperCase();
    if (!/^[A-Z]{2}$/.test(code) || !Array.isArray(values)) continue;
    const regions = [...new Set(values.slice(0, 100).map((v) => trimmed(v, 60).toUpperCase()).filter(Boolean))];
    if (regions.length) destinationRegions[code] = regions;
  }

  return {
    business: {
      publicName: trimmed(business.publicName, 120) || defaults.business.publicName,
      supportEmail: trimmed(business.supportEmail, 200) || defaults.business.supportEmail,
      timezone: trimmed(business.timezone, 60) || defaults.business.timezone,
      currency: (trimmed(business.currency, 3) || defaults.business.currency).toLowerCase(),
    },
    shipping: {
      enabled: bool(shipping.enabled, defaults.shipping.enabled),
      originName: trimmed(shipping.originName, 120),
      originAddress: parseAddress(shipping.originAddress),
      destinationCountries: countryList(shipping.destinationCountries, defaults.shipping.destinationCountries),
      destinationRegions,
      methods: parseShippingMethods(shipping.methods),
      freeShippingThresholdCents: nullableCents(shipping.freeShippingThresholdCents, null),
      availableForDirectOrders: bool(shipping.availableForDirectOrders, true),
      availableForCustomOrders: bool(shipping.availableForCustomOrders, true),
      defaultPackageWeightGrams: boundedInt(shipping.defaultPackageWeightGrams, 0, 0, 1_000_000),
      defaultPackageLengthMm: boundedInt(shipping.defaultPackageLengthMm, 0, 0, 100_000),
      defaultPackageWidthMm: boundedInt(shipping.defaultPackageWidthMm, 0, 0, 100_000),
      defaultPackageHeightMm: boundedInt(shipping.defaultPackageHeightMm, 0, 0, 100_000),
      trackingTemplates: parseTrackingTemplates(shipping.trackingTemplates),
      handlingNote: text(shipping.handlingNote, 1000),
    },
    pickup: {
      enabled: bool(pickup.enabled, defaults.pickup.enabled),
      locationName: trimmed(pickup.locationName, 120),
      address: parseAddress(pickup.address),
      instructions: text(pickup.instructions, 2000),
      hoursText: text(pickup.hoursText, 1000),
      notifyWhenReady: bool(pickup.notifyWhenReady, true),
      requireConfirmation: bool(pickup.requireConfirmation, false),
      revealAddressBeforeReady: bool(pickup.revealAddressBeforeReady, false),
    },
    inventory: {
      trackByDefault: bool(inventory.trackByDefault, defaults.inventory.trackByDefault),
      lowStockThresholdDefault: boundedInt(inventory.lowStockThresholdDefault, 2, 0, 10_000),
      // Stripe refuses a Checkout Session expiry under 30 minutes, and a hold
      // that outlives its session is a hold nothing will ever release.
      reservationMinutes: boundedInt(inventory.reservationMinutes, 60, 30, 1440),
      backordersByDefault: bool(inventory.backordersByDefault, false),
      allowOverselling: bool(inventory.allowOverselling, false),
      releaseOnPaymentFailure: bool(inventory.releaseOnPaymentFailure, true),
      lowStockRecipients: emailList(inventory.lowStockRecipients, 10),
    },
    email: {
      senderName: trimmed(email.senderName, 80) || defaults.email.senderName,
      replyTo: trimmed(email.replyTo, 200) || defaults.email.replyTo,
      staffAlertRecipients: emailList(email.staffAlertRecipients, 10),
      categories: {
        orders: bool(categories.orders, true),
        production: bool(categories.production, true),
        fulfillment: bool(categories.fulfillment, true),
        cancellations: bool(categories.cancellations, true),
        returns: bool(categories.returns, true),
        staffAlerts: bool(categories.staffAlerts, true),
      },
    },
    guest: {
      allowCheckout: bool(guest.allowCheckout, defaults.guest.allowCheckout),
      allowRequests: bool(guest.allowRequests, defaults.guest.allowRequests),
    },
    automation: parseAutomationSettings(root.automation),
    returnAddress: parseAddress(root.returnAddress),
  };
}

// ---------------------------------------------------------------------------
// The public projection
// ---------------------------------------------------------------------------

export type PublicCommerceSettings = {
  businessName: string;
  supportEmail: string;
  currency: string;
  shipping: {
    enabled: boolean;
    destinationCountries: string[];
    destinationRegions: Record<string, string[]>;
    methods: ShippingMethod[];
    freeShippingThresholdCents: number | null;
    handlingNote: string;
  };
  pickup: {
    enabled: boolean;
    locationName: string;
    instructions: string;
    hoursText: string;
    /** Present only when policy allows it before the order is ready. */
    addressLines: string[] | null;
  };
  /**
   * Safe to publish: whether a visitor may buy or ask without an account is
   * something the cart and the request form have to render, and it reveals
   * nothing a customer could not learn by pressing the button.
   */
  guest: {
    allowCheckout: boolean;
    allowRequests: boolean;
  };
};

/**
 * Everything a customer surface is allowed to see.
 *
 * The origin address, the return address, staff recipients, inventory
 * thresholds and reservation timings are all absent by construction rather
 * than by remembering to omit them at each call site. The pickup address is
 * included only when `revealAddressBeforeReady` is on — otherwise the customer
 * gets it in the ready-for-pickup message, which is the moment it is useful.
 */
export function publicCommerceSettings(
  settings: CommerceSettings,
  options: { pickupReady?: boolean } = {}
): PublicCommerceSettings {
  const revealPickup = settings.pickup.revealAddressBeforeReady || options.pickupReady === true;
  return {
    businessName: settings.business.publicName,
    supportEmail: settings.business.supportEmail,
    currency: settings.business.currency,
    shipping: {
      enabled: settings.shipping.enabled,
      destinationCountries: settings.shipping.destinationCountries,
      destinationRegions: settings.shipping.destinationRegions,
      methods: settings.shipping.methods.filter((method) => method.enabled),
      freeShippingThresholdCents: settings.shipping.freeShippingThresholdCents,
      handlingNote: settings.shipping.handlingNote,
    },
    pickup: {
      enabled: settings.pickup.enabled,
      locationName: settings.pickup.locationName,
      instructions: settings.pickup.instructions,
      hoursText: settings.pickup.hoursText,
      addressLines: revealPickup && settings.pickup.enabled ? formatAddressLines(settings.pickup.address) : null,
    },
    guest: { ...settings.guest },
  };
}

// ---------------------------------------------------------------------------
// Destination eligibility
// ---------------------------------------------------------------------------

export type DestinationCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether the shop posts to this address. Re-run server-side at checkout: a
 * country list rendered into a form is a suggestion, not a control.
 */
export function checkDestination(settings: CommerceSettings, address: Address): DestinationCheck {
  if (!settings.shipping.enabled) {
    return { ok: false, reason: "Shipping is not available right now." };
  }
  const country = (address.country || "").toUpperCase();
  if (!country) return { ok: false, reason: "Choose a destination country." };
  if (!settings.shipping.destinationCountries.includes(country)) {
    return { ok: false, reason: "We do not ship to that country yet. Send a message and we will see what we can do." };
  }
  const regions = settings.shipping.destinationRegions[country];
  if (regions?.length) {
    const region = (address.region || "").toUpperCase();
    if (!region) return { ok: false, reason: "Choose a destination state or region." };
    if (!regions.includes(region)) {
      return { ok: false, reason: "We do not ship to that state or region yet. Send a message and we will see what we can do." };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Fulfillment methods and quoting
// ---------------------------------------------------------------------------

export const FULFILLMENT_METHODS = ["shipping", "pickup", "none"] as const;
export type FulfillmentMethod = (typeof FULFILLMENT_METHODS)[number];

/** What a cart needs from its items to be quoted. */
export type QuotableLine = {
  productId: string;
  productName: string;
  quantity: number;
  requiresShipping: boolean;
  pickupEligible: boolean;
  fulfillmentRequired: boolean;
};

export type MethodAvailability = {
  method: FulfillmentMethod;
  available: boolean;
  reason: string;
};

/**
 * Which fulfillment methods this cart may use.
 *
 * `none` is offered only when *nothing* in the cart needs fulfilling, never as
 * a way to skip an address on a cart that contains a physical part.
 */
export function availableFulfillmentMethods(
  settings: CommerceSettings,
  lines: QuotableLine[],
  options: { orderKind?: "direct_purchase" | "custom_request" } = {}
): MethodAvailability[] {
  const direct = (options.orderKind ?? "direct_purchase") === "direct_purchase";
  const anyPhysical = lines.some((line) => line.fulfillmentRequired);
  const shippingAllowedForKind = direct
    ? settings.shipping.availableForDirectOrders
    : settings.shipping.availableForCustomOrders;
  const needsShipping = lines.filter((line) => line.fulfillmentRequired && line.requiresShipping);
  const pickupBlocked = lines.filter((line) => line.fulfillmentRequired && !line.pickupEligible);

  return [
    {
      method: "shipping",
      available:
        anyPhysical && settings.shipping.enabled && shippingAllowedForKind && settings.shipping.methods.some((m) => m.enabled),
      reason: !anyPhysical
        ? "Nothing in this order needs shipping."
        : !settings.shipping.enabled
          ? "Shipping is not available right now."
          : !shippingAllowedForKind
            ? "Shipping is not offered for this kind of order."
            : !settings.shipping.methods.some((m) => m.enabled)
              ? "No shipping methods are configured."
              : needsShipping.length
                ? ""
                : "",
    },
    {
      method: "pickup",
      available: anyPhysical && settings.pickup.enabled && pickupBlocked.length === 0,
      reason: !anyPhysical
        ? "Nothing in this order needs collecting."
        : !settings.pickup.enabled
          ? "Local pickup is not available right now."
          : pickupBlocked.length
            ? `${pickupBlocked[0].productName} is not available for local pickup.`
            : "",
    },
    {
      method: "none",
      available: !anyPhysical,
      reason: anyPhysical ? "This order contains items that have to be delivered." : "",
    },
  ];
}

export type ShippingQuote =
  | {
      ok: true;
      method: ShippingMethod;
      shippingCents: number;
      freeApplied: boolean;
      /** What the free-shipping rule needed, when one exists and did not apply. */
      freeThresholdCents: number | null;
    }
  | { ok: false; reason: string };

/**
 * The shipping charge, computed here and nowhere else.
 *
 * Deterministic and integer-only: the same cart, method and settings always
 * produce the same number, and the route calls this rather than trusting
 * anything the browser sends. A client that posts `shippingCents: 0` changes
 * nothing, because its value is never read.
 */
export function quoteShipping(input: {
  settings: CommerceSettings;
  methodId: string;
  subtotalCents: number;
  discountCents?: number;
}): ShippingQuote {
  const { settings } = input;
  if (!settings.shipping.enabled) return { ok: false, reason: "Shipping is not available right now." };

  const method = settings.shipping.methods.find((entry) => entry.id === input.methodId && entry.enabled);
  if (!method) return { ok: false, reason: "Choose a delivery method." };

  // Free shipping is earned on what the customer actually pays for goods, so a
  // discount that drops the basket under the threshold drops the perk with it.
  // The alternative rewards stacking a code onto a barely-qualifying basket.
  const qualifying = Math.max(0, Math.trunc(input.subtotalCents) - Math.max(0, Math.trunc(input.discountCents || 0)));

  const thresholds = [settings.shipping.freeShippingThresholdCents, method.freeThresholdCents].filter(
    (value): value is number => typeof value === "number"
  );
  const threshold = thresholds.length ? Math.min(...thresholds) : null;
  const freeApplied = threshold !== null && qualifying >= threshold;

  return {
    ok: true,
    method,
    shippingCents: freeApplied ? 0 : Math.max(0, Math.trunc(method.priceCents)),
    freeApplied,
    freeThresholdCents: threshold,
  };
}

/** How much more a customer would have to spend to earn free shipping. */
export function amountToFreeShipping(settings: CommerceSettings, qualifyingCents: number): number | null {
  const thresholds = [
    settings.shipping.freeShippingThresholdCents,
    ...settings.shipping.methods.filter((m) => m.enabled).map((m) => m.freeThresholdCents),
  ].filter((value): value is number => typeof value === "number");
  if (!thresholds.length) return null;
  const threshold = Math.min(...thresholds);
  return qualifyingCents >= threshold ? 0 : threshold - qualifyingCents;
}

// ---------------------------------------------------------------------------
// Order totals
// ---------------------------------------------------------------------------

export type OrderTotals = {
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
};

/**
 * One place where a total is assembled. `taxCents` is carried through as a
 * real field and is always 0 in this pass — Stripe Tax is deliberately not
 * integrated (see the ledger). Threading it now means turning tax on later is
 * a value change rather than a schema change on live orders.
 */
export function computeOrderTotals(input: {
  subtotalCents: number;
  discountCents?: number;
  shippingCents?: number;
  taxCents?: number;
}): OrderTotals {
  const subtotalCents = Math.max(0, Math.trunc(input.subtotalCents));
  const discountCents = Math.min(subtotalCents, Math.max(0, Math.trunc(input.discountCents || 0)));
  const shippingCents = Math.max(0, Math.trunc(input.shippingCents || 0));
  const taxCents = Math.max(0, Math.trunc(input.taxCents || 0));
  return {
    subtotalCents,
    discountCents,
    shippingCents,
    taxCents,
    totalCents: subtotalCents - discountCents + shippingCents + taxCents,
  };
}

/**
 * Whether a delivery quote still describes the cart in front of the customer.
 *
 * A quote is computed server-side from a *specific* subtotal and discount, and
 * it carries both back. Applying a discount code changes the cart without
 * changing the delivery selection, so a quote taken before the code was
 * entered stays on screen — and because the summary reads its Total from the
 * quote and its Discount line from the cart, the two disagreed: subtotal
 * $50.00, discount −$5.00, total $50.00, while Stripe correctly charged
 * $45.00.
 *
 * Checked rather than merely re-fetched. Re-quoting on a cart change fixes the
 * common case, but a number in flight is still a number on screen; comparing
 * the basis means a total that was computed for a different cart can never be
 * displayed at all, whatever the ordering of requests.
 */
export function quoteMatchesCart(
  quote: { subtotalCents: number; discountCents: number } | null | undefined,
  cart: { subtotalCents: number; discountCents: number } | null | undefined
): boolean {
  if (!quote || !cart) return false;
  return quote.subtotalCents === cart.subtotalCents && quote.discountCents === cart.discountCents;
}

// ---------------------------------------------------------------------------
// Tracking links
// ---------------------------------------------------------------------------

/** Carriers cap out well below this; the limit exists to bound what is stored. */
const TRACKING_MAX = 64;

export function normalizeTrackingNumber(raw: unknown): string {
  return trimmed(raw, TRACKING_MAX).replace(/\s+/g, "");
}

export function isValidTrackingNumber(value: string): boolean {
  return /^[A-Za-z0-9._-]{4,64}$/.test(value);
}

export type TrackingLink = { ok: true; url: string } | { ok: false; reason: string };

/**
 * Build a tracking link from a configured template.
 *
 * The number is percent-encoded into the template rather than concatenated, so
 * a "tracking number" carrying `&`, `#` or a path segment cannot reshape the
 * URL it lands in.
 */
export function buildTrackingUrl(settings: CommerceSettings, carrier: string, trackingNumber: string): TrackingLink {
  const number = normalizeTrackingNumber(trackingNumber);
  if (!isValidTrackingNumber(number)) return { ok: false, reason: "That does not look like a tracking number." };
  const template = settings.shipping.trackingTemplates.find(
    (entry) => entry.carrier === carrier.trim().toLowerCase()
  );
  if (!template) return { ok: false, reason: "That carrier has no tracking link configured." };
  return { ok: true, url: template.urlTemplate.replace("{tracking}", encodeURIComponent(number)) };
}

/**
 * Whether a manually entered tracking URL is safe to render as a link.
 *
 * https only. `javascript:`, `data:`, `vbscript:` and every other scheme are
 * refused by the allow-list rather than by blocking a list of known-bad ones,
 * because the bad list is never finished. Credentials in the authority are
 * refused too: `https://tracking.example.com@evil.test/` reads as the carrier
 * to a human and resolves to the attacker.
 */
export function isSafeTrackingUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value || value.length > 1000) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  return Boolean(parsed.hostname) && parsed.hostname.includes(".");
}

/**
 * The link a customer is shown, or null.
 *
 * Prefers a template so a carrier change regenerates the link, and falls back
 * to a stored URL only when it still passes the safety check — a URL that was
 * saved before this validation existed does not become trusted by age.
 */
export function customerTrackingUrl(
  settings: CommerceSettings,
  order: { shipping_carrier?: string | null; tracking_number?: string | null; tracking_url?: string | null }
): string | null {
  const carrier = String(order.shipping_carrier || "").trim().toLowerCase();
  const number = normalizeTrackingNumber(order.tracking_number);
  if (carrier && number) {
    const built = buildTrackingUrl(settings, carrier, number);
    if (built.ok) return built.url;
  }
  const stored = String(order.tracking_url || "");
  return isSafeTrackingUrl(stored) ? stored.trim() : null;
}
