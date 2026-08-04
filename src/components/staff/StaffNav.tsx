"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useMeAccess } from "@/lib/hooks/useMeAccess";

type NavLink = { href: string; label: string; anyOf?: readonly string[] };
type NavGroup = { label: string; links: NavLink[] };

const hasAny = (permissions: Set<string>, required?: readonly string[]) =>
  !required?.length || required.some((permission) => permissions.has(permission));

export function StaffNav() {
  const pathname = usePathname();
  const { data: access } = useMeAccess();
  const permissions = new Set(access?.permissions ?? []);

  const groups: NavGroup[] = [
    {
      label: "Operations",
      links: [
        { href: "/staff", label: "Dashboard", anyOf: ["orders.view", "orders.manage", "catalog.view", "catalog.manage", "analytics.view"] },
        { href: "/staff/orders", label: "Orders", anyOf: ["orders.view", "orders.manage"] },
        { href: "/staff/production", label: "Production", anyOf: ["production.view", "production.manage"] },
        { href: "/staff/catalog", label: "Catalog & inventory", anyOf: ["catalog.view", "catalog.manage"] },
        { href: "/staff/catalog/discounts", label: "Discount codes", anyOf: ["catalog.discounts.manage"] },
        { href: "/staff/info/todo", label: "Staff to-do", anyOf: ["todo.view"] },
        { href: "/staff/info/analytics", label: "Analytics", anyOf: ["analytics.view"] },
      ],
    },
    {
      label: "Customers & content",
      links: [
        { href: "/staff/security/users", label: "Customers & users", anyOf: ["users.view"] },
        { href: "/staff/moderation/reports", label: "Reports & moderation", anyOf: ["moderation.reports.view"] },
        { href: "/staff/community", label: "Community", anyOf: ["community.view"] },
        { href: "/staff/shops", label: "Shops", anyOf: ["shops.view"] },
        { href: "/staff/info/pending", label: "Pending submissions", anyOf: ["info.pending.view"] },
        { href: "/staff/info/updates", label: "Content updates", anyOf: ["info.updates.view"] },
      ],
    },
    {
      label: "Brand & communication",
      links: [
        { href: "/staff/appearance", label: "Appearance", anyOf: ["appearance.manage"] },
        { href: "/staff/emails", label: "Email & notifications", anyOf: ["emails.manage"] },
      ],
    },
    {
      label: "Access & system",
      links: [
        { href: "/staff/settings", label: "Settings overview", anyOf: ["security.view", "roles.view", "audit.view", "audit.read", "recycle_bin.view", "appearance.manage", "emails.manage"] },
        { href: "/staff/security", label: "Security controls", anyOf: ["security.view"] },
        { href: "/staff/security/roles", label: "Roles & permissions", anyOf: ["roles.view"] },
        { href: "/staff/security/audit", label: "Audit log", anyOf: ["audit.view", "audit.read"] },
        { href: "/staff/security/recycle-bin", label: "Recycle bin", anyOf: ["recycle_bin.view"] },
        { href: "/staff/security/verified-perks", label: "Verified perks", anyOf: ["security.verified_perks.manage"] },
      ],
    },
  ];

  const isActive = (href: string) => {
    if (href === "/staff") return pathname === href;
    if (href === "/staff/settings") return pathname === href;
    if (href === "/staff/security") return pathname === href;
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  return (
    <nav aria-label="Staff navigation" className="staff-nav shadow-[0_10px_30px_rgba(0,0,0,0.35)] backdrop-blur-md lg:sticky lg:top-4">
      <div className="mb-4 border-b border-brand-border px-2 pb-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-accent">KeyMoura staff</p>
        <p className="mt-1 text-xs text-brand-textMuted">Store operations and site management</p>
      </div>
      <div className="space-y-5">
        {groups.map((group) => {
          const links = group.links.filter((link) => hasAny(permissions, link.anyOf));
          if (!links.length) return null;
          return (
            <section key={group.label} aria-labelledby={`staff-nav-${group.label.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
              <h2 id={`staff-nav-${group.label.toLowerCase().replace(/[^a-z]+/g, "-")}`} className="staff-nav-title px-2">{group.label}</h2>
              <div className="mt-2 space-y-1">
                {links.map((link) => {
                  const active = isActive(link.href);
                  return (
                    <Link key={link.href} href={link.href} aria-current={active ? "page" : undefined}
                      onClick={(event) => {
                        const menu = event.currentTarget.closest("details");
                        if (menu) menu.open = false;
                      }}
                      className="staff-nav-link min-h-10 text-[13px] font-medium">
                      {link.label}
                    </Link>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </nav>
  );
}
