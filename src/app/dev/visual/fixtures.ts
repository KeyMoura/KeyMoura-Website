import type { ProductCardProduct } from "@/components/ProductCard";
import type { OrderHistoryOrder } from "@/lib/commerce/orderHistory";

/**
 * Representative catalog rows for the visual harness.
 *
 * Deliberately includes the awkward cases rather than only the tidy one: a
 * name long enough to wrap twice, a product carrying three badges at once, a
 * quote-only price, and an unavailable product — because those are the shapes
 * that broke layouts, not the 20-character example everyone tests with.
 */
export const productFixtures: ProductCardProduct[] = [
  {
    id: "fixture-1",
    name: "Billet Shift Knob",
    slug: "billet-shift-knob",
    short_description: "Turned from 6061 aluminum with a knurled grip and an M10 insert.",
    image_url: null,
    category: "Interior",
    starting_price_cents: 8400,
    is_custom: false,
    purchase_mode: "direct_purchase",
    availability_status: "available",
    lead_time_text: "Ships in 3 days",
    inventory_policy: "track",
    inventory_quantity: 12,
    continue_selling_when_out_of_stock: false,
    product_media: null,
  },
  {
    id: "fixture-2",
    name: "Adjustable Rear Subframe Alignment Fixture With Extended Arms",
    slug: "subframe-fixture",
    short_description:
      "A long description that runs past two lines so the clamp behaviour is visible, including how the footer stays pinned to the bottom of the card.",
    image_url: null,
    category: "Chassis & Suspension Tooling",
    starting_price_cents: 129900,
    is_custom: true,
    purchase_mode: "direct_or_request",
    availability_status: "limited",
    lead_time_text: "4–6 weeks",
    inventory_policy: "track",
    inventory_quantity: 1,
    continue_selling_when_out_of_stock: false,
    product_media: null,
  },
  {
    id: "fixture-3",
    name: "Custom Bracket",
    slug: "custom-bracket",
    short_description: "Send a drawing and we will quote it.",
    image_url: null,
    category: "Custom work",
    starting_price_cents: null,
    is_custom: true,
    purchase_mode: "request_only",
    availability_status: "made_to_order",
    lead_time_text: null,
    inventory_policy: "unlimited",
    inventory_quantity: 0,
    continue_selling_when_out_of_stock: false,
    product_media: null,
  },
  {
    id: "fixture-4",
    name: "Discontinued Pedal Spacer",
    slug: "pedal-spacer",
    short_description: null,
    image_url: null,
    category: "Interior",
    starting_price_cents: 2200,
    is_custom: false,
    purchase_mode: "direct_purchase",
    availability_status: "unavailable",
    lead_time_text: null,
    inventory_policy: "track",
    inventory_quantity: 0,
    continue_selling_when_out_of_stock: false,
    product_media: null,
  },
];

/** Top-level categories plus one child, so both catalog shapes are renderable. */
export const categoryFixtures = [
  { id: "c1", name: "Interior", slug: "interior", description: "Shift knobs, trim and cabin hardware.", parent_id: null, image_url: null, display_order: 1, is_active: true, archived_at: null },
  { id: "c2", name: "Kitchen", slug: "kitchen", description: "Boards, handles and fittings.", parent_id: null, image_url: null, display_order: 2, is_active: true, archived_at: null },
  { id: "c3", name: "Chassis & Suspension Tooling", slug: "chassis", description: null, parent_id: null, image_url: null, display_order: 3, is_active: true, archived_at: null },
  { id: "c1a", name: "Shift knobs", slug: "shift-knobs", description: "Billet and delrin.", parent_id: "c1", image_url: null, display_order: 1, is_active: true, archived_at: null },
  { id: "c1b", name: "Trim", slug: "trim", description: null, parent_id: "c1", image_url: null, display_order: 2, is_active: true, archived_at: null },
];

export type StaffCatalogRowFixture = {
  id: string;
  name: string;
  sku: string | null;
  category: string;
  priceCents: number | null;
  stock: "in_stock" | "low_stock" | "out_of_stock";
  quantity: number;
  status: "active" | "draft" | "hidden";
};

