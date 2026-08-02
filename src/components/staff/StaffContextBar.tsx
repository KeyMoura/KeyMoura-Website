"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const contexts = [
  { prefixes: ["/staff/orders", "/staff/catalog", "/staff/info/todo", "/staff/info/analytics"], group: "Operations", href: "/staff" },
  { prefixes: ["/staff/security/users", "/staff/moderation", "/staff/community", "/staff/shops", "/staff/info/pending", "/staff/info/updates"], group: "Customers & content", href: "/staff/security/users" },
  { prefixes: ["/staff/appearance", "/staff/emails"], group: "Brand & communication", href: "/staff/settings" },
  { prefixes: ["/staff/settings", "/staff/security"], group: "Access & system", href: "/staff/settings" },
] as const;

export function StaffContextBar() {
  const pathname = usePathname();
  if (pathname === "/staff") return null;
  const context = contexts.find((item) => item.prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)));
  if (!context) return null;

  return (
    <div className="mb-5 flex flex-wrap items-center gap-2 text-xs text-brand-textMuted" aria-label="Staff page location">
      <Link href="/staff" className="transition hover:text-brand-accent">Staff</Link>
      <span aria-hidden="true">/</span>
      <Link href={context.href} className="font-medium text-brand-accent hover:underline">{context.group}</Link>
    </div>
  );
}
