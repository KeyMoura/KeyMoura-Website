-- ============================================================================
-- The badge icon the role editor has always been able to edit
-- ============================================================================
--
-- `/staff/security/roles` carries an "Icon" field. It writes `badge_icon`, and
-- `RolePill` reads `badge_icon` to choose which FontAwesome glyph sits inside
-- the badge. The column has never existed.
--
-- The consequence differed by verb, which is why only half of it was reported:
--
--   * `insert` naming an unknown column is refused outright — the reported
--     "Could not find the 'badge_icon' column of 'roles' in the schema cache",
--     which made creating **any** role impossible regardless of the icon.
--   * `select` naming one is also refused, but all three call sites dropped the
--     error and returned `[]`, so the roles list and the public badge endpoint
--     answered "there are no roles" instead of failing.
--
-- Two repairs were possible: add the column, or delete the editor field. The
-- field is added here because the other three badge attributes — `badge_bg`,
-- `badge_border`, `badge_text` — are already columns on this table and already
-- editable. The icon is the fourth attribute of the same badge, and it is the
-- only one a staff member cannot change. Deleting the control would remove a
-- deliberately built feature to match an omission.
--
-- `roles` predates this repository's migration set; no file creates it. That is
-- precisely why this column went missing, and why the accompanying
-- `tests/staff-schema-contract.test.ts` checks application code against the live
-- column list rather than against a generated type that can drift the same way.
--
-- Additive and default-safe:
--   * one nullable column, no default, so every one of the four existing rows
--     keeps `null` and needs no backfill;
--   * `null` already means "use the code registry's icon for this role", which
--     is exactly what `RolePill` does today, so behaviour before and after the
--     migration is identical until somebody sets a value;
--   * no grant is issued, and none is needed — privileges on this table are
--     table-level (`service_role` holds SELECT/INSERT/UPDATE/DELETE; `anon` and
--     `authenticated` hold SELECT), and a new column inherits them. Issuing a
--     column grant here would narrow nothing and imply a rule that is not real;
--   * no policy changes. `roles` carries no RLS policies and `relrowsecurity`
--     is unchanged by adding a column.

alter table public.roles
  add column if not exists badge_icon text;

-- The set is closed because `RolePill` resolves a name through an allow-list and
-- draws nothing for anything else. Without this, a typo stores cleanly, reports
-- success, and renders no icon — a silent failure rather than a refusal. The
-- API validates the same six names; the constraint is what makes that true for
-- every writer, including a future one that forgets.
alter table public.roles
  drop constraint if exists roles_badge_icon_check;

alter table public.roles
  add constraint roles_badge_icon_check
  check (
    badge_icon is null
    or badge_icon in ('shield-heart', 'shield-cat', 'shield-dog', 'gavel', 'chess-rook', 'book')
  );

comment on column public.roles.badge_icon is
  'Optional badge glyph name, from the closed set in roles_badge_icon_check. Null means "use the icon the code registry assigns this role".';
