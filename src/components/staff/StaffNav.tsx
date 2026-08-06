"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronDown, faAnglesLeft, faAnglesRight } from "@fortawesome/free-solid-svg-icons";

import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { parseStringArray, useStoredPreference } from "@/lib/hooks/useStoredPreference";
import {
  isStaffNavGroupActive,
  isStaffNavItemActive,
  visibleStaffNav,
  type StaffNavGroup,
} from "@/lib/staffNavigation";
import { StaffNavIcon } from "@/components/staff/StaffNavIcon";

/**
 * The desktop staff sidebar.
 *
 * Every destination comes from `@/lib/staffNavigation`, which the drawer and
 * the breadcrumbs also read — there is no second list to drift. Active state is
 * longest-prefix matching from that module rather than three hand-written
 * exceptions here.
 *
 * Two pieces of state are remembered in `localStorage`: which groups are
 * collapsed, and whether the rail is in compact mode. Both go through
 * `useStoredPreference`, which serves the default during server rendering and
 * hydration and switches to the stored value afterwards — so neither reading
 * storage during render (a hydration mismatch, and this project already carries
 * one) nor writing state from an effect (a cascading render on every mount) is
 * needed.
 */

const COLLAPSED_GROUPS_KEY = "km.staffNav.collapsedGroups";
const COMPACT_KEY = "km.staffNav.compact";

/** Stable module-scope defaults: a fresh `[]` each render would re-subscribe the store. */
const NO_COLLAPSED_GROUPS: readonly string[] = [];
const parseCompact = (raw: string) => raw === "true" || raw === "1";

export function StaffNav({ variant = "sidebar" }: { variant?: "sidebar" | "drawer" }) {
  const pathname = usePathname();
  const { data: access } = useMeAccess();
  const permissions = new Set(access?.permissions ?? []);
  const groups = visibleStaffNav(permissions);

  const [collapsedGroups, setCollapsedGroups] = useStoredPreference<readonly string[]>(
    COLLAPSED_GROUPS_KEY,
    NO_COLLAPSED_GROUPS,
    parseStringArray
  );
  const [compact, setCompact] = useStoredPreference(COMPACT_KEY, false, parseCompact);

  if (!groups.length) return null;

  const isCompact = variant === "sidebar" && compact;

  const toggleGroup = (id: string) => {
    setCollapsedGroups(
      collapsedGroups.includes(id) ? collapsedGroups.filter((value) => value !== id) : [...collapsedGroups, id]
    );
  };

  const toggleCompact = () => setCompact(!compact);

  const renderGroup = (group: StaffNavGroup) => {
    // A collapsed group that contains the current page is forced open: hiding
    // the row that says where you are is worse than ignoring a stored
    // preference for one render.
    const containsActive = isStaffNavGroupActive(group, pathname);
    const collapsed = !isCompact && collapsedGroups.includes(group.id) && !containsActive;
    const headingId = `staff-nav-group-${group.id}`;
    const listId = `staff-nav-items-${group.id}`;

    return (
      <section key={group.id} aria-labelledby={headingId} className="staff-nav-group">
        {isCompact ? (
          <h2 id={headingId} className="sr-only">
            {group.label}
          </h2>
        ) : (
          <h2 id={headingId}>
            <button
              type="button"
              onClick={() => toggleGroup(group.id)}
              aria-expanded={!collapsed}
              aria-controls={listId}
              className="staff-nav-group-toggle"
            >
              <span>{group.label}</span>
              <FontAwesomeIcon
                icon={faChevronDown}
                className={`staff-nav-chevron h-3 w-3 ${collapsed ? "is-collapsed" : ""}`}
                aria-hidden="true"
              />
            </button>
          </h2>
        )}

        {/* `hidden` rather than unmounting, so the browser's own
            find-in-page and the ids in `aria-controls` stay meaningful. */}
        <ul id={listId} hidden={collapsed} className="staff-nav-list">
          {group.items.map((item) => {
            const active = isStaffNavItemActive(item, pathname);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  title={isCompact ? item.label : undefined}
                  className="staff-nav-link"
                >
                  <StaffNavIcon icon={item.icon} className="staff-nav-link-icon h-4 w-4" />
                  <span className={isCompact ? "sr-only" : "staff-nav-link-label"}>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    );
  };

  return (
    <nav
      aria-label="Staff sections"
      data-compact={isCompact ? "true" : "false"}
      className={variant === "sidebar" ? "staff-nav lg:sticky lg:top-4" : "staff-nav staff-nav-in-drawer"}
    >
      {variant === "sidebar" ? (
        <div className="staff-nav-head">
          {!isCompact ? (
            <div className="min-w-0">
              <p className="staff-nav-brand">KeyMoura staff</p>
              <p className="staff-nav-brand-sub">Operations and site management</p>
            </div>
          ) : null}
          <button
            type="button"
            onClick={toggleCompact}
            aria-pressed={isCompact}
            className="staff-nav-compact-toggle"
            title={isCompact ? "Expand the sidebar" : "Collapse the sidebar"}
          >
            <FontAwesomeIcon
              icon={isCompact ? faAnglesRight : faAnglesLeft}
              className="h-3.5 w-3.5"
              aria-hidden="true"
            />
            <span className="sr-only">{isCompact ? "Expand the sidebar" : "Collapse the sidebar"}</span>
          </button>
        </div>
      ) : null}

      <div className="staff-nav-groups">{groups.map(renderGroup)}</div>
    </nav>
  );
}
