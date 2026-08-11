"use client";

import Link from "next/link";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { StaffNavIcon } from "@/components/staff/StaffNavIcon";
import { LoadingState, PageHeader, Section, StaffPage } from "@/components/staff/StaffPage";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { staffSettingsSections } from "@/lib/staffNavigation";

/**
 * The settings directory.
 *
 * Derived from `staffSettingsSections`, which reads `settingsSection` across
 * the whole navigation. That matters more after this pass than before: Site
 * access, Verified perks, the Recycle bin, the Audit log and People & accounts
 * all moved into the sidebar's "More tools" disclosure, and a directory built
 * from sidebar group membership would have silently dropped every one of them.
 *
 * **Rows, not cards.** This was a grid of `min-h-40` cards — each one an icon, a
 * heading, a sentence and an "Open →" affordance, so eight destinations filled
 * two screens and the page could only be read by scanning every card in turn. A
 * directory's job is to be scanned; the row's height is now set by its content
 * and the four block headings do the grouping that eight identical boxes could
 * not.
 */
export default function StaffSettingsPage() {
  const { data: access, isLoading } = useMeAccess();
  const permissions = new Set(access?.permissions ?? []);
  const sections = staffSettingsSections(permissions);

  if (isLoading) return <LoadingState>Loading settings…</LoadingState>;
  if (!sections.length) return <AccessDeniedCard message="You do not have access to staff settings." />;

  return (
    <StaffPage>
      <PageHeader
        title="Settings"
        description="Everything that is configured once and then left alone. Day-to-day work — taking orders, making things, shipping them, fixing stock — lives in Orders, Production, Fulfillment and Store."
      />

      {sections.map((section) => (
        <Section key={section.id} title={section.label} description={section.description}>
          <div className="staff-rows">
            {section.items.map((tool) => (
              <Link key={tool.href} href={tool.href} className="staff-row">
                <span className="staff-row-main flex items-start gap-3">
                  <StaffNavIcon icon={tool.icon} className="mt-0.5 h-4 w-4 shrink-0 text-brand-accent" />
                  <span className="min-w-0">
                    <span className="staff-row-title block">{tool.label}</span>
                    <span className="staff-row-detail block">{tool.description}</span>
                  </span>
                </span>
                <span className="staff-row-aside text-xs font-semibold text-brand-accent" aria-hidden="true">
                  Open →
                </span>
              </Link>
            ))}
          </div>
        </Section>
      ))}
    </StaffPage>
  );
}
