import type { PurchaseMode } from "@/lib/commerce/purchaseModes";

export type ProductMedia = {
  id: string;
  product_id: string;
  kind: "image" | "model";
  url: string;
  alt_text: string | null;
  sort_order: number;
};

export type ProductOptionValue = {
  id: string;
  option_group_id: string;
  label: string;
  value: string;
  price_adjustment_cents: number;
  is_default: boolean;
  is_active: boolean;
  sort_order: number;
  /**
   * The shop can make this, but not at the listed price.
   *
   * The column has existed since `20260802020100` and the cart has always
   * enforced it server-side; it was simply missing from this type, so the
   * product page had no way to tell a customer *why* a configuration could not
   * be bought outright. Selecting one is not an error — it moves the product
   * onto the request path.
   */
  requires_request?: boolean | null;
  /**
   * The gallery image this choice switches the storefront to, or null.
   *
   * A `product_media` row id, never a URL. Copying the URL in here would be a
   * second address for the same photograph: replace the image and the swatch
   * keeps showing the old one, delete it and the swatch points at a 404. The
   * relation is enforced both ways — a foreign key with ON DELETE SET NULL, and
   * a trigger refusing media that belongs to a different product.
   */
  media_id?: string | null;
};

/** How a group's choices are drawn. Chosen by staff, never inferred from the name. */
export type OptionDisplayStyle = "buttons" | "swatches";

export type ProductOptionGroup = {
  id: string;
  product_id: string;
  name: string;
  option_key: string;
  input_type: "select" | "radio" | "text" | "textarea" | "number" | "checkbox" | "file";
  description: string | null;
  placeholder: string | null;
  is_required: boolean;
  sort_order: number;
  /**
   * `buttons` defers to `input_type` (a dropdown for select, cards for radio);
   * `swatches` draws each value's linked image. Separate from `input_type`
   * because that says what kind of *answer* the option takes — the request
   * wizard reads it to choose between a text box, a number and a file upload —
   * and presentation is a different question asked only of choice-shaped types.
   */
  display_style?: OptionDisplayStyle | null;
  product_option_values?: ProductOptionValue[];
};

export type CatalogProduct = {
  id: string;
  name: string;
  slug: string;
  short_description: string | null;
  description: string | null;
  image_url: string | null;
  model_url: string | null;
  model_poster_url: string | null;
  /**
   * Legacy free-text category. Structured categories replaced it as the
   * catalog's organization, but the column is kept in sync so anything still
   * reading it keeps working.
   */
  category: string | null;
  category_id: string | null;
  purchase_mode: PurchaseMode;
  starting_price_cents: number | null;
  is_custom: boolean;
  is_published: boolean;
  sort_order: number;
  availability_status: "available" | "limited" | "made_to_order" | "unavailable";
  lead_time_text: string | null;
  sku: string | null;
  inventory_policy: "unlimited" | "track";
  inventory_quantity: number;
  low_stock_threshold: number;
  continue_selling_when_out_of_stock: boolean;
  archived_at: string | null;
  /**
   * Structured product content, added by `20260804030000`.
   *
   * All optional: every existing row predates them, and a product with none of
   * them set renders a shorter page rather than a broken one. `detail_content`
   * is deliberately `unknown` here — its shape is owned by
   * `src/lib/commerce/productContent.ts`, which every reader goes through, and
   * typing it as a structure at this level would invite the page to trust the
   * column directly.
   */
  material?: string | null;
  finish?: string | null;
  made_to_order?: boolean | null;
  installation_difficulty?: string | null;
  installation_notes?: string | null;
  care_instructions?: string | null;
  warranty_text?: string | null;
  shipping_notes?: string | null;
  return_notes?: string | null;
  cancellation_notes?: string | null;
  dimensions_text?: string | null;
  package_dimensions_text?: string | null;
  weight_grams?: number | null;
  detail_content?: unknown;

  /**
   * Delivery and packaging, added by `20260805020000`.
   *
   * These already drive checkout — `checkoutFulfillment.ts` reads every one of
   * them to decide which delivery methods a cart may offer and what a parcel
   * weighs — and until this pass they had no editing surface at all, so every
   * product silently sat on the column defaults.
   *
   * All optional here, and every reader defaults the same way the database
   * does (`requires_shipping`, `pickup_eligible`, `fulfillment_required` and
   * `is_returnable` default true), so a row selected before these columns
   * existed behaves exactly as it did.
   */
  requires_shipping?: boolean | null;
  pickup_eligible?: boolean | null;
  fulfillment_required?: boolean | null;
  is_returnable?: boolean | null;
  package_weight_grams?: number | null;
  package_length_mm?: number | null;
  package_width_mm?: number | null;
  package_height_mm?: number | null;
  length_mm?: number | null;
  width_mm?: number | null;
  height_mm?: number | null;
  tax_code?: string | null;
};

export const productCanBeRequested = (product: Pick<CatalogProduct, "availability_status" | "inventory_policy" | "inventory_quantity" | "continue_selling_when_out_of_stock">) =>
  product.availability_status !== "unavailable" && (
    product.inventory_policy === "unlimited" || product.inventory_quantity > 0 || product.continue_selling_when_out_of_stock
  );

export const inventoryLabel = (product: Pick<CatalogProduct, "inventory_policy" | "inventory_quantity" | "low_stock_threshold" | "continue_selling_when_out_of_stock">) => {
  if (product.inventory_policy === "unlimited") return "Made to order";
  if (product.inventory_quantity === 0) return product.continue_selling_when_out_of_stock ? "Available to order" : "Out of stock";
  if (product.inventory_quantity <= product.low_stock_threshold) return `Only ${product.inventory_quantity} left`;
  return `${product.inventory_quantity} in stock`;
};

export const availabilityLabel = (status: CatalogProduct["availability_status"]) => ({
  available: "Available",
  limited: "Limited availability",
  made_to_order: "Made to order",
  unavailable: "Currently unavailable",
}[status]);

export const optionKey = (value: string) =>
  value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

export const money = (cents: number) => {
  const sign = cents < 0 ? "−" : "+";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
};
