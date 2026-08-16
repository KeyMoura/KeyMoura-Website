import type { Metadata } from "next";
import { getSiteSettings } from "@/lib/siteSettings";
import { catalogViewScript } from "@/lib/commerce/catalogView";

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
  return (
    <>
      {/*
        The result-layout preference, applied before first paint.

        The alternative — letting the React control set it after hydration —
        renders three columns and then reflows to the customer's four, which is
        a visible jump on the page's main content every single visit. It is what
        makes the list view possible at all without a flash: a component chosen
        from React state could not be chosen until hydration, so a customer who
        prefers rows would watch cards draw first, every time. This runs during
        HTML parsing, so the first layout is already right.

        It stamps the attribute on every visit now, not only when something is
        stored: List is the canonical default, and a first-time visitor has to
        get it before paint rather than after. If it throws, or scripting is off,
        the attribute is absent and the CSS falls through to the same List
        layout — `:root:not([data-catalog-density])` in `globals.css` — so the
        default is stated once and honoured in both paths.
      */}
      <script dangerouslySetInnerHTML={{ __html: catalogViewScript }} />
      {children}
    </>
  );
}
