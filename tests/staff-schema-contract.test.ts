import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import test from "node:test";

import {
  ROLE_COLUMNS,
  ROLE_PUBLIC_SELECT,
  ROLE_SELECT,
  ROLE_ORDER_COLUMN,
  ROLE_BADGE_ICONS,
  isRoleBadgeIcon,
  normalizeBadgeIcon,
  toRoleDbColumns,
} from "../src/lib/staff/roleSchema.ts";

/**
 * Does the application only ever name columns the database actually has?
 *
 * This suite exists because of `roles`. Three columns — `label`, `priority` and
 * `badge_icon` — were named by shipped code and none of them has ever existed.
 * Every layer that should have caught it did not:
 *
 *  * **TypeScript passed.** The route declared its own `RoleRow` type and the
 *    Supabase client's `select()` takes a string, so `"key,label,priority"` is
 *    just text. Nothing compared it to a schema.
 *  * **The generated types could not help.** `database.types.ts` is produced
 *    *from* a schema; when code and schema disagree, the generated file agrees
 *    with the schema and the disagreement lives entirely in hand-written types.
 *  * **The tests passed.** Every assertion about roles read source or checked a
 *    pure function. None knew what the live table held.
 *  * **Production did not obviously break.** An `insert` naming a missing column
 *    is refused loudly, which is how the owner found it. A `select` naming one
 *    is refused just as hard — but all three call sites destructured `{ data }`
 *    and dropped `error`, so the refusal arrived as `[]` and rendered as "there
 *    are no roles".
 *
 * So the check has to be made against a captured schema, and it has to be made
 * on the `select` strings themselves. `tests/fixtures/production-schema.json` is
 * that capture, taken from `information_schema.columns` rather than from any
 * artifact the application also produces.
 */

const repoFile = (relative: string) => new URL(`../${relative}`, import.meta.url);
const read = (relative: string) => readFileSync(repoFile(relative), "utf8");

type KnownDrift = { columns: string[]; surface: string; effect: string; why_not_fixed_in_pass_14: string };

type Snapshot = {
  tables: Record<string, string[]>;
  pending_migrations: Record<string, string[] | string>;
  known_drift: Record<string, KnownDrift | string[]>;
};

const snapshot = JSON.parse(read("tests/fixtures/production-schema.json")) as Snapshot;

const driftEntries = Object.entries(snapshot.known_drift).filter(
  (entry): entry is [string, KnownDrift] => !Array.isArray(entry[1]) && typeof entry[1] === "object"
);

/** Columns that exist in production, plus those a migration in this branch adds. */
function knownColumns(table: string): Set<string> | null {
  const live = snapshot.tables[table];
  if (!live) return null;
  const pending = snapshot.pending_migrations[table];
  const extra = Array.isArray(pending) ? pending : [];
  return new Set([...live, ...extra]);
}

/** Confirmed drift that is deliberately unfixed. Excluded from the sweep, asserted below. */
function isKnownDrift(table: string, column: string): boolean {
  const entry = snapshot.known_drift[table];
  if (!entry || Array.isArray(entry)) return false;
  return entry.columns.includes(column);
}

// ---------------------------------------------------------------------------
// Walking the source
// ---------------------------------------------------------------------------

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(new URL(`../${dir}`, import.meta.url))) {
    const relative = `${dir}/${entry}`;
    const stats = statSync(new URL(`../${relative}`, import.meta.url));
    if (stats.isDirectory()) sourceFiles(relative, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(relative);
  }
  return out;
}

const files = [...sourceFiles("src/app"), ...sourceFiles("src/lib"), ...sourceFiles("src/components")];

/**
 * `.from("table").select("cols")`, with `.select` immediately after `.from`.
 *
 * "Immediately" is load-bearing and was learned the hard way. A first version
 * allowed up to 400 characters between the two, which let a `.from("orders")`
 * pair with the `.select()` of the *next* query in the file: it reported seven
 * `products` columns as missing from `orders` and four `product_option_groups`
 * columns as missing from `products`. Every one of those was the test being
 * wrong. A checker that cries wolf gets muted, so it now only matches the shape
 * it can attribute with certainty — which is also the shape this codebase
 * overwhelmingly writes.
 *
 * Skipped rather than guessed at: a `select` built from a template literal or a
 * variable, and one that does not directly follow its `from`. `ROLE_SELECT` and
 * `ROLE_PUBLIC_SELECT` are constants, so they are checked separately by name.
 */
