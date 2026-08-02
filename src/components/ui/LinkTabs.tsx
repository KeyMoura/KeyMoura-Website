import Link from "next/link";
import type { ReactNode } from "react";

import { cx } from "@/components/ui/DesignSystem";

type LinkTab = {
  href: string;
  label: ReactNode;
  active?: boolean;
};

export function LinkTabs({
  tabs,
  ariaLabel,
  className,
}: {
  tabs: readonly LinkTab[];
  ariaLabel: string;
  className?: string;
}) {
  return (
    <nav className={cx("ui-tabs", className)} aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className={cx("ui-tab", tab.active && "is-active")}
          aria-current={tab.active ? "page" : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
