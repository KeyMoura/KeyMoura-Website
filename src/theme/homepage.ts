/**
 * What the owner controls on the front page.
 *
 * ## Where this lives, and why there is no migration
 *
 * Everything here is a branch of `site_settings.branding_config`, the JSONB
 * document that already carries the brand marks and the announcement bar. That
 * was the deciding question for this pass: homepage configuration either fits
 * the settings architecture that exists or it needs a schema, and a schema needs
 * authorization. It fits. Every field below is a string, a boolean or a product
 * id, read through one normalizer, defaulting to the value the page already
 * renders.
 *
 * ## What is configurable, and what deliberately is not
 *
 * The homepage is a designed page, not a page builder. `lib/home/content.ts`
 * holds every sentence on it and explains at length which claims the business
 * can actually back — that module stays the source of the defaults, and it stays
 * the thing a test reads when it checks the page is not inventing credentials.
 *
 * What an owner gets is the **business-level** layer over it:
 *
 * - the hero's eyebrow, headline, supporting paragraph and two buttons, because
 *   those are the sentences that change when the shop's offer changes;
 * - a hero image, because "paste a URL" was the previous answer and it was the
 *   wrong one;
 * - which product leads the page and which fills the focus frame;
 * - whether five optional marketing bands appear at all.
 *
 * What stays in code: the section order, the scroll cue, the four assurances,
 * the process steps, and every structural section. `SECTION_TOGGLES` records
 * which bands are optional and the comment on it records why the others are not.
 * Reordering is not offered either — the media allocation in `app/page.tsx`
 * depends on the focus section reading the catalog first, so "move the focus
 * band below the row" is not a reorder, it is a different allocation.
 */

export type HomepageCta = { label: string; href: string };

/**
 * The marketing bands an owner may switch off.
 *
 * The line is drawn at *whether the page still makes its offer without it*. The
 * five below are elaboration: proof of range, proof of method, proof of recent
 * work, proof of terms. A shop that would rather lead with its catalog alone can
 * drop all five and still have a page that says what it sells, shows it, and
 * offers both ways to buy.
 *
 * The five that are **not** here — hero, capabilities, the product row, the
 * custom-project band and the closing call to action — carry the page's actual
 * offer and both of its conversion paths. Hiding those does not customise the
 * homepage, it removes it, and an editor that lets somebody do that by accident
 * on a Friday afternoon has mis-sold the word "optional".
 */
export const SECTION_TOGGLES = [
  {
    id: "productFocus",
    label: "Featured build",
    description: "The large single product partway down the page, with its own heading.",
  },
  {
    id: "process",
    label: "How it works",
    description: "The four steps from drawing to delivery.",
  },
  {
    id: "making",
    label: "What we make",
    description: "The materials and formats band.",
  },
  {
    id: "recentWork",
    label: "Made recently",
    description: "Your most recent published project write-ups. Hides itself when there are none.",
  },
  {
    id: "assurances",
    label: "What to expect",
    description: "The four trust statements about payment, review, checkout and the order hub.",
  },
] as const;

export type HomepageSectionId = (typeof SECTION_TOGGLES)[number]["id"];

export type HomepageConfig = {
  /** Product id for the focus section, or "" to use catalog order. */
  featuredProductId: string;
  /** Product id for the hero's lead frame, or "" to use the rotation. */
  heroProductId: string;
  /**
   * An uploaded image for the hero's lead frame.
   *
   * Takes precedence over `heroProductId` when set, because an owner who has
   * gone to the trouble of uploading artwork means it. Empty is the normal
   * state and falls straight back to the product photograph.
   */
  heroImageUrl: string;
  /** Hero copy. Empty means "use the shipped wording" — see `resolveHomepageHero`. */
  heroEyebrow: string;
  heroTitleLead: string;
  heroTitleAccent: string;
  heroLede: string;
  heroPrimaryCtaLabel: string;
  heroPrimaryCtaHref: string;
  heroSecondaryCtaLabel: string;
  heroSecondaryCtaHref: string;
  /** Which optional bands are shown. Absent means shown. */
  sections: Record<HomepageSectionId, boolean>;
};

export const defaultHomepageConfig: HomepageConfig = {
  featuredProductId: "",
  heroProductId: "",
  heroImageUrl: "",
  heroEyebrow: "",
  heroTitleLead: "",
  heroTitleAccent: "",
  heroLede: "",
  heroPrimaryCtaLabel: "",
  heroPrimaryCtaHref: "",
  heroSecondaryCtaLabel: "",
  heroSecondaryCtaHref: "",
  sections: {
    productFocus: true,
    process: true,
    making: true,
    recentWork: true,
    assurances: true,
  },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A product id we are willing to store. Anything else becomes "" (unset). */
export function normalizeProductId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return UUID.test(trimmed) ? trimmed.toLowerCase() : "";
}

/** Copy lengths. Long enough for the real sentences, short enough to stay a headline. */
export const HERO_EYEBROW_MAX = 60;
export const HERO_TITLE_MAX = 60;
export const HERO_LEDE_MAX = 400;
export const HERO_CTA_LABEL_MAX = 32;

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

