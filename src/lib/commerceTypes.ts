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
};

export const optionKey = (value: string) =>
  value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

export const money = (cents: number) => {
  const sign = cents < 0 ? "−" : "+";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
};
