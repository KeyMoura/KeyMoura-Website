import type { Metadata } from "next";
import { getSiteSettings } from "@/lib/siteSettings";

/**
 * Signed-in area: titled for the browser, kept out of search results. The
 * template is re-declared so nested pages such as /orders/new and an
 * individual order still get the site suffix.
 */
export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSiteSettings();
  return {
    title: { default: "My orders", template: `%s | ${settings.name}` },
    robots: { index: false, follow: false },
  };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
