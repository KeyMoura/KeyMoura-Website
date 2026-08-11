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
