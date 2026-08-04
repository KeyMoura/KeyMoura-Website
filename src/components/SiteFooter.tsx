"use client";

import Link from "next/link";
import { useSiteSettings } from "@/components/SiteSettingsProvider";
import { footerNav } from "@/lib/navigation";

const currentYear = new Date().getFullYear();

/**
 * The site footer.
 *
 * Rebuilt around the business rather than around the navbar. The header answers
 * "where do I shop" and has room for four links; the footer answers "what are
 * the terms" — shipping, returns, cancellations, privacy — which is what a
 * customer looks for before committing to a custom order and could not find
 * anywhere else.
 *
 * It is deliberately not a copy of the navigation. The columns come from
 * `footerNav` in `@/lib/navigation`, which is a different list from `primaryNav`
 * for that reason, and it is where Community lands as a secondary destination
 * now that it is out of the header.
 *
 * Three real `<nav>` elements with their own accessible names, not one nav
 * wrapping everything: a screen reader lists landmarks, and "Shop", "The shop"
 * and "Support" are more useful than three unnamed navigations.
 */
export default function SiteFooter() {
  const siteSettings = useSiteSettings();

  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-brand">
          <div className="flex items-center gap-2">
            {siteSettings.footerLogoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={siteSettings.footerLogoUrl} alt="" className="h-7 w-auto object-contain" />
            ) : null}
            <span className="text-base font-semibold text-brand-text">{siteSettings.name}</span>
          </div>
          <p className="mt-3 max-w-sm text-sm leading-6">
            Custom routing and light machining — one-off parts, prototypes, fixtures, and short runs.
            Every request is reviewed and quoted before anything is charged.
          </p>
          <Link href="/orders/new" className="ui-btn ui-btn-primary mt-5 !min-h-11 !px-4 text-sm">
            Start a custom project
          </Link>
        </div>

        {footerNav.map((column) => (
          <nav key={column.heading} aria-label={column.heading} className="site-footer-column">
            <p className="site-footer-heading">{column.heading}</p>
            <div className="site-footer-links">
              {column.items.map((item) => (
                <Link key={item.href} href={item.href}>
                  {item.label}
                </Link>
              ))}
            </div>
          </nav>
        ))}
      </div>

      <div className="site-footer-base">
        <span>
          © {currentYear} {siteSettings.name}. {siteSettings.copyrightText}
        </span>
        {siteSettings.supportEmail ? (
          <a href={`mailto:${siteSettings.supportEmail}`} className="hover:text-brand-primary">
            {siteSettings.supportEmail}
          </a>
        ) : null}
      </div>
    </footer>
  );
}
