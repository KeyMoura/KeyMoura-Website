import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_COMMERCE_SETTINGS,
  amountToFreeShipping,
  availableFulfillmentMethods,
  buildTrackingUrl,
  checkDestination,
  computeOrderTotals,
  customerTrackingUrl,
  formatAddressLines,
  isDeliverableAddress,
  isSafeTrackingUrl,
  isValidTrackingTemplate,
  normalizeMethodId,
  parseAddress,
  parseCommerceSettings,
  publicCommerceSettings,
  quoteShipping,
  type Address,
  type CommerceSettings,
  type QuotableLine,
} from "../src/lib/commerce/commerceSettings.ts";

/**
 * The shipping arithmetic and the tracking-link safety rules.
 *
 * These are the two places in this pass where getting it wrong is expensive:
 * one decides what a customer is charged, the other decides what URL this
 * application renders as a link on their order page.
 */

const address = (overrides: Partial<Address> = {}): Address => ({
  name: "A Customer",
  line1: "1 Example Street",
  line2: "",
  city: "Springfield",
  region: "IL",
  postalCode: "62701",
  country: "US",
  phone: "",
  ...overrides,
});

const settingsWith = (overrides: Record<string, unknown>): CommerceSettings => {
  // `shipping` is merged into the base rather than replacing it, and the rest
  // of the overrides are spread *first* so they cannot clobber that merge.
  const { shipping, ...rest } = overrides;
  return parseCommerceSettings({
    ...rest,
    shipping: {
      enabled: true,
      originName: "KeyMoura",
      originAddress: { name: "KeyMoura", line1: "9 Private Lane", city: "Springfield", postalCode: "62701", country: "US" },
      destinationCountries: ["US"],
      methods: [
        { id: "standard", name: "Standard", priceCents: 800, deliveryEstimate: "3-5 days", enabled: true },
        { id: "express", name: "Express", priceCents: 2200, deliveryEstimate: "1-2 days", enabled: true },
      ],
      ...((shipping as Record<string, unknown> | undefined) ?? {}),
    },
  });
};

// ---------------------------------------------------------------------------
// Parsing is total
// ---------------------------------------------------------------------------

test("the parser is total: any input at all yields usable settings", () => {
  for (const input of [null, undefined, 0, "", "nonsense", [], [1, 2], true, { shipping: "yes" }, { shipping: { methods: 7 } }]) {
    const parsed = parseCommerceSettings(input);
    assert.equal(typeof parsed.shipping.enabled, "boolean");
    assert.ok(Array.isArray(parsed.shipping.methods));
    assert.ok(parsed.inventory.reservationMinutes >= 30);
  }
});

test("safe defaults leave shipping and pickup off", () => {
  // An unconfigured shop must refuse clearly rather than quote a price it
  // invented, so neither channel is on until the owner turns it on.
  assert.equal(DEFAULT_COMMERCE_SETTINGS.shipping.enabled, false);
  assert.equal(DEFAULT_COMMERCE_SETTINGS.pickup.enabled, false);
  assert.deepEqual(DEFAULT_COMMERCE_SETTINGS.shipping.methods, []);
});

test("reservation minutes are clamped to Stripe's 30-minute floor and a 24-hour ceiling", () => {
  assert.equal(parseCommerceSettings({ inventory: { reservationMinutes: 1 } }).inventory.reservationMinutes, 30);
  assert.equal(parseCommerceSettings({ inventory: { reservationMinutes: 99999 } }).inventory.reservationMinutes, 1440);
  assert.equal(parseCommerceSettings({ inventory: { reservationMinutes: 45 } }).inventory.reservationMinutes, 45);
});

test("two shipping methods cannot share an id", () => {
  const parsed = parseCommerceSettings({
    shipping: { methods: [{ name: "Standard" }, { name: "Standard" }, { id: "standard", name: "Third" }] },
  });
  const ids = parsed.shipping.methods.map((method) => method.id);
  assert.equal(new Set(ids).size, ids.length, "an order's snapshot must be unambiguous about which method was chosen");
});

test("a method with no name is dropped rather than stored nameless", () => {
  const parsed = parseCommerceSettings({ shipping: { methods: [{ name: "  " }, { name: "Real" }] } });
  assert.equal(parsed.shipping.methods.length, 1);
  assert.equal(parsed.shipping.methods[0].name, "Real");
});

test("method ids are slugged so they survive a URL and an HTML attribute", () => {
  assert.equal(normalizeMethodId("Next Day (AM)", 0), "next-day-am");
  assert.equal(normalizeMethodId("", 3), "method-4");
  assert.equal(normalizeMethodId("!!!", 0), "method-1");
});

