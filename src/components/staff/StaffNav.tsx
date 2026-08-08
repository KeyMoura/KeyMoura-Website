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
 * Which groups are collapsed is remembered in `localStorage` through
 * `useStoredPreference`, which serves the default during server rendering and
 * hydration and switches to the stored value afterwards — so neither reading
 * storage during render (a hydration mismatch, and this project already carries
 * one) nor writing state from an effect (a cascading render on every mount) is
 * needed.
 *
 * **Compact mode is not owned here.** It is passed in by `StaffShell`, because
 * the rail's width is set by the shell's grid column and this component cannot
 * reach it. Reading the same preference in both places would be two
 * subscriptions that can disagree for a frame.
 */

/**
 * Which groups the reader has flipped away from their default state.
 *
 * Storing *deviations* rather than "the collapsed ones" is what lets primary
 * groups default to open and "More tools" default to closed while both use one
 * mechanism. The key is new this pass: the old one held group ids
 * (`operations`, `content`, `customers`) that no longer exist, so honouring it
 * would have collapsed nothing and confused everything.
 */
const TOGGLED_GROUPS_KEY = "km.staffNav.toggledGroups";

/** Stable module-scope defaults: a fresh `[]` each render would re-subscribe the store. */
const NO_TOGGLED_GROUPS: readonly string[] = [];

export function StaffNav({
  variant = "sidebar",
  compact = false,
  onToggleCompact,
}: {
  variant?: "sidebar" | "drawer";
  compact?: boolean;
  onToggleCompact?: () => void;
}) {
  const pathname = usePathname();
  const { data: access } = useMeAccess();
  const permissions = new Set(access?.permissions ?? []);
  const groups = visibleStaffNav(permissions);

  const [toggledGroups, setToggledGroups] = useStoredPreference<readonly string[]>(
    TOGGLED_GROUPS_KEY,
    NO_TOGGLED_GROUPS,
    parseStringArray
  );

  if (!groups.length) return null;

  const isCompact = variant === "sidebar" && compact;

  const toggleGroup = (id: string) => {
    setToggledGroups(
      toggledGroups.includes(id) ? toggledGroups.filter((value) => value !== id) : [...toggledGroups, id]
    );
  };

  const renderGroup = (group: StaffNavGroup) => {
    // A collapsed group that contains the current page is forced open: hiding
    // the row that says where you are is worse than ignoring a stored
    // preference for one render.
    const containsActive = isStaffNavGroupActive(group, pathname);
    const flipped = toggledGroups.includes(group.id);
    /*
     * Primary groups are open until flipped; "More tools" is closed until it is.
     *
     * The compact rail forces primary groups open — there is nothing to collapse
     * when every label is already hidden — but **not** the secondary group. A
     * compact rail that unfolded eleven diagnostic icons under the four that
     * matter would be exactly the wall of undifferentiated targets this pass
     * removed from the expanded sidebar.
     */
    const collapsed = !containsActive && (group.secondary ? !flipped : !isCompact && flipped);
    const headingId = `staff-nav-group-${group.id}`;
    const listId = `staff-nav-items-${group.id}`;

    /*
     * A one-item primary group renders as a bare row.
     *
     * Dashboard, Orders, Production and Fulfillment are each a single
     * destination. Giving each of them a collapsible heading above one link
     * would double the sidebar's height to say every name twice, and would
     * offer a "collapse" control whose only effect is hiding the one thing the
     * heading names.
     */
    const bare = !group.secondary && group.items.length === 1 && group.items[0].label === group.label;
    // The secondary group keeps its control in the compact rail, as an icon.
    const showToggle = !bare && (!isCompact || group.secondary);

    return (
      <section key={group.id} aria-labelledby={headingId} className="staff-nav-group">
        {showToggle ? (
          <h2 id={headingId}>
            <button
              type="button"
              onClick={() => toggleGroup(group.id)}
              aria-expanded={!collapsed}
              aria-controls={listId}
              className={`staff-nav-group-toggle${group.secondary ? " is-secondary" : ""}`}
            >
              <span className={isCompact ? "sr-only" : undefined}>{group.label}</span>
              <FontAwesomeIcon
                icon={faChevronDown}
                className={`staff-nav-chevron h-3 w-3 ${collapsed ? "is-collapsed" : ""}`}
                aria-hidden="true"
              />
            </button>
          </h2>
        ) : (
          <h2 id={headingId} className="sr-only">
            {group.label}
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
                  className="staff-nav-link"
                >
                  <StaffNavIcon icon={item.icon} className="staff-nav-link-icon h-4 w-4" />
                  {/* `sr-only` is `position: absolute`, so the label leaves the
                      layout entirely rather than reserving width — but it stays
                      the link's accessible name, which is the whole point of an
                      icon-only rail. */}
                  <span className={isCompact ? "sr-only" : "staff-nav-link-label"}>{item.label}</span>
                  {/* A real tooltip rather than `title`. No browser raises a
                      `title` on keyboard focus, so a keyboard user tabbing a
                      collapsed rail previously saw nothing at all. `aria-hidden`
                      because the span above already names the link; announcing
                      both would read every item twice. */}
                  {isCompact ? (
                    <span className="staff-nav-tip" aria-hidden="true">
                      {item.label}
                    </span>
                  ) : null}
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
            onClick={onToggleCompact}
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
