/**
 * The shape `/api/staff/users/[id]` returns.
 *
 * One declaration, imported by the page and by every panel on it, so a field
 * renamed on the server fails a typecheck instead of rendering `undefined` in a
 * heading. It replaces a `type Workspace` that lived inside the page file and
 * was re-declared, partially, by each component that needed part of it.
 *
 * Pure types — no React, no runtime — so tests can import it freely.
 */

import type { AccountStatus, UserMetrics } from "./userDirectory.ts";

export type WorkspaceUser = {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  email: string | null;
  emailConfirmed: boolean;
  bio: string | null;
  location: string | null;
  isVerified: boolean;
  donationRank: string | null;
  isOp: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  lastSignInAt: string | null;
  roleKey: string;
  roleName: string;
  roleRank: number;
  isStaff: boolean;
  accountStatus: AccountStatus;
  providers: string[];
};

export type WorkspaceRestriction = {
  kind: string;
  reason: string | null;
  createdAt: string;
  expiresAt: string | null;
};

export type WorkspaceNote = {
  id: string;
  authorLabel: string;
  body: string;
  category: string;
  createdAt: string;
};

/**
 * What this viewer may do, decided on the server.
 *
 * The UI hides controls from these flags, and every one of them is checked
 * again by the route that performs the action. Hiding a button is a courtesy to
 * the person using the page, not a security boundary.
 */
export type WorkspaceViewer = {
  isSelf: boolean;
  outranksViewer: boolean;
  assignableRoles: { key: string; name: string; rank: number; isStaff: boolean; dangerous: boolean }[];
  canAssignRole: boolean;
  canGrantPermissions: boolean;
  canEditProfile: boolean;
  canVerify: boolean;
  canSetDonationRank: boolean;
  canSuspend: boolean;
  canRestrict: boolean;
  canViewNotes: boolean;
  canWriteNotes: boolean;
  canViewOrders: boolean;
  canViewProduction: boolean;
  canViewCommunications: boolean;
  canViewSupport: boolean;
  canResendEmail: boolean;
  canViewActivity: boolean;
  canViewIpLogs: boolean;
};

export type UserWorkspace = {
  user: WorkspaceUser;
  metrics: UserMetrics;
  status: {
    value: AccountStatus;
    banReason: string | null;
    bannedAt: string | null;
    restrictions: WorkspaceRestriction[];
  };
  latestOrder: { id: string; orderNumber: string | null; status: string; createdAt: string } | null;
  possibleGuestOrderCount: number;
  /** `null` when the viewer may not read support at all — never 0 in that case. */
  openSupportCount: number | null;
  /** `null` when the viewer may not read notes. */
  recentNotes: WorkspaceNote[] | null;
  roles: { key: string; name: string; rank: number; isStaff: boolean }[];
  /** `{ roleKey: [permission, …] }`. `null` when role definitions are withheld. */
  rolePermissions: Record<string, string[]> | null;
  /** This person's own additive grants. `null` when withheld. */
  permissionOverrides: string[] | null;
  viewer: WorkspaceViewer;
};
