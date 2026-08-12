"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/account", label: "Overview", exact: true },
  { href: "/orders", label: "Orders & projects" },
  { href: "/account/support", label: "Support" },
  { href: "/account/profile", label: "Profile & sign-in" },
  { href: "/notifications", label: "Notifications" },
] as const;

/** One small, commerce-first navigation shared by every account page. */
export function AccountNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Customer account" className="border-b border-zinc-800 bg-black/20">
      <div className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 py-3 [scrollbar-width:none] sm:px-6">
        {ITEMS.map((item) => {
          const current = item.exact ? pathname === item.href : pathname.startsWith(item.href);
          return <Link key={item.href} href={item.href} aria-current={current ? "page" : undefined} className={`min-h-11 shrink-0 rounded-xl px-4 py-3 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-brand-primary ${current ? "bg-brand-primary/15 text-brand-primary" : "text-brand-textMuted hover:bg-white/5 hover:text-brand-text"}`}>{item.label}</Link>;
        })}
      </div>
    </nav>
  );
}
