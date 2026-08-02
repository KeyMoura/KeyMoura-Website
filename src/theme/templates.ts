import { defaultSiteTheme, normalizeSiteTheme, type SiteTheme } from "@/theme/runtime";

/**
 * Saved Appearance templates.
 *
 * A template is a reusable *look*: the two brand colors, the complete theme
 * (including every navbar and navbar-utility field), and the brand artwork.
 *
 * It deliberately does not carry business identity — name, public URL,
 * description, support email, copyright, or section labels. Those are facts
 * about the business rather than a visual choice, and applying a saved look
 * should never quietly rename the site or repoint its support address.
 */

export type TemplateAssets = {
  logoUrl: string;
  wordmarkUrl: string;
  footerLogoUrl: string;
  faviconUrl: string;
  appleIconUrl: string;
};

export type AppearanceTemplateConfig = {
  primaryColor: string;
  accentColor: string;
  theme: SiteTheme;
  assets: TemplateAssets;
};

export type AppearanceTemplate = AppearanceTemplateConfig & {
  id: string;
  name: string;
  updatedAt: string | null;
};

export const TEMPLATE_NAME_MAX = 60;

export const defaultTemplateAssets: TemplateAssets = {
  logoUrl: "/brand/keymoura-colored.png",
  wordmarkUrl: "",
  footerLogoUrl: "/brand/keymoura-colored.png",
  faviconUrl: "/favicon.ico",
  appleIconUrl: "/apple-icon.png",
};

const HEX = /^#[0-9a-f]{6}$/i;

function normalizeColor(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX.test(value.trim()) ? value.trim().toLowerCase() : fallback;
}

/**
 * An asset path must be site-relative or https. Anything else is dropped to the
 * default rather than stored, so a template can never smuggle in a foreign or
 * script-bearing URL.
 */
function normalizeAsset(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = value.trim().slice(0, 1000);
  if (!text) return "";
  if (text.startsWith("/") || /^https:\/\//i.test(text)) return text;
  return fallback;
}

function normalizeAssets(value: unknown): TemplateAssets {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    logoUrl: normalizeAsset(input.logoUrl, defaultTemplateAssets.logoUrl),
    wordmarkUrl: normalizeAsset(input.wordmarkUrl, defaultTemplateAssets.wordmarkUrl),
    footerLogoUrl: normalizeAsset(input.footerLogoUrl, defaultTemplateAssets.footerLogoUrl),
    faviconUrl: normalizeAsset(input.faviconUrl, defaultTemplateAssets.faviconUrl),
    appleIconUrl: normalizeAsset(input.appleIconUrl, defaultTemplateAssets.appleIconUrl),
  };
}

/**
 * Fills in anything a stored template is missing.
 *
 * Templates saved by an older build will not contain fields added later.
 * `normalizeSiteTheme` already backfills every theme key from the current
 * defaults, so an old template stays applicable instead of producing an
 * invalid theme, and newly added controls simply start at their default.
 */
export function normalizeAppearanceTemplateConfig(value: unknown): AppearanceTemplateConfig {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    primaryColor: normalizeColor(input.primaryColor, "#fbbf24"),
    accentColor: normalizeColor(input.accentColor, defaultSiteTheme.linkText),
    theme: normalizeSiteTheme(input.theme),
    assets: normalizeAssets(input.assets),
  };
}

/**
 * Trims a submitted template name and reports why it is unusable, if it is.
 *
 * Names are compared case-insensitively and after collapsing whitespace so
 * "Winter", "winter", and "Winter  " cannot coexist and confuse the list.
 */
export function normalizeTemplateName(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, TEMPLATE_NAME_MAX) : "";
}

export function templateNameKey(value: string): string {
  return normalizeTemplateName(value).toLowerCase();
}

export function templateNameError(value: unknown, existingNames: readonly string[] = []): string | null {
  const name = normalizeTemplateName(value);
  if (!name) return "Give the template a name.";
  if (existingNames.some((existing) => templateNameKey(existing) === templateNameKey(name))) {
    return `A template named “${name}” already exists.`;
  }
  return null;
}

/** Built-in starting points. These are code, and cannot be renamed or deleted. */
export const BUILT_IN_PRESETS: Record<string, AppearanceTemplateConfig> = {
  KeyMoura: {
    primaryColor: "#fbbf24",
    accentColor: "#f59e0b",
    theme: defaultSiteTheme,
    assets: defaultTemplateAssets,
  },
  Ember: {
    primaryColor: "#fb923c",
    accentColor: "#facc15",
    theme: {
      ...defaultSiteTheme,
      background: "#110c08",
      backgroundEnd: "#070504",
      surface: "#21140d",
      surfaceStrong: "#2b1a10",
    },
    assets: defaultTemplateAssets,
  },
  Graphite: {
    primaryColor: "#e4e4e7",
    accentColor: "#fbbf24",
    theme: {
      ...defaultSiteTheme,
      background: "#09090b",
      backgroundEnd: "#030303",
      surface: "#18181b",
      surfaceStrong: "#27272a",
    },
    assets: defaultTemplateAssets,
  },
};
