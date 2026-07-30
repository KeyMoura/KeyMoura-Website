import Link from "next/link";
import { siteConfig } from "@/site.config";

const currentYear = new Date().getFullYear();

export default function SiteFooter() {
  return (
    <footer className="mt-8 border-t border-zinc-800/80 bg-black/40">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-4 text-[11px] text-brand-textMuted md:flex-row">
        <p className="text-[11px] text-brand-textMuted">
          © {currentYear} {siteConfig.identity.name}. All rights reserved.
        </p>

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
