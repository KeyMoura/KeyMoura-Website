/**
 * The `roles` table as it actually exists, in one place.
 *
 * Four call sites read or write this table — the staff roles API, the per-role
 * PATCH/DELETE route, the public badge endpoint, and the users page — and
 * before this pass all four named columns the table does not have:
 *
 * | Code said     | The table holds |
 * |---------------|-----------------|
 * | `label`       | `name`          |
 * | `priority`    | `rank`          |
 * | `badge_icon`  | nothing         |
 *
 * The consequences differed by verb, and only one of them was visible. An
 * `insert` naming an unknown column is refused outright — that is the reported
 * "Could not find the 'badge_icon' column of 'roles' in the schema cache". A
 * `select` naming one is *also* refused, but every one of those call sites
 * destructured `{ data }` and dropped `error`, so the refusal arrived as an
 * empty array and the pages rendered "no roles" as though that were the answer.
 * A silent wrong answer is worse than the error, which is why the routes now
 * surface a failed read instead of coercing it to `[]`.
 *
 * `roles` is older than this repository's migration set — no file creates it —
 * so production is the only source of truth for its shape. That is exactly the
 * condition under which a generated type is not evidence, and it is why
 * `tests/staff-schema-contract.test.ts` checks the strings below against the
 * live column list rather than against `database.types.ts`.
 *
 * The wire vocabulary (`label`, `priority`) is deliberately **kept**. It is what
 * the staff UI shows and what `RolePill` consumes; renaming it would be churn
 * across surfaces to make the JSON agree with a column name no user ever sees.
 * The translation happens here, once, in both directions.
 */

/** Real column names, exactly as the live table spells them. */
export const ROLE_COLUMNS = {
  key: "key",
  label: "name",
  description: "description",
  priority: "rank",
  isStaff: "is_staff",
  isSystem: "is_system",
  badgeBg: "badge_bg",
  badgeBorder: "badge_border",
  badgeText: "badge_text",
  badgeIcon: "badge_icon",
} as const;

/**
 * The PostgREST `select` list, built from the map above.
 *
 * Aliased (`label:name`) so the response arrives in the wire vocabulary without
 * a second hand-written mapping — and so a column rename shows up here rather
 * than in four route files.
 */
export const ROLE_SELECT = [
  ROLE_COLUMNS.key,
  `label:${ROLE_COLUMNS.label}`,
  ROLE_COLUMNS.description,
  `priority:${ROLE_COLUMNS.priority}`,
  ROLE_COLUMNS.isStaff,
  ROLE_COLUMNS.isSystem,
  ROLE_COLUMNS.badgeBg,
  ROLE_COLUMNS.badgeBorder,
  ROLE_COLUMNS.badgeText,
  ROLE_COLUMNS.badgeIcon,
].join(",");

/** The public badge endpoint needs no description, staff flag or system flag. */
export const ROLE_PUBLIC_SELECT = [
  ROLE_COLUMNS.key,
  `label:${ROLE_COLUMNS.label}`,
  `priority:${ROLE_COLUMNS.priority}`,
  ROLE_COLUMNS.isStaff,
  ROLE_COLUMNS.badgeBg,
  ROLE_COLUMNS.badgeBorder,
  ROLE_COLUMNS.badgeText,
  ROLE_COLUMNS.badgeIcon,
].join(",");

/** The column to sort by. `.order()` takes a real column, never an alias. */
export const ROLE_ORDER_COLUMN = ROLE_COLUMNS.priority;

export const DEFAULT_BADGE_BG = "#111827";
export const DEFAULT_BADGE_BORDER = "#374151";
export const DEFAULT_BADGE_TEXT = "#E5E7EB";

/**
 * The badge icons that actually render.
 *
 * `RolePill` maps a name to a FontAwesome icon through a closed allow-list and
 * draws nothing for anything else, so an unknown value has never been an
 * injection risk — it is a silent one. Staff typed a name, saw it saved, and got
 * no icon. Validating here means the same list decides what may be stored and
 * what may be drawn, and the editor can refuse a typo at the point it is made.
 */
export const ROLE_BADGE_ICONS = [
  "shield-heart",
  "shield-cat",
  "shield-dog",
  "gavel",
  "chess-rook",
  "book",
] as const;

