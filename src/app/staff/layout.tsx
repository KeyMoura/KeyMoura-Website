import type { ReactNode } from "react";

import { StaffShell } from "@/components/staff/StaffShell";

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
 * The layout itself stays a server component; `StaffShell` is the client
 * boundary, and it exists because the collapsed-rail width is a grid-column
 * decision rather than a sidebar decision. See its own comment.
 *
 * `.staff-nav` is already in the print stylesheet's blanket hide rule; the
 * drawer trigger carries `print-hidden` for the same reason.
 */
export default function StaffLayout({ children }: { children: ReactNode }) {
  return <StaffShell>{children}</StaffShell>;
}
