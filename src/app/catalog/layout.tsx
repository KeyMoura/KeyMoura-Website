import type { Metadata } from "next";
import { getSiteSettings } from "@/lib/siteSettings";

/**
 * The title template is re-declared here because Next applies a template only
 * to the immediately nested segment. Without it, /catalog/[slug] would render
 * a bare product name with no site suffix.
 */
export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSiteSettings();
  return {
    title: { default: "Products", template: `%s | ${settings.name}` },
    description: `Ready designs and made-to-order parts from ${settings.name}.`,
    alternates: { canonical: "/catalog" },
  };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
