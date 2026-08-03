import { normalizeDiscountCodeInput, type DiscountTarget } from "@/lib/commerce/discounts";

/**
 * Validation for staff-authored discount codes.
 *
 * Every rule here mirrors a CHECK constraint in `20260802020300_discount_codes`.
 * The database is the real guard — this exists so staff get a sentence
 * explaining what is wrong instead of a raw constraint violation, and so the
 * rules can be tested without a database.
 *
 * Pure and dependency-free.
 */

export type DiscountDraft = {
  code: string;
  description: string | null;
  discount_type: "fixed" | "percent";
  discount_value: number;
  max_discount_cents: number | null;
  minimum_subtotal_cents: number;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  max_total_uses: number | null;
  max_uses_per_customer: number | null;
  first_order_only: boolean;
  is_stackable: boolean;
};

export type DiscountDraftResult = { ok: true; draft: DiscountDraft } | { ok: false; problem: string };

/** Matches `discount_codes_code_shape` exactly. */
export const DISCOUNT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;

function optionalCount(value: unknown): number | null | undefined {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return undefined;
  const whole = Math.trunc(parsed);
  return whole > 0 ? whole : undefined;
}

function optionalTimestamp(value: unknown): string | null | undefined {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? at.toISOString() : undefined;
}

/**
 * Turns a staff form payload into a row, or explains the first problem.
 *
 * Money arrives as dollars from the form and is stored as cents; doing that
 * conversion here rather than in the route keeps a single definition of what
 * "minimum subtotal" means on the wire.
 */
export function buildDiscountDraft(input: Record<string, unknown>): DiscountDraftResult {
  // `normalizeDiscountCodeInput` truncates to 40 characters, which is right for
  // a *customer* submitting a code — it bounds the input and matches the
  // column. It is wrong here: silently storing the first 40 characters of a
  // longer code means staff hand out a code that will never match. Check the
  // raw length first and refuse.
  const raw = typeof input.code === "string" ? input.code.trim() : "";
  if (raw.length > 40) return { ok: false, problem: "A code is at most 40 characters." };

  const code = normalizeDiscountCodeInput(raw);
  if (!code) return { ok: false, problem: "Give the code a name." };
  if (!DISCOUNT_CODE_PATTERN.test(code)) {
    return {
      ok: false,
      problem: "A code is 3 to 40 characters, letters, digits, hyphens, or underscores, starting with a letter or digit.",
    };
  }

  const discountType = input.discountType === "percent" ? "percent" : "fixed";

  const rawValue = typeof input.discountValue === "number" ? input.discountValue : Number(input.discountValue);
  if (!Number.isFinite(rawValue)) return { ok: false, problem: "Give the discount a value." };

  // A percentage is stored as whole percent; a fixed amount as cents.
  const discountValue = discountType === "percent" ? Math.trunc(rawValue) : Math.round(rawValue * 100);

  if (discountType === "percent" && (discountValue < 1 || discountValue > 100)) {
    return { ok: false, problem: "A percentage discount is between 1 and 100." };
  }
  if (discountType === "fixed" && discountValue <= 0) {
    return { ok: false, problem: "A fixed discount has to be more than nothing." };
  }

  const maxDiscount = input.maxDiscount == null || input.maxDiscount === "" ? null : Number(input.maxDiscount);
  if (maxDiscount != null && (!Number.isFinite(maxDiscount) || maxDiscount <= 0)) {
    return { ok: false, problem: "A maximum discount has to be more than nothing, or left empty." };
  }

  const minimumSubtotal = input.minimumSubtotal == null || input.minimumSubtotal === "" ? 0 : Number(input.minimumSubtotal);
  if (!Number.isFinite(minimumSubtotal) || minimumSubtotal < 0) {
    return { ok: false, problem: "A minimum subtotal cannot be negative." };
  }

  const startsAt = optionalTimestamp(input.startsAt);
  if (startsAt === undefined) return { ok: false, problem: "That start date could not be read." };
  const endsAt = optionalTimestamp(input.endsAt);
  if (endsAt === undefined) return { ok: false, problem: "That end date could not be read." };
  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
    return { ok: false, problem: "The end date has to be after the start date." };
  }

  const maxTotalUses = optionalCount(input.maxTotalUses);
  if (maxTotalUses === undefined) return { ok: false, problem: "A total usage limit has to be a positive number, or empty." };
  const maxUsesPerCustomer = optionalCount(input.maxUsesPerCustomer);
  if (maxUsesPerCustomer === undefined) {
    return { ok: false, problem: "A per-customer limit has to be a positive number, or empty." };
  }

  const description = typeof input.description === "string" ? input.description.trim().slice(0, 300) : "";

  return {
    ok: true,
    draft: {
      code,
      description: description || null,
      discount_type: discountType,
      discount_value: discountValue,
      max_discount_cents: maxDiscount == null ? null : Math.round(maxDiscount * 100),
      minimum_subtotal_cents: Math.round(minimumSubtotal * 100),
      starts_at: startsAt,
      ends_at: endsAt,
      is_active: input.isActive !== false,
      max_total_uses: maxTotalUses,
      max_uses_per_customer: maxUsesPerCustomer,
      first_order_only: input.firstOrderOnly === true,
      is_stackable: input.isStackable === true,
    },
  };
}

export type TargetDraft = { target_type: "product" | "category"; target_id: string; is_exclusion: boolean };

/**
 * Normalizes the targeting rows for a code.
 *
 * Deduplicated on the same key as `discount_code_targets_unique`, so a form
 * that lists a product twice does not become a constraint violation. A product
 * both included and excluded keeps both rows — the exclusion wins at evaluation
 * time, and silently dropping one of them would hide the staff member's
 * contradiction rather than letting the list show it.
 */
export function buildTargetDrafts(value: unknown): TargetDraft[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const drafts: TargetDraft[] = [];

  for (const entry of value.slice(0, 200)) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const targetType = row.targetType === "category" ? "category" : row.targetType === "product" ? "product" : null;
    const targetId = typeof row.targetId === "string" ? row.targetId.trim() : "";
    if (!targetType || !targetId) continue;

    const isExclusion = row.isExclusion === true;
    const key = `${targetType}:${targetId}:${isExclusion}`;
    if (seen.has(key)) continue;
    seen.add(key);

    drafts.push({ target_type: targetType, target_id: targetId, is_exclusion: isExclusion });
  }

  return drafts;
}

/** A one-line summary of what a code is worth, for the staff list. */
export function discountValueLabel(code: Pick<DiscountDraft, "discount_type" | "discount_value">): string {
  return code.discount_type === "percent"
    ? `${code.discount_value}% off`
    : `$${(code.discount_value / 100).toFixed(2)} off`;
}

/**
 * Why a code is not currently usable, or null when it is.
 *
 * Deliberately the same order of checks as `evaluateDiscount`, so the staff
 * list never claims a code is live when a customer would be told otherwise.
 */
export function discountStatus(
  code: Pick<
    DiscountDraft,
    "is_active" | "starts_at" | "ends_at" | "max_total_uses"
  > & { archived_at?: string | null; total_uses?: number },
  now: Date = new Date()
): string | null {
  if (code.archived_at) return "Archived";
  if (!code.is_active) return "Inactive";
  if (code.starts_at && new Date(code.starts_at) > now) return "Not started";
  if (code.ends_at && new Date(code.ends_at) <= now) return "Expired";
  if (code.max_total_uses != null && (code.total_uses ?? 0) >= code.max_total_uses) return "Fully redeemed";
  return null;
}

export type { DiscountTarget };
