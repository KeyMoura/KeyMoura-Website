import type { ReactNode } from "react";

import { StaffNav } from "@/components/staff/StaffNav";
import { StaffMobileNav } from "@/components/staff/StaffMobileNav";
import { StaffBreadcrumbs } from "@/components/staff/StaffBreadcrumbs";

/**
 * The staff shell.
 *
 * One navigation definition drives three surfaces: the desktop sidebar, the
 * mobile drawer and the breadcrumbs. Previously the sidebar was rendered twice
 * — once in the rail and once again inside a `<details>` for small screens —
 * which meant every link existed twice in the accessibility tree at all widths,
 * and the `<details>` copy was announced as a disclosure rather than a
 * navigation. The two are now separate components with separate semantics, and
 * each is hidden at the width where the other is correct.
 *
 * `.staff-nav` is already in the print stylesheet's blanket hide rule; the
 * drawer trigger carries `print-hidden` for the same reason.
 */
export default function StaffLayout({ children }: { children: ReactNode }) {
  return (
    <div className="page-container-wide">
      <div className="staff-shell">
        <div className="hidden lg:block">
          <StaffNav />
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
