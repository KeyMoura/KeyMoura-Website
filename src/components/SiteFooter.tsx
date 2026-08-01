"use client";

import Link from "next/link";
import { useSiteSettings } from "@/components/SiteSettingsProvider";

const currentYear = new Date().getFullYear();

export default function SiteFooter() {
  const siteSettings = useSiteSettings();
  return (
    <footer className="mt-8 border-t border-[var(--border)] bg-[var(--panel)]">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-sm text-brand-textMuted md:grid-cols-[1.5fr_1fr_1fr]">
        <div>
          <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {siteSettings.footerLogoUrl ? <img src={siteSettings.footerLogoUrl} alt="" className="h-6 w-auto object-contain" /> : null}
          <span className="font-semibold text-brand-text">{siteSettings.name}</span>
          </div>
          <p className="mt-3 max-w-sm leading-6">Custom CNC parts, clear quoting, and order progress in one place.</p>
        </div>
        <nav aria-label="Shop"><p className="font-semibold text-brand-text">Shop</p><div className="mt-3 grid gap-2"><Link href="/catalog" className="hover:text-brand-primary">Catalog</Link><Link href="/orders/new" className="hover:text-brand-primary">Custom request</Link><Link href="/orders" className="hover:text-brand-primary">My orders</Link></div></nav>
        <nav aria-label="Information"><p className="font-semibold text-brand-text">Information</p><div className="mt-3 grid gap-2"><Link href="/info" className="hover:text-brand-primary">Guides</Link><Link href="/shipping" className="hover:text-brand-primary">Shipping</Link><Link href="/refunds" className="hover:text-brand-primary">Cancellations & refunds</Link><Link href="/terms" className="hover:text-brand-primary">Terms</Link><Link href="/privacy" className="hover:text-brand-primary">Privacy</Link></div></nav>
      </div>
      <div className="mx-auto max-w-6xl border-t border-[var(--border)] px-4 py-4 text-xs text-brand-textMuted">© {currentYear} {siteSettings.name}. {siteSettings.copyrightText}</div>
    </footer>
  );
}
