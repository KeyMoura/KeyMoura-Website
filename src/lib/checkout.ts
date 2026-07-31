export type FulfillmentMethod = "shipping" | "pickup";

export type ShippingAddress = {
  name: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
};

export const emptyShippingAddress = (): ShippingAddress => ({
  name: "", line1: "", line2: "", city: "", state: "", postal_code: "", country: "US",
});

const clean = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

export function normalizeShippingAddress(value: unknown): ShippingAddress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const address = {
    name: clean(raw.name, 120), line1: clean(raw.line1, 160), line2: clean(raw.line2, 160),
    city: clean(raw.city, 100), state: clean(raw.state, 100), postal_code: clean(raw.postal_code, 24),
    country: clean(raw.country, 2).toUpperCase() || "US",
  };
  return address.name && address.line1 && address.city && address.state && address.postal_code && /^[A-Z]{2}$/.test(address.country) ? address : null;
}

export function validateUpload(file: File) {
  const allowed = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
  if (!allowed.has(file.type)) return "Upload a JPEG, PNG, WebP, or PDF file.";
  if (file.size > 20 * 1024 * 1024) return "Each upload must be 20 MB or smaller.";
  return "";
}