/** The `/staff/catalog` list, including the long and multi-badge cases. */
export const staffCatalogFixtures: StaffCatalogRowFixture[] = [
  { id: "s1", name: "Billet Shift Knob", sku: "KM-SHIFT-001", category: "Interior", priceCents: 8400, stock: "low_stock", quantity: 1, status: "active" },
  {
    id: "s2",
    name: "Adjustable Rear Subframe Alignment Fixture With Extended Arms",
    sku: "KM-SUBFRAME-ALIGN-EXT-0042",
    category: "Chassis & Suspension Tooling",
    priceCents: 129900,
    stock: "in_stock",
    quantity: 6,
    status: "active",
  },
  { id: "s3", name: "Custom Bracket", sku: null, category: "Uncategorized", priceCents: null, stock: "in_stock", quantity: 0, status: "draft" },
  { id: "s4", name: "Discontinued Pedal Spacer", sku: "KM-PED-9", category: "Interior", priceCents: 2200, stock: "out_of_stock", quantity: 0, status: "hidden" },
];

/**
 * Order-history rows, one per state a card has to survive.
 *
 * The interesting ones are not the tidy shipped order: a two-item order that
 * must stay one card, an order whose payment is outstanding, a refunded one, a
 * pickup that is ready, a cancelled request, and a legacy custom order with no
 * `order_items` at all — which is a shape that still exists in production and
 * has to render from the order's own `product_name`.
 */
