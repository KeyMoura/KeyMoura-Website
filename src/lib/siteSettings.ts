import "server-only";

import { cache } from "react";
import { installerAdmin } from "@/lib/installer/server";
import { siteConfig } from "@/site.config";
import { defaultSiteTheme, normalizeSiteTheme, type SiteTheme } from "@/theme/runtime";

export type RuntimeSiteSettings = {
  name: string;
  shortName: string;
  description: string;
  tagline: string;
  url: string;
  logoUrl: string;
  wordmarkUrl: string;
  footerLogoUrl: string;
  faviconUrl: string;
  appleIconUrl: string;
  supportEmail: string;
  copyrightText: string;
  primaryColor: string;
  accentColor: string;
  theme: SiteTheme;
  terminology: {
    forum: string;
    knowledgeBase: string;
    trustedVendor: string;
  };
};


const fallback: RuntimeSiteSettings = {
  name: siteConfig.identity.name,
  shortName: siteConfig.identity.shortName,
  description: siteConfig.identity.description,
  tagline: siteConfig.identity.tagline,
  url: siteConfig.identity.url,
  logoUrl: siteConfig.identity.logo.src,
  wordmarkUrl: "",
  footerLogoUrl: siteConfig.identity.logo.src,
  faviconUrl: "/favicon.ico",
  appleIconUrl: "/apple-icon.png",
  supportEmail: "support@keymoura.com",
  copyrightText: "All rights reserved.",
  // Matches defaultSiteTheme and the built-in KeyMoura preset. The previous
  // value here was a red that no other default used and that fell below 4.5:1
  // against the default background wherever the primary color is used as text.
  primaryColor: "#fbbf24",
  accentColor: "#f59e0b",
  theme: defaultSiteTheme,
  terminology: {
    forum: siteConfig.terminology.forum,
    knowledgeBase: siteConfig.terminology.knowledgeBase,
    trustedVendor: siteConfig.terminology.trustedVendor,
  },
};

function shortName(name: string) {
  return name.length <= 24 ? name : name.split(/\s+/).slice(0, 2).join(" ");
}

export const getSiteSettings = cache(async (): Promise<RuntimeSiteSettings> => {
  try {
    const { data, error } = await installerAdmin()
      .from("site_settings")
      .select("site_name,description,public_url,logo_url,primary_color,accent_color,terminology,theme_config,branding_config")
      .eq("singleton", true)
      .maybeSingle();

    if (error || !data) return fallback;
    const name = data.site_name?.trim() || fallback.name;
    const terms = data.terminology as Record<string, unknown> | null;
    const branding = data.branding_config as Record<string, unknown> | null;
    const brandingString = (key: string, fallbackValue: string) =>
      typeof branding?.[key] === "string" ? String(branding[key]).trim() || fallbackValue : fallbackValue;

    return {
      name,
      shortName: brandingString("shortName", shortName(name)),
      description: data.description?.trim() || fallback.description,
      tagline: brandingString("tagline", data.description?.trim() || fallback.tagline),
      url: data.public_url || fallback.url,
      logoUrl: data.logo_url || fallback.logoUrl,
      wordmarkUrl: brandingString("wordmarkUrl", ""),
      footerLogoUrl: brandingString("footerLogoUrl", data.logo_url || fallback.footerLogoUrl),
      faviconUrl: brandingString("faviconUrl", fallback.faviconUrl),
      appleIconUrl: brandingString("appleIconUrl", fallback.appleIconUrl),
      supportEmail: brandingString("supportEmail", fallback.supportEmail),
      copyrightText: brandingString("copyrightText", fallback.copyrightText),
      primaryColor: data.primary_color || fallback.primaryColor,
      accentColor: data.accent_color || fallback.accentColor,
      theme: normalizeSiteTheme(data.theme_config),
      terminology: {
        forum: typeof terms?.forum === "string" ? terms.forum : fallback.terminology.forum,
        knowledgeBase:
          typeof terms?.knowledgeBase === "string"
            ? terms.knowledgeBase
            : fallback.terminology.knowledgeBase,
        trustedVendor:
          typeof terms?.trustedVendor === "string"
            ? terms.trustedVendor
            : fallback.terminology.trustedVendor,
      },
    };
  } catch {
    return fallback;
  }
});
