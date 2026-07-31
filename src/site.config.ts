/**
 * Deployment-level identity, terminology, navigation, and feature switches.
 *
 * Keep domain code generic and configure an individual community here. Feature
 * switches control discoverability only; API routes must still authorize every
 * request and should reject disabled modules as they are migrated.
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
  navigation: {
    primary: [
      { label: "Catalog", href: "/catalog" },
      { label: "Orders", href: "/orders" },
      { label: "Knowledge Base", href: "/info", module: "knowledgeBase" },
      { label: "Community", href: "/community", module: "forum" },
    ],
    legal: [
      { label: "Terms of Service", href: "/terms" },
      { label: "Privacy Policy", href: "/privacy" },
    ],
  },
  terminology: {
    forum: "Community",
    knowledgeBase: "Knowledge Base",
    thread: "Thread",
    post: "Post",
    trustedVendor: "Trusted Shop",
  },
  modules: {
    forum: true,
    knowledgeBase: true,
    moderation: true,
    reports: true,
    users: true,
    permissions: true,
    notifications: true,
    messaging: true,
    audit: true,
    security: true,
    garage: false,
    trustedVendors: false,
  },
} as const;

export type SiteModule = keyof typeof siteConfig.modules;

export function isModuleEnabled(module: SiteModule): boolean {
  return siteConfig.modules[module];
}
