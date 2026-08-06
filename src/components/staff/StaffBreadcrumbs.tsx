"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { staffBreadcrumbs } from "@/lib/staffNavigation";

/**
 * The staff breadcrumb trail.
 *
 * Replaces `StaffContextBar`, which held its own second copy of the route
 * groupings — already drifted from the sidebar's, missing every route added
 * since it was written, and rendering nothing at all on the pages it did not
 * know about. This derives the trail from the one navigation definition, so a
 * new section gets breadcrumbs by existing.
 *
 * The group crumb is text, not a link: a group is an organisational heading,
 * not a destination. The old bar linked it to the first page inside the group,
 * which sent a reader somewhere they had not asked to go.
 */
export function StaffBreadcrumbs() {
  const pathname = usePathname();
  const crumbs = staffBreadcrumbs(pathname);
  if (crumbs.length < 2) return null;

  return (
    <nav aria-label="Breadcrumb" className="staff-breadcrumbs">
      <ol>
        {crumbs.map((crumb, index) => (
          <li key={`${crumb.label}-${index}`}>
            {index > 0 ? (
              <span className="staff-breadcrumb-separator" aria-hidden="true">
                /
              </span>
            ) : null}
            {crumb.current ? (
              <span aria-current="page" className="staff-breadcrumb-current">
                {crumb.label}
              </span>
            ) : crumb.href ? (
              <Link href={crumb.href} className="staff-breadcrumb-link">
                {crumb.label}
              </Link>
            ) : (
              <span className="staff-breadcrumb-group">{crumb.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
