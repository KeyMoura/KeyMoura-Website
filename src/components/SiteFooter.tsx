"use client";

import Link from "next/link";
import { useSiteSettings } from "@/components/SiteSettingsProvider";

const currentYear = new Date().getFullYear();

export default function SiteFooter() {
  const siteSettings = useSiteSettings();
  return (
    <footer className="mt-8 border-t border-[var(--border)] bg-[var(--panel)]">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-4 text-[11px] text-brand-textMuted md:flex-row">
        <div className="flex items-center gap-2">
          {siteSettings.footerLogoUrl ? <img src={siteSettings.footerLogoUrl} alt="" className="h-6 w-auto object-contain" /> : null}
          <p className="text-[11px] text-brand-textMuted">
            © {currentYear} {siteSettings.name}. {siteSettings.copyrightText}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/terms"
            className="transition-colors hover:text-brand-primary"
          >
            Terms of Service
          </Link>
          <Link
            href="/privacy"
            className="transition-colors hover:text-brand-primary"
          >
            Privacy Policy
          </Link>
        </div>
      </div>
    </footer>
  );
}
