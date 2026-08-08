"use client";

import type { ReactNode } from "react";

import { useStoredPreference } from "@/lib/hooks/useStoredPreference";
import { StaffNav } from "@/components/staff/StaffNav";
import { StaffMobileNav } from "@/components/staff/StaffMobileNav";
import { StaffBreadcrumbs } from "@/components/staff/StaffBreadcrumbs";

/**
 * The staff shell, and the owner of the compact-rail preference.
 *
 * **Why this component exists at all.** Collapsing the sidebar used to hide the
 * labels and leave the sidebar exactly as wide as before. The compact state
 * lived inside `StaffNav` and was expressed as `data-compact` on the `<nav>`,
 * but the width is decided two levels above it:
 *
 *     div.staff-shell        grid-template-columns: 280px 1fr   <- decides width
 *       div (grid item)                                          <- fills 280px
 *         nav.staff-nav      data-compact="true"                 <- state was here
 *
 * Every compact rule (centred icons, `sr-only` labels, tighter padding) applied
 * inside a box whose width an ancestor had already fixed at 280px. The labels
 * genuinely left the layout — `sr-only` is `position: absolute` — and 280px of
 * empty panel stayed. No amount of work on the link styles could have fixed it;
 * the grid column had to learn about the state.
 *
 * So the preference is read here, on the element that owns the columns, and
 * passed down. `StaffNav` no longer reads storage for it: two components reading
 * the same key would be two subscriptions that can disagree for a frame, and the
 * one that mattered was the one that could not act on it.
 *
 * The mobile drawer is deliberately unaffected. Below `lg` the shell is a single
 * column and the rail is not rendered at all, so a compact preference set on a
 * desktop has nothing to do on a phone — the drawer stays a drawer.
 */

const COMPACT_KEY = "km.staffNav.compact";
const parseCompact = (raw: string) => raw === "true" || raw === "1";

export function StaffShell({ children }: { children: ReactNode }) {
  const [compact, setCompact] = useStoredPreference(COMPACT_KEY, false, parseCompact);

  return (
    <div className="page-container-wide">
      <div className="staff-shell" data-compact={compact ? "true" : "false"}>
        <div className="staff-shell-rail print-hidden">
          <StaffNav compact={compact} onToggleCompact={() => setCompact(!compact)} />
        </div>

        <div className="min-w-0">
          <div className="print-hidden mb-4 lg:hidden">
            <StaffMobileNav />
          </div>

          <StaffBreadcrumbs />
          {children}
        </div>
      </div>
    </div>
  );
}
