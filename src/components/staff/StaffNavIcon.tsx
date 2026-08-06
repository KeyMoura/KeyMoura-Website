"use client";

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faBoxesStacked,
  faChartLine,
  faClipboardCheck,
  faClipboardList,
  faComments,
  faEnvelope,
  faFlag,
  faGaugeHigh,
  faGear,
  faGears,
  faGem,
  faGrip,
  faGlobe,
  faKey,
  faListCheck,
  faPalette,
  faPenToSquare,
  faScrewdriverWrench,
  faScaleBalanced,
  faShieldHalved,
  faStore,
  faTag,
  faTrashCan,
  faTruck,
  faUsers,
} from "@fortawesome/free-solid-svg-icons";

import type { StaffNavIcon as StaffNavIconKey } from "@/lib/staffNavigation";

/**
 * Icon lookup for the staff navigation.
 *
 * The icon *choice* lives here rather than in `staffNavigation.ts` so that
 * module stays dependency-free and its routing rules stay unit-testable. The
 * map is exhaustive over the key union, so adding a section without giving it
 * an icon is a type error rather than a blank square in the sidebar.
 */
const ICONS: Readonly<Record<StaffNavIconKey, IconDefinition>> = {
  dashboard: faGaugeHigh,
  orders: faClipboardList,
  truck: faTruck,
  production: faScrewdriverWrench,
  catalog: faStore,
  inventory: faBoxesStacked,
  discount: faTag,
  analytics: faChartLine,
  reconcile: faScaleBalanced,
  audit: faClipboardCheck,
  users: faUsers,
  moderation: faFlag,
  community: faComments,
  shops: faGlobe,
  pending: faPenToSquare,
  updates: faListCheck,
  todo: faGrip,
  settings: faGear,
  commerce: faGears,
  appearance: faPalette,
  email: faEnvelope,
  security: faShieldHalved,
  roles: faKey,
  recycle: faTrashCan,
  perks: faGem,
};

export function StaffNavIcon({ icon, className }: { icon: StaffNavIconKey; className?: string }) {
  return <FontAwesomeIcon icon={ICONS[icon]} className={className} aria-hidden="true" fixedWidth />;
}