export type RoleBadgeIcon = (typeof ROLE_BADGE_ICONS)[number];

export function isRoleBadgeIcon(value: unknown): value is RoleBadgeIcon {
  return typeof value === "string" && (ROLE_BADGE_ICONS as readonly string[]).includes(value.toLowerCase());
}

/** Normalise an icon name, or `null` for "no icon". Throws nothing; callers decide. */
export function normalizeBadgeIcon(value: unknown): RoleBadgeIcon | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  return isRoleBadgeIcon(trimmed) ? (trimmed as RoleBadgeIcon) : null;
}

/**
 * Columns that are `NOT NULL` with a default, and therefore must never be sent
 * as an explicit `null`.
 *
 * This is the second half of the "could not create the role" defect, and it
 * outlived pass 14's migration. `roles.description` is `text NOT NULL DEFAULT
 * ''`. The create form posts only `{ key, label }`, the route filled the absent
 * description with `null`, and an explicit `null` **overrides a default rather
 * than triggering it** — so every create was refused with
 *
 *     23502  null value in column "description" of relation "roles"
 *            violates not-null constraint
 *
 * and the route reported the generic "Could not create the role."
 *
 * Proven against production before the change, not inferred: the same insert
 * with `''` succeeds and with `null` fails. The repair is here rather than a
 * migration making the column nullable — the column is right, and relaxing a
 * constraint to accommodate a caller that sends the wrong value would lose the
 * guarantee that every role has a description string to render.
 *
 * `''` rather than omitting the key: both work for an insert, but an *update*
 * clearing a description has to write something, and `''` is what the default
 * would have produced anyway.
 */
export const ROLE_NOT_NULL_TEXT_COLUMNS: readonly string[] = [ROLE_COLUMNS.description];

/** Wire field -> database column, for writes. Only these may be written. */
const WRITABLE: Readonly<Record<string, string>> = {
  label: ROLE_COLUMNS.label,
  description: ROLE_COLUMNS.description,
  priority: ROLE_COLUMNS.priority,
  is_staff: ROLE_COLUMNS.isStaff,
  badge_bg: ROLE_COLUMNS.badgeBg,
  badge_border: ROLE_COLUMNS.badgeBorder,
  badge_text: ROLE_COLUMNS.badgeText,
  badge_icon: ROLE_COLUMNS.badgeIcon,
};

/**
 * Translate a wire-shaped patch into database columns.
 *
 * `is_system` and `key` are deliberately absent from `WRITABLE`: the first
 * decides whether a role may be deleted at all, and the second is the primary
 * key that `role_permissions` and `profiles.role` point at. Neither is something
 * a badge editor should be able to change by adding a field to its JSON.
 */
export function toRoleDbColumns(patch: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [wireField, column] of Object.entries(WRITABLE)) {
    if (!Object.prototype.hasOwnProperty.call(patch, wireField)) continue;
    const value = patch[wireField];
    // The one place a `null` is turned back into the column's own default.
    // Doing it here rather than in each route means a fifth call site cannot
    // reintroduce the 23502 by building its payload slightly differently.
    out[column] = value === null && ROLE_NOT_NULL_TEXT_COLUMNS.includes(column) ? "" : value;
  }
  return out;
}

/**
 * A database error from a role write, as something an operator can act on.
 *
 * Every failure except 23505 used to collapse to "Could not create the role.",
 * which is how a not-null violation stayed invisible for two passes — it was
 * indistinguishable from a permission problem, a typo or an outage. Each code
 * below is a distinct thing the operator did, and each message says which.
 */
export function roleWriteErrorMessage(
  error: { code?: string | null; message?: string | null } | null,
  verb: "create" | "update" | "delete"
): { message: string; status: number } {
  switch (error?.code) {
    case "23505":
      return { message: "A role with that key already exists.", status: 409 };
    case "23502":
      return { message: "That role is missing a required field.", status: 400 };
    case "23514":
      // The only CHECK on `roles` is `roles_badge_icon_check`.
      return { message: "That is not one of the available badge icons.", status: 400 };
    case "23503":
      return { message: "Something still refers to that role.", status: 409 };
    case "42501":
      return { message: "This account is not allowed to change roles.", status: 403 };
    default:
      return { message: `Could not ${verb} the role.`, status: 400 };
  }
}