export const orderHistoryFixtures: OrderHistoryOrder[] = [
  {
    id: "o-shipped",
    order_number: "KM-0012",
    product_name: "Billet Shift Knob",
    quantity: 1,
    status: "ready",
    payment_status: "paid",
    fulfillment_method: "shipping",
    fulfillment_status: "shipped",
    cancellation_status: "none",
    return_status: "none",
    agreed_price_cents: 6100,
    amount_paid_cents: 6100,
    amount_refunded_cents: 0,
    tracking_url: "https://example.com/track/1Z999",
    tracking_number: "1Z999AA10123456784",
    shipping_carrier: "UPS",
    shipping_address: { name: "Ethan Moura", line1: "1 Example Way", city: "Austin" },
    pickup_location_snapshot: null,
    created_at: "2026-08-11T15:00:00.000Z",
    ready_at: "2026-08-12T09:00:00.000Z",
    shipped_at: "2026-08-12T17:30:00.000Z",
    delivered_at: null,
    picked_up_at: null,
    order_items: [
      {
        id: "oi-1",
        product_id: "fixture-1",
        product_name: "Billet Shift Knob",
        product_slug: "billet-shift-knob",
        quantity: 1,
        unit_price_cents: 6100,
        line_subtotal_cents: 6100,
        selected_options: { color: "Blue", size: "Large" },
      },
    ],
  },
  {
    id: "o-production",
    order_number: "KM-0013",
    product_name: "Adjustable Rear Subframe Alignment Fixture With Extended Arms",
    quantity: 1,
    status: "in_progress",
    payment_status: "paid",
    fulfillment_method: "shipping",
    fulfillment_status: "processing",
    cancellation_status: "none",
    return_status: "none",
    agreed_price_cents: 129900,
    amount_paid_cents: 129900,
    amount_refunded_cents: 0,
    tracking_url: null,
    tracking_number: null,
    shipping_carrier: null,
    shipping_address: { name: "Ethan Moura" },
    pickup_location_snapshot: null,
    created_at: "2026-08-09T12:00:00.000Z",
    ready_at: null,
    shipped_at: null,
    delivered_at: null,
    picked_up_at: null,
    order_items: [
      {
        id: "oi-2",
        product_id: "fixture-2",
        product_name: "Adjustable Rear Subframe Alignment Fixture With Extended Arms",
        product_slug: "subframe-fixture",
        quantity: 1,
        unit_price_cents: 129900,
        line_subtotal_cents: 129900,
        selected_options: { finish: "Raw aluminium", arms: "Extended", hardware: "Stainless", extra: "Dropped" },
      },
    ],
  },
  {
    id: "o-pickup",
    order_number: "KM-0014",
    product_name: "Walnut Board",
    quantity: 2,
    status: "ready",
    payment_status: "paid",
    fulfillment_method: "pickup",
    fulfillment_status: "ready_for_pickup",
    cancellation_status: "none",
    return_status: "none",
    agreed_price_cents: 14000,
    amount_paid_cents: 14000,
    amount_refunded_cents: 0,
    tracking_url: null,
    tracking_number: null,
    shipping_carrier: null,
    shipping_address: null,
    pickup_location_snapshot: { name: "KeyMoura workshop", city: "Austin" },
    created_at: "2026-08-08T18:00:00.000Z",
    ready_at: "2026-08-13T10:00:00.000Z",
    shipped_at: null,
    delivered_at: null,
    picked_up_at: null,
    order_items: [
      {
        id: "oi-3",
        product_id: "fixture-1",
        product_name: "Walnut Board",
        product_slug: "walnut-board",
        quantity: 2,
        unit_price_cents: 7000,
        line_subtotal_cents: 14000,
        selected_options: null,
      },
    ],
  },
  {
    id: "o-multi",
    order_number: "KM-0015",
    product_name: "Billet Shift Knob",
    quantity: 1,
    status: "completed",
    payment_status: "paid",
    fulfillment_method: "shipping",
    fulfillment_status: "delivered",
    cancellation_status: "none",
    return_status: "none",
    agreed_price_cents: 21500,
    amount_paid_cents: 21500,
    amount_refunded_cents: 0,
    tracking_url: null,
    tracking_number: null,
    shipping_carrier: null,
    shipping_address: { name: "Ethan Moura" },
    pickup_location_snapshot: null,
    created_at: "2026-07-02T11:00:00.000Z",
    ready_at: null,
    shipped_at: "2026-07-04T09:00:00.000Z",
    delivered_at: "2026-07-06T14:00:00.000Z",
    picked_up_at: null,
    order_items: [
      { id: "oi-4", product_id: "fixture-1", product_name: "Billet Shift Knob", product_slug: "billet-shift-knob", quantity: 1, unit_price_cents: 6100, line_subtotal_cents: 6100, selected_options: { color: "Black" } },
      { id: "oi-5", product_id: "fixture-4", product_name: "Pedal Spacer", product_slug: "pedal-spacer", quantity: 3, unit_price_cents: 2200, line_subtotal_cents: 6600, selected_options: null },
      { id: "oi-6", product_id: "fixture-2", product_name: "Delrin Knob Insert", product_slug: null, quantity: 1, unit_price_cents: 4400, line_subtotal_cents: 4400, selected_options: { thread: "M10 × 1.25" } },
      { id: "oi-7", product_id: null, product_name: "Anodising, blue", product_slug: null, quantity: 1, unit_price_cents: 4400, line_subtotal_cents: 4400, selected_options: null },
    ],
  },
  {
    id: "o-unpaid",
    order_number: "KM-0016",
    product_name: "Custom Bracket",
    quantity: 1,
    status: "awaiting_payment",
    payment_status: "unpaid",
    fulfillment_method: "shipping",
    fulfillment_status: "unfulfilled",
    cancellation_status: "none",
    return_status: "none",
    agreed_price_cents: 6100,
    amount_paid_cents: 0,
    amount_refunded_cents: 0,
    tracking_url: null,
    tracking_number: null,
    shipping_carrier: null,
    shipping_address: null,
    pickup_location_snapshot: null,
    created_at: "2026-08-14T08:00:00.000Z",
    ready_at: null,
    shipped_at: null,
    delivered_at: null,
    picked_up_at: null,
    // No `order_items`: a custom request predates the line-item table and still
    // has to render from the order's own product name.
    order_items: [],
  },
  {
    id: "o-refunded",
    order_number: "KM-0009",
    product_name: "Pedal Spacer",
    quantity: 1,
    status: "cancelled",
    payment_status: "refunded",
    fulfillment_method: "shipping",
    fulfillment_status: "canceled",
    cancellation_status: "completed",
    return_status: "none",
    agreed_price_cents: 2200,
    amount_paid_cents: 2200,
    amount_refunded_cents: 2200,
    tracking_url: null,
    tracking_number: null,
    shipping_carrier: null,
    shipping_address: { name: "Ethan Moura" },
    pickup_location_snapshot: null,
    created_at: "2026-06-01T10:00:00.000Z",
    ready_at: null,
    shipped_at: null,
    delivered_at: null,
    picked_up_at: null,
    order_items: [
      { id: "oi-8", product_id: "fixture-4", product_name: "Pedal Spacer", product_slug: "pedal-spacer", quantity: 1, unit_price_cents: 2200, line_subtotal_cents: 2200, selected_options: null },
    ],
  },
];

