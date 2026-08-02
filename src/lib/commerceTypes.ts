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
};

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
  category: string | null;
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
