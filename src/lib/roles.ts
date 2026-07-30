/**
 * Role helpers.
 *
 * Roles are normalized as lowercase strings. The app historically allowed arbitrary role strings,
 * so the public type remains `string`-compatible.
 */

export type UserRole =
  | "admin"
  | "support"
  | "moderator"
  | "mod"
  | "member"
  | "staff"
  | string;

export type RoleMeta = {
  label: string;
  pillClass: string;
  icon: "gavel" | "chess-rook" | "book" | null;
};

/**
 * Central role registry for consistent labels, icons, and colors.
 *
 * Add a new role once here and it propagates to the entire UI.
 */
export const ROLE_REGISTRY: Readonly<Record<string, RoleMeta>> = {
  admin: {
    label: "Admin",
    pillClass: "border-red-500/40 bg-red-500/10 text-red-200",
    icon: "gavel",
  },
  moderator: {
    label: "Moderator",
    pillClass: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
    icon: "chess-rook",
  },
  support: {
    label: "Support",
    pillClass: "border-sky-500/40 bg-sky-500/10 text-sky-200",
    icon: "book",
  },
  staff: {
    label: "Staff",
    pillClass: "border-amber-500/40 bg-amber-500/10 text-amber-200",
    icon: null,
  },
  member: {
    label: "Member",
    pillClass: "border-zinc-700 bg-zinc-900/40 text-zinc-200",
    icon: null,
  },
};

/**
 * Normalizes an incoming role value.
 */
export function normalizeRole(role: unknown): string {
  if (typeof role !== "string") return "member";
  const lower = role.trim().toLowerCase();
  if (!lower) return "member";
  if (lower === "mod") return "moderator";
  return lower;
}

/**
 * Returns the UI metadata for a role.
 */
export function getRoleMeta(role: unknown): RoleMeta {
  const normalized = normalizeRole(role);
  return ROLE_REGISTRY[normalized] ?? ROLE_REGISTRY.member;
}
