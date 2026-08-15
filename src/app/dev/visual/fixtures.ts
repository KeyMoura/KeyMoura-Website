import type { ProductCardProduct } from "@/components/ProductCard";

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