test("email recipient lists drop malformed entries and duplicates", () => {
  const parsed = parseCommerceSettings({
    email: { staffAlertRecipients: ["A@Example.com", "a@example.com", "not-an-email", "b@example.co.uk"] },
  });
  assert.deepEqual(parsed.email.staffAlertRecipients, ["a@example.com", "b@example.co.uk"]);
});

// ---------------------------------------------------------------------------
// Destination eligibility
// ---------------------------------------------------------------------------

test("an unsupported country is refused with a sentence, not a silent failure", () => {
  const settings = settingsWith({});
  const result = checkDestination(settings, address({ country: "FR" }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /do not ship to that country/i);
});

test("region restrictions apply only where configured", () => {
  const settings = settingsWith({ shipping: { destinationCountries: ["US"], destinationRegions: { US: ["IL", "WI"] } } });
  assert.equal(checkDestination(settings, address({ region: "IL" })).ok, true);
  const refused = checkDestination(settings, address({ region: "CA" }));
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.reason, /state or region/i);
});

test("shipping turned off refuses every destination", () => {
  const settings = parseCommerceSettings({ shipping: { enabled: false, destinationCountries: ["US"] } });
  assert.equal(checkDestination(settings, address()).ok, false);
});

test("an incomplete address is not deliverable", () => {
  assert.equal(isDeliverableAddress(address()), true);
  assert.equal(isDeliverableAddress(address({ line1: "" })), false);
  assert.equal(isDeliverableAddress(address({ postalCode: "  " })), false);
  assert.equal(isDeliverableAddress(null), false);
});

// ---------------------------------------------------------------------------
// Shipping quotes
// ---------------------------------------------------------------------------

test("a flat rate is the configured price", () => {
  const quote = quoteShipping({ settings: settingsWith({}), methodId: "standard", subtotalCents: 5000 });
  assert.equal(quote.ok, true);
  if (quote.ok) {
    assert.equal(quote.shippingCents, 800);
    assert.equal(quote.freeApplied, false);
  }
});

test("a disabled or unknown method is refused rather than defaulted", () => {
  const settings = settingsWith({
    shipping: { methods: [{ id: "standard", name: "Standard", priceCents: 800, enabled: false }] },
  });
  assert.equal(quoteShipping({ settings, methodId: "standard", subtotalCents: 5000 }).ok, false);
  assert.equal(quoteShipping({ settings, methodId: "does-not-exist", subtotalCents: 5000 }).ok, false);
});

test("the free-shipping threshold applies at the boundary", () => {
  const settings = settingsWith({ shipping: { freeShippingThresholdCents: 10_000 } });
  const under = quoteShipping({ settings, methodId: "standard", subtotalCents: 9_999 });
  const at = quoteShipping({ settings, methodId: "standard", subtotalCents: 10_000 });
  assert.equal(under.ok && under.shippingCents, 800);
  assert.equal(at.ok && at.shippingCents, 0);
  assert.equal(at.ok && at.freeApplied, true);
});

test("a discount that drops the basket under the threshold drops the free shipping with it", () => {
  // Free shipping is earned on what the customer actually pays for goods.
  // The alternative rewards stacking a code onto a barely-qualifying basket.
  const settings = settingsWith({ shipping: { freeShippingThresholdCents: 10_000 } });
  const quote = quoteShipping({ settings, methodId: "standard", subtotalCents: 10_500, discountCents: 1_000 });
  assert.equal(quote.ok && quote.shippingCents, 800);
  assert.equal(quote.ok && quote.freeApplied, false);
});

test("the lower of the global and per-method thresholds wins", () => {
  const settings = settingsWith({
    shipping: {
      freeShippingThresholdCents: 20_000,
      methods: [{ id: "standard", name: "Standard", priceCents: 800, freeThresholdCents: 5_000, enabled: true }],
    },
  });
  const quote = quoteShipping({ settings, methodId: "standard", subtotalCents: 6_000 });
  assert.equal(quote.ok && quote.shippingCents, 0);
});

test("amountToFreeShipping reports what is still needed, and null when no rule exists", () => {
  const withRule = settingsWith({ shipping: { freeShippingThresholdCents: 10_000 } });
  assert.equal(amountToFreeShipping(withRule, 7_500), 2_500);
  assert.equal(amountToFreeShipping(withRule, 10_000), 0);
  assert.equal(amountToFreeShipping(settingsWith({}), 7_500), null);
});