// ---------------------------------------------------------------------------
// Homepage
// ---------------------------------------------------------------------------

/**
 * A stand-in photograph, as an inline SVG data URL.
 *
 * The homepage's frames behave differently with and without media — one path
 * renders `ProductImage`, the other renders the drawn sheet — and a harness
 * that could only show the empty path would leave the composition that actually
 * ships unverified.
 *
 * A data URL rather than a file: it needs no network, it survives with no
 * Supabase configured, and `normalizeImageUrl` accepts `data:image/` while
 * `isOptimizableImageUrl` correctly refuses to send it to the optimizer, so
 * the plain-`<img>` branch gets exercised too. Nothing here is presented as a
 * real KeyMoura part; it is a shape at a known aspect ratio.
 */
function swatch(seed: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${seed} 12% 26%)"/>
      <stop offset="1" stop-color="hsl(${seed} 14% 12%)"/>
    </linearGradient></defs>
    <rect width="800" height="600" fill="url(#g)"/>
    <circle cx="400" cy="300" r="150" fill="none" stroke="hsl(${seed} 20% 55%)" stroke-width="26"/>
    <circle cx="400" cy="300" r="64" fill="hsl(${seed} 16% 20%)" stroke="hsl(${seed} 22% 60%)" stroke-width="10"/>
    <rect x="150" y="470" width="500" height="14" fill="hsl(${seed} 18% 45%)"/>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * Six products for the homepage surfaces, in the catalog's featured order.
 *
 * Two carry media and four do not, on purpose: that is the mix the drawn-sheet
 * fallback has to survive, and it puts a real image and a placeholder next to
 * each other in the same row where any mismatch in framing shows up.
 */
export const homeProductFixtures: ProductCardProduct[] = [
  { ...productFixtures[0], id: "home-1", product_media: [{ url: swatch(28), kind: "image", sort_order: 0 }] },
  { ...productFixtures[1], id: "home-2", product_media: [{ url: swatch(200), kind: "image", sort_order: 0 }] },
  { ...productFixtures[2], id: "home-3" },
  { ...productFixtures[3], id: "home-4" },
  {
    ...productFixtures[0],
    id: "home-5",
    name: "Knurled Aluminium Handle",
    slug: "knurled-handle",
    short_description: "Turned and knurled from bar stock, anodized clear.",
    starting_price_cents: 5600,
  },
  {
    ...productFixtures[2],
    id: "home-6",
    name: "Engraved Hardwood Sign",
    slug: "engraved-sign",
    short_description: "Routed from solid oak, oiled finish.",
    category: "Signage",
    starting_price_cents: 12000,
  },
];

/** Public build write-ups, with the shapes the row has to survive. */
export const recentWorkFixtures = [
  { id: "work-1", title: "Rebuilding a seized indexer", slug: "rebuilding-a-seized-indexer", category: "CNC & Machining", updated_at: "2026-07-28T12:00:00.000Z" },
  {
    id: "work-2",
    title: "A replacement bracket for a machine nobody sells parts for any more",
    slug: "replacement-bracket",
    category: "Product Design",
    updated_at: "2026-07-11T12:00:00.000Z",
  },
  { id: "work-3", title: "Oak shop signage", slug: "oak-shop-signage", category: null, updated_at: null },
];
