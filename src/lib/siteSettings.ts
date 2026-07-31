import "server-only";

import { cache } from "react";
import { installerAdmin } from "@/lib/installer/server";
import { siteConfig } from "@/site.config";

export type RuntimeSiteSettings = {
  name: string;
  shortName: string;
  description: string;
  tagline: string;
  url: string;
  logoUrl: string;
  primaryColor: string;
  accentColor: string;
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
  primaryColor: "#dc2626",
  accentColor: "#f59e0b",
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
      .select("site_name,description,public_url,logo_url,primary_color,accent_color,terminology")
      .eq("singleton", true)
      .maybeSingle();

    if (error || !data) return fallback;
    const name = data.site_name?.trim() || fallback.name;
    const terms = data.terminology as Record<string, unknown> | null;

    return {
      name,
      shortName: shortName(name),
      description: data.description?.trim() || fallback.description,
      tagline: data.description?.trim() || fallback.tagline,
      url: data.public_url || fallback.url,
      logoUrl: data.logo_url || fallback.logoUrl,
      primaryColor: data.primary_color || fallback.primaryColor,
      accentColor: data.accent_color || fallback.accentColor,
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
