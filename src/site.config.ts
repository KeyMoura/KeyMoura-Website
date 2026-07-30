/**
 * Deployment-level identity, terminology, navigation, and feature switches.
 *
 * Keep domain code generic and configure an individual community here. Feature
 * switches control discoverability only; API routes must still authorize every
 * request and should reject disabled modules as they are migrated.
 */
export const siteConfig = {
  identity: {
    name: "S-Chassis Resource Archive",
    shortName: "S-Chassis",
    description: "A collection of resources for the S-Chassis.",
    tagline: "One place for all your S-Chassis knowledge.",
    url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
    logo: {
      src: "/hero-silvia.png",
      alt: "S-Chassis Resource Archive",
    },
  },
  navigation: {
    primary: [
      { label: "Knowledge Base", href: "/info", module: "knowledgeBase" },
      { label: "Community", href: "/community", module: "forum" },
      { label: "Garage", href: "/garage", module: "garage" },
      { label: "Trusted Shops", href: "/shops", module: "trustedVendors" },
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
    garage: true,
    trustedVendors: true,
  },
} as const;

export type SiteModule = keyof typeof siteConfig.modules;

export function isModuleEnabled(module: SiteModule): boolean {
  return siteConfig.modules[module];
}
