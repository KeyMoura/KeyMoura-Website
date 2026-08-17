import type { PricedLine } from "@/lib/commerce/pricing";

export type PurchasedOptionSnapshot = {
  option_id: string;
  option_name: string;
  value_id: string;
  value_name: string;
  value: string;
  price_adjustment_cents: number;
};

/** Copies purchase-time labels and prices; order readers must never rejoin live catalog options. */
export function snapshotPurchasedOptions(line: Pick<PricedLine, "optionLabels">): Record<string, PurchasedOptionSnapshot> {
  return Object.fromEntries(line.optionLabels.map((option) => [option.groupKey, {
    option_id: option.groupId,
    option_name: option.group,
    value_id: option.valueId,
    value_name: option.label,
    value: option.value,
    price_adjustment_cents: option.adjustmentCents,
  }]));
}

/**
 * The selection map a snapshot was built from.
 *
 * The inverse of `snapshotPurchasedOptions`, and the only reason it exists is
 * to compare a stored order line against a live cart line — a stored line keeps
 * the labels and prices of the moment it was written, so its raw selections
 * have to be recovered before the two can be matched. Not for display: a
 * historical page reads the snapshot itself, never a value re-resolved from it.
 */
export function snapshotSelections(snapshot: unknown): Record<string, string> {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return {};
  const selections: Record<string, string> = {};
  for (const [key, raw] of Object.entries(snapshot as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Partial<PurchasedOptionSnapshot>;
    const value = typeof entry.value === "string" ? entry.value : entry.value_name;
    if (typeof value === "string") selections[key] = value;
  }
  return selections;
}

export function purchasedOptions(snapshot: unknown): PurchasedOptionSnapshot[] {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return [];
  return Object.values(snapshot).flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const value = raw as Partial<PurchasedOptionSnapshot>;
    if (typeof value.option_name !== "string" || typeof value.value_name !== "string") return [];
    return [{
      option_id: typeof value.option_id === "string" ? value.option_id : "",
      option_name: value.option_name,
      value_id: typeof value.value_id === "string" ? value.value_id : "",
      value_name: value.value_name,
      value: typeof value.value === "string" ? value.value : value.value_name,
      price_adjustment_cents: typeof value.price_adjustment_cents === "number" && Number.isFinite(value.price_adjustment_cents)
        ? Math.round(value.price_adjustment_cents)
        : 0,
    }];
  });
}