const FROM_SELECT = /\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)(\s*)\.select\(\s*(["'])((?:[^"'\\]|\\.)*)\3/g;

/**
 * Split a PostgREST select list into the column names it actually requires.
 *
 * Handles the three forms that appear in this codebase:
 *   `col`               -> col
 *   `alias:col`         -> col            (the alias is a response key, not a column)
 *   `relation(a,b)`     -> skipped        (a, b belong to the embedded table)
 * `*` and `count` require nothing.
 */
function requiredColumns(selectList: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  const flush = () => {
    const token = current.trim();
    current = "";
    if (!token || token === "*" || token.startsWith("count")) return;
    if (token.includes("(")) return; // embedded relation: belongs to another table
    const name = token.includes(":") ? token.slice(token.indexOf(":") + 1) : token;
    const clean = name.trim().replace(/::[a-z]+$/i, "");
    if (clean && clean !== "*" && /^[a-z_][a-z0-9_]*$/i.test(clean)) out.push(clean);
  };
  for (const char of selectList) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) flush();
    else current += char;
  }
  flush();
  return out;
}

test("every literal .from().select() names only columns the database has", () => {
  const problems: string[] = [];
  let checked = 0;

  for (const file of files) {
    const source = read(file);
    for (const match of source.matchAll(FROM_SELECT)) {
      const [, table, , , selectList] = match;
      const columns = knownColumns(table);
      // An unknown relation is not a finding: the snapshot covers `public`, and
      // this pattern also matches storage and RPC-style helpers.
      if (!columns) continue;
      for (const column of requiredColumns(selectList)) {
        checked += 1;
        if (columns.has(column) || isKnownDrift(table, column)) continue;
        problems.push(`${file}: ${table}.${column} does not exist`);
      }
    }
  }

  assert.ok(checked > 200, `expected to check many columns, only saw ${checked}`);
  assert.deepEqual(problems, [], `columns referenced in code but absent from the database:\n${problems.join("\n")}`);
});

test("known drift is genuinely drift, and each entry states its cost", () => {
  // An exclusion list is only honest if it is small, specific and explained.
  // These assertions stop it becoming somewhere to put a red result.
  assert.ok(driftEntries.length <= 2, "the known-drift list must stay short; fix entries rather than add them");

  for (const [table, entry] of driftEntries) {
    const live = snapshot.tables[table];
    assert.ok(live, `known_drift names ${table}, which is not in the snapshot`);
    for (const column of entry.columns) {
      // If this fails, the column now exists and the entry must simply be deleted.
      assert.ok(!live.includes(column), `${table}.${column} exists now — remove it from known_drift`);
    }
    assert.match(entry.surface, /^src\//, "an entry must name the surface it breaks");
    assert.ok(entry.effect.length > 40, "an entry must say what the user sees");
    assert.ok(entry.why_not_fixed_in_pass_14.length > 40, "an entry must say why it was left");
  }
});

// ---------------------------------------------------------------------------
// The `roles` table specifically — the one that failed
// ---------------------------------------------------------------------------

test("the roles module names the real columns, not the wire vocabulary", () => {
  const columns = knownColumns("roles");
  assert.ok(columns, "roles must be in the snapshot");
  for (const column of Object.values(ROLE_COLUMNS)) {
    assert.ok(columns.has(column), `roles.${column} must exist`);
  }
  // The three that did not. This is the regression, stated directly.
  for (const absent of ["label", "priority"]) {
    assert.ok(!snapshot.tables.roles.includes(absent), `roles.${absent} must not be treated as a column`);
  }
  assert.equal(ROLE_COLUMNS.label, "name");
  assert.equal(ROLE_COLUMNS.priority, "rank");
  assert.equal(ROLE_ORDER_COLUMN, "rank", "ordering takes a real column, never an alias");
});

test("the roles select lists alias the wire names onto real columns", () => {
  for (const list of [ROLE_SELECT, ROLE_PUBLIC_SELECT]) {
    assert.match(list, /(^|,)label:name(,|$)/, "label must be an alias of name");
    assert.match(list, /(^|,)priority:rank(,|$)/, "priority must be an alias of rank");
    // Every requested column resolves to something real.
    for (const column of requiredColumns(list)) {
      assert.ok(knownColumns("roles")!.has(column), `roles.${column} must exist`);
    }
  }
});

test("role writes translate to database columns and refuse identity fields", () => {
  const written = toRoleDbColumns({
    label: "Organizer",
    priority: 25,
    badge_icon: "gavel",
    badge_bg: "#111827",
    description: "x",
    is_staff: true,
  });
  assert.equal(written.name, "Organizer", "label writes to name");
  assert.equal(written.rank, 25, "priority writes to rank");
  assert.ok(!("label" in written) && !("priority" in written), "wire names never reach the table");

  for (const column of Object.keys(written)) {
    assert.ok(knownColumns("roles")!.has(column), `roles.${column} must exist`);
  }

  // `key` is the primary key that `profiles.role` and `role_permissions` point
  // at; `is_system` is what stops `admin` being deleted. Neither is writable by
  // adding a field to the JSON.
  const smuggled = toRoleDbColumns({ key: "admin", is_system: false, label: "x" });
  assert.deepEqual(Object.keys(smuggled), ["name"]);
});

test("only badge icons that render can be stored", () => {
  // `RolePill` resolves through a closed allow-list and draws nothing for
  // anything else, so an unvalidated name saved cleanly and showed no icon.
  for (const icon of ROLE_BADGE_ICONS) {
    assert.ok(isRoleBadgeIcon(icon), `${icon} must be accepted`);
    assert.equal(normalizeBadgeIcon(icon), icon);
  }
  for (const bogus of ["rocket", "<script>", "shield_heart", "", "   ", null, 7]) {
    assert.ok(!isRoleBadgeIcon(bogus), `${String(bogus)} must be refused`);
  }
  assert.equal(normalizeBadgeIcon("  GAVEL "), "gavel", "case and padding are normalised");
  assert.equal(normalizeBadgeIcon("rocket"), null);

  // The database says the same thing, so a writer that skips the API cannot
  // store a name the badge cannot draw.
  const migration = read("supabase/migrations/20260808010000_role_badge_icon.sql");
  for (const icon of ROLE_BADGE_ICONS) {
    assert.ok(migration.includes(`'${icon}'`), `the constraint must list ${icon}`);
  }
});

test("the badge_icon migration is additive and default-safe", () => {
  const migration = read("supabase/migrations/20260808010000_role_badge_icon.sql");
  assert.match(migration, /add column if not exists badge_icon text/i);
  assert.doesNotMatch(migration, /\bdrop column\b/i);
  assert.doesNotMatch(migration, /\btruncate\b/i);
  assert.doesNotMatch(migration, /\bdelete from\b/i);
  assert.doesNotMatch(migration, /not null/i, "a NOT NULL column would need a backfill for existing roles");
  // A fresh install has to reach the same shape, or the drift simply restarts.
  assert.match(
    read("supabase/installer/00000000000002_application_baseline.sql"),
    /alter table public\.roles add column if not exists badge_icon text/i
  );
});

test("the roles routes surface a failed read instead of answering with an empty list", () => {
  const route = read("src/app/api/staff/security/roles/route.ts");
  // The specific defect: `const { data } = await ...` dropped the error, so a
  // refused query rendered as "no roles" — the most confident wrong answer.
  assert.match(route, /const \{ data, error \}/, "the read must capture error");
  assert.match(route, /if \(error\) return NextResponse\.json\(\s*\{ error: "Could not load roles\." \}/);
});

test("built-in roles and roles people still hold cannot be deleted", () => {
  const route = read("src/app/api/staff/security/roles/[key]/route.ts");
  assert.match(route, /is_system/, "deleting admin must be refused");
  assert.match(route, /Built-in roles cannot be deleted/);
  assert.match(route, /still hold/, "a role still assigned must be refused");
  assert.match(route, /\.eq\("role", roleKey\)/, "the holder check reads profiles.role");
});
