/**
 * Homepage merchandising, as far as Homepage 3.0 actually goes.
 *
 * ## What the homepage's imagery really is
 *
 * There is no homepage photography and there are no homepage image slots.
 * `HomeMedia` says so at length and it is worth restating here, because it
 * decides what this configuration can honestly offer: every frame on the
 * homepage — the hero, both capability panels, the focus section, the product
 * row — is a *product* photograph pulled from the catalog, and any frame with no
 * product behind it draws a plotted sheet instead of a gap.
 *
 * That means "upload a hero image" is not a small setting on this architecture.
 * It is a new kind of asset, a new column or config branch to hold it, a new
 * decision about what happens when it is missing, and a second image pipeline
 * beside the product one. The brief for this pass said not to build a generic
 * page builder and to expose only slots that exist, so this module exposes the
 * two slots that do exist, and the report says plainly what was deferred.
 *
 * ## The two slots
 *
 * - **Featured product** — the focus section, the single largest product on the
 *   page.
 * - **Hero product** — the lead frame above the fold.
 *
 * Both are pins over `allocateMedia`'s existing allocation, not a replacement
 * for it: an unset pin, or a pin at a product that is no longer published,
 * falls straight back to the ordering the page already had. That fallback is
 * the whole safety story — see `pinFeatured`.
 */

export type HomepageConfig = {
  /** Product id for the focus section, or "" to use catalog order. */
  featuredProductId: string;
  /** Product id for the hero's lead frame, or "" to use the rotation. */
  heroProductId: string;
};

export const defaultHomepageConfig: HomepageConfig = {
  featuredProductId: "",
  heroProductId: "",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A product id we are willing to store. Anything else becomes "" (unset). */
export function normalizeProductId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return UUID.test(trimmed) ? trimmed.toLowerCase() : "";
}

export function normalizeHomepageConfig(value: unknown): HomepageConfig {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const homepage =
    input.homepage && typeof input.homepage === "object"
      ? (input.homepage as Record<string, unknown>)
      : {};

  return {
    featuredProductId: normalizeProductId(homepage.featuredProductId),
    heroProductId: normalizeProductId(homepage.heroProductId),
  };
}

/**
 * Moves a pinned product to the front of a list, if it is in the list at all.
 *
 * **This is the entire safeguard against featuring a draft.** The list handed in
 * is whatever the public, row-level-security-backed catalog query returned — so
 * a product that is unpublished, archived, or deleted is simply not in it, the
 * `find` misses, and the page falls back to its normal ordering. The check is
 * "is it in the published list", never "does the id look plausible", because
 * only the first of those survives somebody unpublishing a product without
 * remembering it was on the front page.
 *
 * Returning a new array rather than sorting in place keeps the caller's own
 * allocation readable: it hands in the published list and gets back the same
 * products with one moved.
 */
export function pinFeatured<T extends { id: string }>(products: readonly T[], pinnedId: string): T[] {
  if (!pinnedId) return [...products];
  const index = products.findIndex((product) => product.id === pinnedId);
  if (index <= 0) return [...products];
  const copy = [...products];
  const [pinned] = copy.splice(index, 1);
  copy.unshift(pinned);
  return copy;
}

/** Whether a stored pin still points at something the public can see. */
export function isPinResolvable<T extends { id: string }>(
  products: readonly T[],
  pinnedId: string
): boolean {
  return Boolean(pinnedId) && products.some((product) => product.id === pinnedId);
}

/** The shape written back to `branding_config.homepage`. */
export function homepageConfigPayload(config: HomepageConfig): Record<string, unknown> {
  return {
    featuredProductId: config.featuredProductId,
    heroProductId: config.heroProductId,
  };
}