test("quotes are deterministic and integer-only", () => {
  const settings = settingsWith({ shipping: { freeShippingThresholdCents: 10_000 } });
  for (const subtotal of [0, 1, 999, 9_999, 10_000, 250_000]) {
    const a = quoteShipping({ settings, methodId: "express", subtotalCents: subtotal });
    const b = quoteShipping({ settings, methodId: "express", subtotalCents: subtotal });
    assert.deepEqual(a, b);
    if (a.ok) assert.equal(Number.isInteger(a.shippingCents), true);
  }
});

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

test("totals show every component distinctly and never go negative", () => {
  const totals = computeOrderTotals({ subtotalCents: 10_000, discountCents: 2_500, shippingCents: 800 });
  assert.deepEqual(totals, {
    subtotalCents: 10_000,
    discountCents: 2_500,
    shippingCents: 800,
    taxCents: 0,
    totalCents: 8_300,
  });
  // A discount larger than the basket cannot make the goods free *and* pay for
  // the postage.
  const over = computeOrderTotals({ subtotalCents: 1_000, discountCents: 9_999, shippingCents: 500 });
  assert.equal(over.discountCents, 1_000);
  assert.equal(over.totalCents, 500);
});

// ---------------------------------------------------------------------------
// Fulfillment method availability
// ---------------------------------------------------------------------------

const line = (overrides: Partial<QuotableLine> = {}): QuotableLine => ({
  productId: "p1",
  productName: "Shift Knob",
  quantity: 1,
  requiresShipping: true,
  pickupEligible: true,
  fulfillmentRequired: true,
  ...overrides,
});

test("one pickup-ineligible item removes pickup for the whole order, and names it", () => {
  const settings = settingsWith({ pickup: { enabled: true, locationName: "Shop", instructions: "Ring the bell" } });
  const methods = availableFulfillmentMethods(settings, [line(), line({ productId: "p2", productName: "Anvil", pickupEligible: false })]);
  const pickup = methods.find((entry) => entry.method === "pickup");
  assert.equal(pickup?.available, false);
  assert.match(pickup?.reason ?? "", /Anvil/);
});

test("a cart needing no fulfillment offers only 'none'", () => {
  const settings = settingsWith({ pickup: { enabled: true, locationName: "Shop", instructions: "Ring" } });
  const methods = availableFulfillmentMethods(settings, [line({ fulfillmentRequired: false, requiresShipping: false })]);
  assert.equal(methods.find((m) => m.method === "none")?.available, true);
  assert.equal(methods.find((m) => m.method === "shipping")?.available, false);
  assert.equal(methods.find((m) => m.method === "pickup")?.available, false);
});

test("'none' is never offered for a cart holding a physical item", () => {
  const methods = availableFulfillmentMethods(settingsWith({}), [line()]);
  const none = methods.find((entry) => entry.method === "none");
  assert.equal(none?.available, false);
  assert.match(none?.reason ?? "", /have to be delivered/i);
});

test("shipping can be switched off per order kind", () => {
  const settings = settingsWith({ shipping: { availableForCustomOrders: false } });
  assert.equal(
    availableFulfillmentMethods(settings, [line()], { orderKind: "custom_request" }).find((m) => m.method === "shipping")?.available,
    false
  );
  assert.equal(
    availableFulfillmentMethods(settings, [line()], { orderKind: "direct_purchase" }).find((m) => m.method === "shipping")?.available,
    true
  );
});

// ---------------------------------------------------------------------------
// Tracking links
// ---------------------------------------------------------------------------

test("a tracking link is generated from a configured template", () => {
  const built = buildTrackingUrl(settingsWith({}), "usps", "9400111899223197428490");
  assert.equal(built.ok, true);
  if (built.ok) assert.match(built.url, /^https:\/\/tools\.usps\.com\//);
});

test("a tracking number is percent-encoded into the template, never concatenated", () => {
  // A "tracking number" carrying & or # must not be able to reshape the URL.
  const built = buildTrackingUrl(settingsWith({}), "ups", "ABC-123_x.y");
  assert.equal(built.ok, true);
  if (built.ok) assert.ok(built.url.endsWith("ABC-123_x.y"));
  // Anything that could reshape a URL fails the number check first.
  for (const bad of ["1234&evil=1", "abc#frag", "a/b", "a b", "<script>", "'", "12"]) {
    assert.equal(buildTrackingUrl(settingsWith({}), "ups", bad).ok, false, `${bad} must be refused`);
  }
});

test("only https templates with a placeholder are accepted", () => {
  assert.equal(isValidTrackingTemplate("https://x.example/t?n={tracking}"), true);
  assert.equal(isValidTrackingTemplate("http://x.example/t?n={tracking}"), false, "http must be refused");
  assert.equal(isValidTrackingTemplate("https://x.example/t"), false, "no placeholder means nowhere to put the number");
  assert.equal(isValidTrackingTemplate("javascript:alert(1)/{tracking}"), false);
});

test("a manual tracking URL is allow-listed to https, not blocklisted", () => {
  assert.equal(isSafeTrackingUrl("https://tracking.example.com/x"), true);
  for (const bad of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox",
    "http://tracking.example.com/x",
    "file:///etc/passwd",
    "//evil.test",
    "",
    "   ",
  ]) {
    assert.equal(isSafeTrackingUrl(bad), false, `${bad || "(blank)"} must be refused`);
  }
});

