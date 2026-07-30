/**
 * Donation ranks displayed across the site.
 *
 * IMPORTANT: these keys must match the `profiles.donation_rank` check constraint in the database.
 */

export type DonationRankKey = "donor_5" | "donor_10" | "donor_25" | "donor_50" | "donor_100";

/**
 * NOTE:
 * Many Supabase selects in this repo type `donation_rank` as `string | null`.
 * We therefore accept `unknown` at component boundaries and validate against this union.
 */
export type DonationRank = DonationRankKey | null | undefined;

export type DonationRankMeta = {
  key: DonationRankKey;
  label: string;
  minUsd: number;
  colorHex: string;
};

/**
 * Centralized donation tier config (colors + labels).
 *
 * If you ever want to add more tiers, do it here AND update the DB constraint.
 */
export const DONATION_RANKS: Record<DonationRankKey, DonationRankMeta> = {
  donor_5: { key: "donor_5", label: "$5 Donation", minUsd: 5, colorHex: "#22c55e" },
  donor_10: { key: "donor_10", label: "$10 Donation", minUsd: 10, colorHex: "#38bdf8" },
  donor_25: { key: "donor_25", label: "$25 Donation", minUsd: 25, colorHex: "#a78bfa" },
  donor_50: { key: "donor_50", label: "$50 Donation", minUsd: 50, colorHex: "#f59e0b" },
  donor_100: { key: "donor_100", label: "$100 Donation", minUsd: 100, colorHex: "#fb7185" },
};

/**
 * Stable options suitable for a <select>.
 */
export const donationRankOptions: Array<{ value: DonationRankKey; label: string }> = (
  Object.values(DONATION_RANKS) as DonationRankMeta[]
)
  .slice()
  .sort((a, b) => a.minUsd - b.minUsd)
  .map((r) => ({ value: r.key, label: r.label }));

/**
 * Returns true when the provided value is a valid DonationRankKey.
 */
export function isDonationRankKey(value: unknown): value is DonationRankKey {
  return typeof value === "string" && value in DONATION_RANKS;
}

/**
 * Returns display metadata for a donation rank.
 */
export function getDonationRankMeta(rank: unknown): DonationRankMeta | null {
  if (!isDonationRankKey(rank)) return null;
  return DONATION_RANKS[rank];
}
