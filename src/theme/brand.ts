/**
 * The brand mark, and the one place that decides which one the navbar shows.
 *
 * ## The problem this solves
 *
 * The site owns two logos — `keymoura-colored.png` and `keymoura-white.png` —
 * and until now only the first was reachable. `site_settings.logo_url` held a
 * single URL, so "use the white mark on interior pages" was not a setting; it
 * was a code change. The white file sat in `public/brand/` referenced by
 * nothing.
 *
 * Worse, the *shape* of the answer was spread out. `SiteHeader` rendered the
 * logo twice (desktop and mobile) and computed `isHome` for an unrelated hover
 * rule; the footer read a third field. Adding a route-dependent logo by
 * repeating `pathname === "/"` in each of those is how three surfaces end up
 * disagreeing about which page is the homepage.
 *
 * So there is exactly one function that answers "which mark, and is the name
 * beside it" — `resolveNavLogo` — and every navbar surface calls it. The brief
 * for this pass named that rule explicitly: one canonical navbar logo decision,
 * not a pathname test in several components.
 *
 * ## Variants are owner-controlled, not semantic
 *
 * "Primary" and "alternate" mean *slot one* and *slot two*. Nothing here knows
 * or assumes that one is colour and the other is white — an owner may upload
 * two colour marks, or a wordmark and a glyph, and the homepage/interior
 * selection still does what it says. Naming the slots after their current
 * contents is how a setting stops being true the first time somebody uses it
 * differently.
 */

export type BrandVariant = "primary" | "alternate";

export type BrandConfig = {
  /** Slot one. Falls back to the legacy single `logo_url`, so an existing site is unchanged. */
  primaryLogoUrl: string;
  /** Slot two. Empty means "not set" — every consumer then falls back to primary. */
  alternateLogoUrl: string;
  /** Which slot the homepage header uses. */
  homepageLogo: BrandVariant;
  /** Which slot every other page's header uses. */
  interiorLogo: BrandVariant;
  /** Whether the site name is drawn beside the mark in the header. */
  showBrandName: boolean;
};

export const defaultBrandConfig: BrandConfig = {
  primaryLogoUrl: "",
  alternateLogoUrl: "",
  homepageLogo: "primary",
  interiorLogo: "primary",
  showBrandName: true,
};

const VARIANTS: readonly BrandVariant[] = ["primary", "alternate"];

/**
 * Whether a stored asset reference is one this site is willing to render.
 *
 * The same rule the appearance route enforces on write: a site-root path or an
 * https URL. It is repeated on read because a value can predate the rule, and a
 * navbar is the wrong place to discover that.
 */
export function isSafeAssetRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return trimmed.startsWith("/") || /^https:\/\//i.test(trimmed);
}

function assetOrEmpty(value: unknown): string {
  return isSafeAssetRef(value) ? value.trim() : "";
}

function variantOr(value: unknown, fallback: BrandVariant): BrandVariant {
  return typeof value === "string" && VARIANTS.includes(value as BrandVariant)
    ? (value as BrandVariant)
    : fallback;
}

/**
 * Reads brand configuration out of `branding_config`, tolerating everything.
 *
 * `legacyLogoUrl` is `site_settings.logo_url` — the column the site has always
 * used. It seeds the primary slot so that a site which has never opened the new
 * editor renders exactly what it rendered before, and so that publishing once
 * does not blank the header.
 */
export function normalizeBrandConfig(value: unknown, legacyLogoUrl = ""): BrandConfig {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const brand =
    input.brand && typeof input.brand === "object" ? (input.brand as Record<string, unknown>) : {};

  const primary = assetOrEmpty(brand.primaryLogoUrl) || assetOrEmpty(legacyLogoUrl);

  return {
    primaryLogoUrl: primary,
    alternateLogoUrl: assetOrEmpty(brand.alternateLogoUrl),
    homepageLogo: variantOr(brand.homepageLogo, defaultBrandConfig.homepageLogo),
    interiorLogo: variantOr(brand.interiorLogo, defaultBrandConfig.interiorLogo),
    // Absent means true. The header has always shown the name, so an existing
    // site must not lose its wordmark by virtue of the setting being new.
    showBrandName: brand.showBrandName === undefined ? true : Boolean(brand.showBrandName),
  };
}

/** The URL for a named slot, falling back to primary when the slot is empty. */
export function brandLogoFor(brand: BrandConfig, variant: BrandVariant): string {
  if (variant === "alternate" && brand.alternateLogoUrl) return brand.alternateLogoUrl;
  return brand.primaryLogoUrl;
}

export type NavLogo = {
  /** The mark to draw, or "" when the site has no logo at all. */
  src: string;
  /** Which slot was chosen — used by the preview to label itself honestly. */
  variant: BrandVariant;
  /** Whether to draw the site name beside the mark. */
  showName: boolean;
  /**
   * The accessible name for the whole brand link.
   *
   * Always present, whatever `showName` says. Hiding the text must not remove
   * the site's identity from the accessibility tree — a logo with no accessible
   * name is a link announced as "link, image", which is where a screen-reader
   * user loses the way home. So the `<img>` stays `alt=""` (decorative, because
   * the text beside it would otherwise be read twice) and the *link* carries
   * this name.
   */
  label: string;
};

/**
 * The one navbar logo decision.
 *
 * Every header surface — desktop bar, mobile bar, drawer — calls this and
 * renders what it returns. `isHome` is passed in rather than read from a router
 * here so the function stays pure and testable; `SiteHeader` computes it once
 * from the pathname it already has.
 */
export function resolveNavLogo(
  brand: BrandConfig,
  { isHome, siteName }: { isHome: boolean; siteName: string }
): NavLogo {
  const variant = isHome ? brand.homepageLogo : brand.interiorLogo;
  return {
    src: brandLogoFor(brand, variant),
    variant,
    showName: brand.showBrandName,
    label: `${siteName} home`,
  };
}

/** The shape written back to `branding_config.brand`. */
export function brandConfigPayload(brand: BrandConfig): Record<string, unknown> {
  return {
    primaryLogoUrl: brand.primaryLogoUrl,
    alternateLogoUrl: brand.alternateLogoUrl,
    homepageLogo: brand.homepageLogo,
    interiorLogo: brand.interiorLogo,
    showBrandName: brand.showBrandName,
  };
}