/**
 * A destination this site is willing to put in a homepage button.
 *
 * The same rule the announcement link uses, and for the same reason: a site-root
 * path or an https URL, nothing else. These become `href`s above the fold on the
 * most-visited page, so `javascript:` and `data:` are refused here rather than
 * being caught later by something else.
 */
export function normalizeHomepageHref(value: unknown): string {
  const trimmed = text(value, 500);
  if (!trimmed) return "";
  if (trimmed.startsWith("/")) return trimmed;
  return /^https:\/\//i.test(trimmed) ? trimmed : "";
}

/** An uploaded or referenced image. Same asset rule the brand marks use. */
function assetOrEmpty(value: unknown): string {
  const trimmed = text(value, 1000);
  if (!trimmed) return "";
  return trimmed.startsWith("/") || /^https:\/\//i.test(trimmed) ? trimmed : "";
}

export function normalizeHomepageConfig(value: unknown): HomepageConfig {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const homepage =
    input.homepage && typeof input.homepage === "object"
      ? (input.homepage as Record<string, unknown>)
      : {};

  const stored =
    homepage.sections && typeof homepage.sections === "object"
      ? (homepage.sections as Record<string, unknown>)
      : {};

  const sections = {} as Record<HomepageSectionId, boolean>;
  for (const toggle of SECTION_TOGGLES) {
    // Absent means shown. A section that is new to the settings document must
    // appear for a site that has never opened this editor, not vanish from it.
    sections[toggle.id] = stored[toggle.id] === undefined ? true : Boolean(stored[toggle.id]);
  }

  return {
    featuredProductId: normalizeProductId(homepage.featuredProductId),
    heroProductId: normalizeProductId(homepage.heroProductId),
    heroImageUrl: assetOrEmpty(homepage.heroImageUrl),
    heroEyebrow: text(homepage.heroEyebrow, HERO_EYEBROW_MAX),
    heroTitleLead: text(homepage.heroTitleLead, HERO_TITLE_MAX),
    heroTitleAccent: text(homepage.heroTitleAccent, HERO_TITLE_MAX),
    heroLede: text(homepage.heroLede, HERO_LEDE_MAX),
    heroPrimaryCtaLabel: text(homepage.heroPrimaryCtaLabel, HERO_CTA_LABEL_MAX),
    heroPrimaryCtaHref: normalizeHomepageHref(homepage.heroPrimaryCtaHref),
    heroSecondaryCtaLabel: text(homepage.heroSecondaryCtaLabel, HERO_CTA_LABEL_MAX),
    heroSecondaryCtaHref: normalizeHomepageHref(homepage.heroSecondaryCtaHref),
    sections,
  };
}

export type ResolvedHero = {
  eyebrow: string;
  titleLead: string;
  titleAccent: string;
  lede: string;
  primary: HomepageCta;
  secondary: HomepageCta;
};

/**
 * The hero the page actually renders: the owner's wording where they gave one,
 * the shipped wording everywhere else.
 *
 * Per field, not per object. An owner who rewrites only the headline keeps the
 * shipped eyebrow and buttons, which is the behaviour they expect and the reason
 * empty is stored rather than the default being copied in on first save — a
 * copied default freezes, and the next time the shipped copy improves this site
 * would be the one still showing the old sentence.
 *
 * A button needs *both* halves to be overridden. A label with no destination is
 * a button that goes nowhere, so the pair falls back together.
 */
export function resolveHomepageHero(config: HomepageConfig, defaults: ResolvedHero): ResolvedHero {
  const cta = (label: string, href: string, fallback: HomepageCta): HomepageCta =>
    label && href ? { label, href } : fallback;

  return {
    eyebrow: config.heroEyebrow || defaults.eyebrow,
    titleLead: config.heroTitleLead || defaults.titleLead,
    titleAccent: config.heroTitleAccent || defaults.titleAccent,
    lede: config.heroLede || defaults.lede,
    primary: cta(config.heroPrimaryCtaLabel, config.heroPrimaryCtaHref, defaults.primary),
    secondary: cta(config.heroSecondaryCtaLabel, config.heroSecondaryCtaHref, defaults.secondary),
  };
}

/** Whether an optional band is shown. Unknown ids are shown, never hidden. */
export function isHomepageSectionVisible(config: HomepageConfig, id: HomepageSectionId): boolean {
  return config.sections[id] !== false;
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
    heroImageUrl: config.heroImageUrl,
    heroEyebrow: config.heroEyebrow,
    heroTitleLead: config.heroTitleLead,
    heroTitleAccent: config.heroTitleAccent,
    heroLede: config.heroLede,
    heroPrimaryCtaLabel: config.heroPrimaryCtaLabel,
    heroPrimaryCtaHref: config.heroPrimaryCtaHref,
    heroSecondaryCtaLabel: config.heroSecondaryCtaLabel,
    heroSecondaryCtaHref: config.heroSecondaryCtaHref,
    sections: { ...config.sections },
  };
}