test("credentials in the authority are refused", () => {
  // https://tracking.example.com@evil.test/ reads as the carrier to a human
  // and resolves to the attacker.
  assert.equal(isSafeTrackingUrl("https://tracking.example.com@evil.test/"), false);
  assert.equal(isSafeTrackingUrl("https://user:pass@evil.test/"), false);
});

test("a stored URL does not become trusted by age", () => {
  const settings = settingsWith({});
  const unsafe = customerTrackingUrl(settings, {
    shipping_carrier: null,
    tracking_number: null,
    tracking_url: "javascript:alert(1)",
  });
  assert.equal(unsafe, null);
});

test("a template beats a stored URL, so a carrier change regenerates the link", () => {
  const url = customerTrackingUrl(settingsWith({}), {
    shipping_carrier: "fedex",
    tracking_number: "123456789012",
    tracking_url: "https://stale.example.com/old",
  });
  assert.match(String(url), /fedex\.com/);
});

// ---------------------------------------------------------------------------
// The public projection
// ---------------------------------------------------------------------------

test("the public projection never carries the origin or return address", () => {
  const settings = parseCommerceSettings({
    shipping: {
      enabled: true,
      originAddress: { name: "Owner", line1: "9 Private Lane", city: "Springfield", postalCode: "62701", country: "US" },
      methods: [{ id: "standard", name: "Standard", priceCents: 800, enabled: true }],
    },
    returnAddress: { name: "Owner", line1: "9 Private Lane", city: "Springfield", postalCode: "62701", country: "US" },
    pickup: { enabled: true, locationName: "Shop", address: { line1: "9 Private Lane" }, instructions: "Ring" },
    inventory: { reservationMinutes: 90, lowStockRecipients: ["staff@example.com"] },
    email: { staffAlertRecipients: ["staff@example.com"] },
  });

  const serialized = JSON.stringify(publicCommerceSettings(settings));
  assert.doesNotMatch(serialized, /9 Private Lane/, "a private address must not reach a customer surface");
  assert.doesNotMatch(serialized, /staff@example\.com/, "staff recipients are not customer information");
  assert.doesNotMatch(serialized, /reservationMinutes/, "reservation timings are not customer information");
  assert.doesNotMatch(serialized, /originAddress|returnAddress/);
});

test("the pickup address is withheld until the order is ready, unless configured otherwise", () => {
  const guarded = parseCommerceSettings({
    pickup: { enabled: true, locationName: "Shop", address: { line1: "9 Private Lane", city: "Springfield" }, instructions: "Ring" },
  });
  assert.equal(publicCommerceSettings(guarded).pickup.addressLines, null);
  assert.ok((publicCommerceSettings(guarded, { pickupReady: true }).pickup.addressLines ?? []).length > 0);

  const open = parseCommerceSettings({
    pickup: {
      enabled: true,
      locationName: "Shop",
      address: { line1: "1 Public Road", city: "Springfield" },
      instructions: "Ring",
      revealAddressBeforeReady: true,
    },
  });
  assert.ok((publicCommerceSettings(open).pickup.addressLines ?? []).length > 0);
});

test("only enabled shipping methods are published", () => {
  const settings = parseCommerceSettings({
    shipping: {
      enabled: true,
      methods: [
        { id: "standard", name: "Standard", priceCents: 800, enabled: true },
        { id: "secret", name: "Staff courier", priceCents: 0, enabled: false },
      ],
    },
  });
  const published = publicCommerceSettings(settings).shipping.methods.map((method) => method.id);
  assert.deepEqual(published, ["standard"]);
});

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

test("address parsing bounds every field and upper-cases the country", () => {
  const parsed = parseAddress({ name: "x".repeat(500), country: "us", city: 7, phone: null });
  assert.equal(parsed.name.length, 120);
  assert.equal(parsed.country, "US");
  assert.equal(parsed.city, "");
  assert.equal(parsed.phone, "");
});

test("address formatting drops empty lines rather than printing blanks", () => {
  const lines = formatAddressLines(address({ line2: "", region: "" }));
  assert.ok(lines.every((entry) => entry.trim().length > 0));
  assert.ok(lines.includes("1 Example Street"));
});
