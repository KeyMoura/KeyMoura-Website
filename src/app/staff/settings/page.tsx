"use client";

import Link from "next/link";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { SentryTestPanel } from "@/components/staff/SentryTestPanel";
import { StaffNavIcon } from "@/components/staff/StaffNavIcon";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { staffSettingsSections } from "@/lib/staffNavigation";

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
 *
 * The cards are grouped now rather than one flat grid of seven. Flat, "Recycle
 * bin" had the same visual weight as "Commerce", so the page could only be read
 * by examining every card; a shop owner looking for "where do I change
 * shipping" had no shape to navigate by.
 */
export default function StaffSettingsPage() {
  const { data: access, isLoading } = useMeAccess();
  const permissions = new Set(access?.permissions ?? []);
  const sections = staffSettingsSections(permissions);

  if (isLoading) return <div className="ui-card text-sm text-brand-textMuted">Loading settings…</div>;
  if (!sections.length) return <AccessDeniedCard message="You do not have access to staff settings." />;

  return (
    <main className="page-stack">
      <header>
        <p className="ui-eyebrow">Settings</p>
        <h1 className="mt-1 text-3xl font-semibold">Settings</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-brand-textMuted">
          Everything that is configured once and then left alone. Day-to-day work — taking orders, making
          things, shipping them, fixing stock — stays in Orders, Operations and Store.
        </p>
      </header>

      {sections.map((section) => (
        <section key={section.id} aria-labelledby={`settings-section-${section.id}`}>
          <h2 id={`settings-section-${section.id}`} className="text-sm font-semibold uppercase tracking-[.12em] text-brand-textMuted">
            {section.label}
          </h2>
          <p className="mt-1 text-sm text-brand-textMuted">{section.description}</p>
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {section.items.map((tool) => (
              <Link
                key={tool.href}
                href={tool.href}
                className="ui-card group min-h-40 transition hover:border-brand-accent/60 hover:bg-brand-accent/[.04]"
              >
                <span className="flex items-center gap-3">
                  <StaffNavIcon icon={tool.icon} className="h-4 w-4 text-brand-accent" />
                  <h3 className="text-lg font-semibold transition group-hover:text-brand-accent">{tool.label}</h3>
                </span>
                <p className="mt-2 text-sm leading-6 text-brand-textMuted">{tool.description}</p>
                <span className="mt-5 inline-block text-xs font-semibold text-brand-accent">Open →</span>
              </Link>
            ))}
          </div>
        </section>
      ))}

      {permissions.has("security.view") ? <SentryTestPanel /> : null}
    </main>
  );
}
