"use client";

import Link from "next/link";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { SentryTestPanel } from "@/components/staff/SentryTestPanel";
import { useMeAccess } from "@/lib/hooks/useMeAccess";

const tools = [
  { href: "/staff/appearance", title: "Appearance", description: "Brand identity, logos, customer-facing wording, colors, typography, spacing, and controls.", permissions: ["appearance.manage"] },
  { href: "/staff/settings/commerce", title: "Shipping, pickup & inventory", description: "Delivery methods and prices, destinations, local pickup, stock rules, and cancellation and return policy.", permissions: ["commerce.settings.view", "commerce.settings.manage"] },
  { href: "/staff/emails", title: "Email & notifications", description: "Sender details, staff alerts, customer email rules, templates, and delivery testing.", permissions: ["emails.manage"] },
  { href: "/staff/security", title: "Security controls", description: "Maintenance mode, lockdown, emergency messaging, IP restrictions, and administrative controls.", permissions: ["security.view"] },
  { href: "/staff/security/roles", title: "Roles & permissions", description: "Decide which staff roles can view and manage each area.", permissions: ["roles.view"] },
  { href: "/staff/security/audit", title: "Audit log", description: "Review sensitive staff and system actions.", permissions: ["audit.view", "audit.read"] },
  { href: "/staff/security/recycle-bin", title: "Recycle bin", description: "Review and restore recoverable moderated content.", permissions: ["recycle_bin.view"] },
] as const;

export default function StaffSettingsPage() {
  const { data: access, isLoading } = useMeAccess();
  const permissions = new Set(access?.permissions ?? []);
  const visibleTools = tools.filter((tool) => tool.permissions.some((permission) => permissions.has(permission)));

  if (isLoading) return <div className="ui-card text-sm text-brand-textMuted">Loading settings…</div>;
  if (!visibleTools.length) return <AccessDeniedCard message="You do not have access to staff settings." />;

  return (
    <main className="page-stack">
      <header>
        <p className="ui-eyebrow">Access & system</p>
        <h1 className="mt-1 text-3xl font-semibold">Settings overview</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-brand-textMuted">Customer-facing design, communication, staff access, and system controls are organized here. Store work stays in Orders and Catalog.</p>
      </header>
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Settings categories">
        {visibleTools.map((tool) => (
          <Link key={tool.href} href={tool.href} className="ui-card group min-h-40 transition hover:border-brand-accent/60 hover:bg-brand-accent/[.04]">
            <h2 className="text-lg font-semibold transition group-hover:text-brand-accent">{tool.title}</h2>
            <p className="mt-2 text-sm leading-6 text-brand-textMuted">{tool.description}</p>
            <span className="mt-5 inline-block text-xs font-semibold text-brand-accent">Open settings →</span>
          </Link>
        ))}
      </section>
      {permissions.has("security.view") ? <SentryTestPanel /> : null}
    </main>
  );
}
