import type { ReactNode } from "react";

import { StaffNav } from "@/components/staff/StaffNav";
import { StaffContextBar } from "@/components/staff/StaffContextBar";

/**
 * Shared staff layout.
 *
 * On mobile, the staff navigation is collapsible to match the main site UX.
 */
export default function StaffLayout({ children }: { children: ReactNode }) {
  return (
    <div className="page-container-wide">
      <div className="staff-shell">
        <div className="hidden lg:block">
          <StaffNav />
        </div>

        <div className="min-w-0">
          <details className="ui-card mb-4 lg:hidden">
            <summary className="flex list-none items-center justify-between gap-3 text-sm font-semibold text-[var(--text)]">
              <span>Staff menu</span>
              <span className="text-xs text-[var(--muted)]">Tap to open</span>
            </summary>
            <div className="mt-3">
              <StaffNav />
            </div>
          </details>

          <StaffContextBar />
          {children}
        </div>
      </div>
    </div>
  );
}
