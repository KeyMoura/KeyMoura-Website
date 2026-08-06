"use client";

import Link from "next/link";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { SentryTestPanel } from "@/components/staff/SentryTestPanel";
import { StaffNavIcon } from "@/components/staff/StaffNavIcon";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { visibleStaffNav } from "@/lib/staffNavigation";

/**
 * The settings index.
 *
 * The card list is derived from the Settings group of `@/lib/staffNavigation`
 * rather than being a third hand-written copy of it. Before this pass the
 * sidebar, the context bar and this page each held their own list; this page
 * was the only one of the three that knew `/staff/settings/commerce` existed,
 * which is why that page was reachable only from here or by typing the URL.
 *
 * The overview's own row is filtered out — a card linking to the page you are
 * already on is noise.
 */
export default function StaffSettingsPage() {
  const { data: access, isLoading } = useMeAccess();
  const permissions = new Set(access?.permissions ?? []);
  const settingsGroup = visibleStaffNav(permissions).find((group) => group.id === "settings");
  const tools = (settingsGroup?.items ?? []).filter((item) => item.href !== "/staff/settings");

  if (isLoading) return <div className="ui-card text-sm text-brand-textMuted">Loading settings…</div>;
  if (!tools.length) return <AccessDeniedCard message="You do not have access to staff settings." />;

  return (
    <main className="page-stack">
      <header>
        <p className="ui-eyebrow">Settings</p>
        <h1 className="mt-1 text-3xl font-semibold">Settings overview</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-brand-textMuted">
          Commerce rules, customer-facing design, communication, staff access and system controls. Day-to-day
          store work stays in Orders, Fulfillment, Catalog and Inventory.
        </p>
      </header>
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Settings categories">
        {tools.map((tool) => (
          <Link
            key={tool.href}
            href={tool.href}
            className="ui-card group min-h-40 transition hover:border-brand-accent/60 hover:bg-brand-accent/[.04]"
          >
            <span className="flex items-center gap-3">
              <StaffNavIcon icon={tool.icon} className="h-4 w-4 text-brand-accent" />
              <h2 className="text-lg font-semibold transition group-hover:text-brand-accent">{tool.label}</h2>
            </span>
            <p className="mt-2 text-sm leading-6 text-brand-textMuted">{tool.description}</p>
            <span className="mt-5 inline-block text-xs font-semibold text-brand-accent">Open settings →</span>
          </Link>
        ))}
      </section>
      {permissions.has("security.view") ? <SentryTestPanel /> : null}
    </main>
  );
}
