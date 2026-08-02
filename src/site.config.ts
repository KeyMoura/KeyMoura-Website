/**
 * Build-time identity fallback.
 *
 * The live values come from `site_settings` and are edited in /staff/appearance
 * (see `src/lib/siteSettings.ts`). This module is only consulted before the
 * database is reachable — during a cold build, or if the settings query fails —
 * so it must stay small and must not drift into a second source of truth.
 */
export const siteConfig = {
  identity: {
    name: "KeyMoura",
    shortName: "KeyMoura",
    description: "Custom parts, products, and made-to-order projects.",
    tagline: "Built around your idea.",
    url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
    logo: {
      src: "/brand/keymoura-colored.png",
      alt: "KeyMoura",
    },
  },
  terminology: {
    forum: "Community",
    knowledgeBase: "Projects",
    trustedVendor: "Trusted Shop",
  },
} as const;
