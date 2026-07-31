"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useMeAccess } from "@/lib/hooks/useMeAccess";

type NavLink = {
  href: string;
  label: string;
  /**
   * If provided, the link is only shown when the viewer has at least one of these permissions.
   */
  anyOf?: readonly string[];
};

function hasAny(perms: Set<string>, required?: readonly string[]): boolean {
  if (!required || !required.length) return true;
  for (const p of required) {
    if (perms.has(p)) return true;
  }
  return false;
}

/**
 * One consistent staff navigation for all /staff routes.
 */
export function StaffNav() {
  const pathname = usePathname();
  const { data: access } = useMeAccess();

  const perms = new Set(access?.permissions ?? []);

  // Nav visibility rule: ONLY show a page button if the viewer has that page's .view permission.
  // (Moderation/manage perms do NOT imply view in the UI; keep it explicit.)
  const canSeeModeration = hasAny(perms, ["moderation.reports.view"]);
  const canSeeAudit = hasAny(perms, ["audit.view", "audit.read"]);
  const canSeeTodo = hasAny(perms, ["todo.view"]);
  const canSeeUsers = hasAny(perms, ["users.view"]);
  const canSeeRecycleBin = hasAny(perms, ["recycle_bin.view"]);
  const canSeeSecurity = hasAny(perms, ["security.view"]);
  const canSeeCommunity = hasAny(perms, ["community.view"]);
  const canSeeShops = hasAny(perms, ["shops.view"]);
  const canSeeAnalytics = hasAny(perms, ["analytics.view"]);
  const canSeeCatalog = hasAny(perms, ["catalog.view", "catalog.manage"]);
  const canSeeOrders = hasAny(perms, ["orders.view", "orders.manage"]);
  const canManageAppearance = hasAny(perms, ["appearance.manage"]);
  // The INFO section is specifically for the info submission/update queues.
  // To-do is its own top-level staff tool.
  const canSeeInfo = hasAny(perms, ["info.pending.view", "info.updates.view"]);

  const topLinks: NavLink[] = [
    ...(canSeeOrders ? [{ href: "/staff/orders", label: "Orders" } satisfies NavLink] : []),
    ...(canSeeCatalog ? [{ href: "/staff/catalog", label: "Catalog" } satisfies NavLink] : []),
    ...(canManageAppearance ? [{ href: "/staff/appearance", label: "Appearance" } satisfies NavLink] : []),
    ...(canSeeAnalytics ? [{ href: "/staff/info/analytics", label: "Analytics" } satisfies NavLink] : []),
    ...(canSeeModeration ? [{ href: "/staff/moderation/reports", label: "Reports" } satisfies NavLink] : []),
    ...(canSeeAudit ? [{ href: "/staff/security/audit", label: "Audit Log" } satisfies NavLink] : []),
    ...(canSeeTodo ? [{ href: "/staff/info/todo", label: "To-do" } satisfies NavLink] : []),
    ...(canSeeRecycleBin ? [{ href: "/staff/security/recycle-bin", label: "Recycle Bin" } satisfies NavLink] : []),
    ...(canSeeUsers ? [{ href: "/staff/security/users", label: "Users" } satisfies NavLink] : []),
    ...(canSeeSecurity ? [{ href: "/staff/security", label: "Security" } satisfies NavLink] : []),
    ...(canSeeCommunity ? [{ href: "/staff/community", label: "Community" } satisfies NavLink] : []),
    ...(canSeeShops ? [{ href: "/staff/shops", label: "Shops" } satisfies NavLink] : []),
  ];

  const securityLinks: NavLink[] = [
    { href: "/staff/security/roles", label: "Roles", anyOf: ["roles.view"] },
    { href: "/staff/security/verified-perks", label: "Verified Perks", anyOf: ["security.verified_perks.manage"] },
  ];

  const infoLinks: NavLink[] = [
    { href: "/staff/info/pending", label: "Pending", anyOf: ["info.pending.view"] },
    { href: "/staff/info/updates", label: "Updates", anyOf: ["info.updates.view"] },
  ];

  // Active state rules:
  // - Most links are active for the exact page OR any nested route.
  // - The Security root button should NOT stay highlighted when you're in a specific security tool
  //   (Users / Roles / Permissions / Audit / Recycle Bin). Those have their own buttons.
  const isActive = (href: string) => {
    if (href === "/staff/security") return pathname === "/staff/security";
    return pathname === href || pathname.startsWith(href + "/");
  };

  // Match SiteHeader's pill aesthetic.
  const pillBase =
    "inline-flex items-center justify-between gap-2 rounded-full border px-3 py-2 text-[13px] font-medium tracking-wide transition-all";
  const pillActive =
    "border-brand-primary/70 bg-black/60 text-brand-primary shadow-[0_0_10px_rgba(126,230,255,0.22)]";
  const pillIdle =
    "border-transparent text-brand-textMuted hover:border-brand-primary/50 hover:bg-black/50 hover:text-brand-primary hover:shadow-[0_0_8px_rgba(126,230,255,0.16)] hover:-translate-y-[1px]";

  const renderLink = (l: NavLink) => {
    if (l.anyOf && !hasAny(perms, l.anyOf)) return null;
    const active = isActive(l.href);
    return (
      <Link
        key={l.href}
        href={l.href}
        aria-current={active ? "page" : undefined}
        className={`${pillBase} ${active ? pillActive : pillIdle}`}
        onClick={(e) => {
          const target = e.currentTarget as unknown as HTMLElement;
          const details = target?.closest?.("details") as HTMLDetailsElement | null;
          if (details) details.open = false;
        }}
      >
        {l.label}
      </Link>
    );
  };

  return (
    <nav
      aria-label="Staff navigation"
      className="sticky top-4 rounded-2xl border border-white/10 bg-black/35 p-4 shadow-[0_10px_30px_rgba(0,0,0,0.45)] backdrop-blur-md"
    >
      <div className="flex flex-col gap-5">
        <div>
          <div className="text-[11px] font-semibold tracking-[0.18em] text-brand-textMuted">STAFF</div>
          <div className="mt-3 flex flex-col gap-1.5">{topLinks.map((l) => renderLink(l))}</div>
        </div>

        {canSeeSecurity ? (
          <div>
            <div className="text-[11px] font-semibold tracking-[0.18em] text-brand-textMuted">SECURITY</div>
            <div className="mt-3 flex flex-col gap-1.5">{securityLinks.map((l) => renderLink(l))}</div>
          </div>
        ) : null}

        {canSeeInfo ? (
          <div>
            <div className="text-[11px] font-semibold tracking-[0.18em] text-brand-textMuted">INFO</div>
            <div className="mt-3 flex flex-col gap-1.5">{infoLinks.map((l) => renderLink(l))}</div>
          </div>
        ) : null}
      </div>
    </nav>
  );
}
