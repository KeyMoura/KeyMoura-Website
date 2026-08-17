import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ORDER_HISTORY_SORTS, ORDER_HISTORY_SORT_OPTIONS, sortOrderHistory } from "../src/lib/commerce/orderHistory.ts";
import { SORTS, emptyFilters } from "../src/lib/staff/orderFilters.ts";
import { buildQueryPlan } from "../src/lib/staff/orderQueryPlan.ts";
import { APPEARANCE_SECTIONS } from "../src/theme/appearanceSections.ts";
import { APPEARANCE_SETTINGS } from "../src/theme/appearanceMap.ts";
import { ownedKeys } from "../src/theme/appearanceTasks.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * Source with its comments removed.
 *
 * For assertions of the form "X must not appear": a file that explains why X was
 * removed has to be able to say the word X. Matching the raw source makes the
 * explanation itself the failure, which teaches the next person to delete the
 * explanation.
 */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("staff order queue supports useful independent sort modes", () => {
  const page = read("src/app/staff/orders/page.tsx");
  for (const label of ["Recently updated", "Newest orders", "Oldest orders", "Highest priority", "Target date", "Highest price"]) {
    assert.match(page, new RegExp(label));
  }
  /*
   * Sorting is server-authoritative now, so `.toSorted(` — which this used to
   * pin — is the wrong property: it could only ever have sorted the rows the
   * browser happened to hold, which was the whole page's worth of orders.
   *
   * Re-pointed and made stricter: every offered sort must resolve to a real
   * database ordering, and each must carry a stable tiebreak. Sorting a page at
   * a time without one lets two rows sharing a sort key swap places between
   * page 1 and page 2, so a row can be seen twice and another never.
   */
  assert.doesNotMatch(page, /\.toSorted\(/, "sorting a single page in the browser reorders only that page");
  for (const sort of SORTS) {
    const order = buildQueryPlan({ ...emptyFilters(), sort }).order;
    assert.ok(order.length >= 1, `${sort} produces no database ordering`);
    assert.equal(order.at(-1)?.column, "id", `${sort} has no stable tiebreak`);
  }
});

test("customer order hub sorts by the date it prints, not by updated_at", () => {
  /*
   * Six sort modes became two in Commerce 3.0, and the one that mattered is the
   * one that went: `updated_at` was the *default*.
   *
   * It is not a property of the order as far as the customer is concerned. A
   * staff note or an internal status touch reshuffled the list under somebody
   * who had done nothing, and the new position no longer agreed with the only
   * date on the card. Sorting by the visible field is the whole rule, and the
   * column is not even read any more.
   */
  const page = read("src/app/account/orders/page.tsx");
  assert.deepEqual([...ORDER_HISTORY_SORTS], ["newest", "oldest"]);
  // The labels sit beside the values they belong to, so a control cannot offer
  // a sort the sorter does not implement.
  assert.deepEqual(
    ORDER_HISTORY_SORT_OPTIONS.map((option) => option.label),
    ["Newest first", "Oldest first"]
  );
  assert.deepEqual(
    ORDER_HISTORY_SORT_OPTIONS.map((option) => option.value),
    [...ORDER_HISTORY_SORTS]
  );
  assert.match(page, /ORDER_HISTORY_SORT_OPTIONS/);
  assert.doesNotMatch(page, /Highest priority/);
  assert.doesNotMatch(page, /updated_at/, "updated_at must not be read at all");
  assert.match(page, /\.order\("created_at", \{ ascending: false \}\)/);

  // Only `created_at` matters to the sorter; the rest of the row is not read.
  const rows = [
    { created_at: "2026-01-01T00:00:00Z" },
    { created_at: "2026-08-01T00:00:00Z" },
  ] as unknown as Parameters<typeof sortOrderHistory>[0];
  assert.equal(sortOrderHistory(rows, "newest")[0].created_at, "2026-08-01T00:00:00Z");
  assert.equal(sortOrderHistory(rows, "oldest")[0].created_at, "2026-01-01T00:00:00Z");
});

test("primary order and notification controls adapt for mobile", () => {
  const orders = read("src/app/account/orders/page.tsx");
  const notifications = read("src/app/account/notifications/page.tsx");
  assert.match(orders, /sm:w-auto/);
  // The native `<select>` this used to pin became a MenuSelect, like every
  // other dropdown on the site. The mobile requirement it stood for — a full
  // width control that cannot overflow its row — moved to the segmented tabs.
  assert.match(orders, /className="w-full sm:w-auto"/);
  assert.doesNotMatch(orders, /<select/, "the order hub must use MenuSelect");
  assert.match(notifications, /aria-pressed=\{showUnreadOnly\}/);
  assert.match(notifications, /min-h-11/);
});

test("account security exposes safe Supabase identity linking", () => {
  const page = read("src/app/account/profile/page.tsx");
  assert.match(page, /getUserIdentities\(\)/);
  assert.match(page, /linkIdentity\(/);
  assert.match(page, /unlinkIdentity\(/);
  assert.match(page, /identities\.length < 2/);
  // The offered provider list moved into `connectedMethods` when Discord was
  // replaced by Facebook, so that an already-linked provider stays visible even
  // once it stops being offered. Asserted in `auth-providers.test.ts`, which
  // owns that rule now.
  assert.match(page, /connectedMethods/);
  assert.match(page, /`Connect \$\{label\}`/);
});

test("appearance is organized around owner tasks, not kinds of setting", () => {
  /*
   * Pass 4.0 reorganised these away from *kinds of setting* — Colours, Shapes &
   * density, Logos & icons — because the four things that pass was asked about
   * had no home among them. Pass 5.0 finished the job and moved the declaration
   * out of the page, so this reads the declaration.
   *
   * The sections a shop owner works in, by the name they would use for them.
   */
  const labels = APPEARANCE_SECTIONS.map((section) => section.label);
  for (const label of [
    "Brand",
    "Navigation",
    "Announcement bar",
    "Homepage",
    // Pass 6: the owner-facing spelling is American across the whole editor.
    "Colors",
    "Typography",
    "Buttons & components",
    "Product cards",
    "Forms",
    "Layout & density",
    "Business details",
  ]) {
    assert.ok(labels.includes(label), `missing section: ${label}`);
  }

  // Every section says what it is in one sentence, and none of them says it in
  // a paragraph — the old rail printed a full sentence under all eight entries,
  // which is prose you read past on every visit to reach one word.
  for (const section of APPEARANCE_SECTIONS) {
    assert.ok(section.description.length > 30, `${section.id} needs a real sentence`);
    assert.ok(section.description.length < 220, `${section.id}'s description is a paragraph`);
  }

  const panels = read("src/app/staff/appearance/panels.tsx");
  const chrome = read("src/app/staff/appearance/EditorChrome.tsx");
  assert.match(chrome, /Publish appearance/);
  for (const label of ["Segmented tabs", "Cards & panels", "Content width", "Corner shape", "Typeface"]) {
    assert.match(panels, new RegExp(label));
  }
  assert.match(panels, /"framed"/);
});

/**
 * The "Labels" decision, pinned so it cannot quietly come back.
 *
 * "Labels & wording" held three controls — Community label, Projects label,
 * Trusted vendor label — writing `site_settings.terminology`. `getSiteSettings`
 * read the column and returned it on `RuntimeSiteSettings.terminology`, and no
 * component on the site ever rendered any of it. The section was not badly
 * named; it did nothing.
 *
 * Both halves are asserted. The controls are gone from the editor *and* the dead
 * field is gone from the runtime settings type — leaving the type would keep a
 * loaded, typed, plausible-looking value that a future component might start
 * reading, which is how a dead setting comes back to life by accident.
 *
 * What is deliberately *not* asserted: anything about the database. The column
 * still exists, still holds its data, and the installer still writes it. Nothing
 * was destroyed.
 */
test("the dead terminology controls are gone from the editor and the runtime", () => {
  /*
   * Comments are stripped before matching. Both files explain the removal at
   * some length and name what was removed while doing it, which is exactly what
   * they should do — the assertion is about code, not about whether the reasoning
   * is allowed to mention the thing it is reasoning about.
   */
  const page = code(read("src/app/staff/appearance/page.tsx"));
  const settings = code(read("src/lib/siteSettings.ts"));

  for (const dead of ["forumLabel", "knowledgeBaseLabel", "trustedVendorLabel", "Labels & wording"]) {
    assert.doesNotMatch(page, new RegExp(dead), `${dead} wrote a value nothing rendered`);
  }
  assert.doesNotMatch(
    settings,
    /terminology/,
    "RuntimeSiteSettings must not carry a field no surface reads"
  );
});

/**
 * Colour controls are no longer written at the call site.
 *
 * This is the assertion the old string matching was reaching for and could not
 * make: a control exists because the map declares it, so the page cannot ship a
 * colour picker with no explanation attached.
 */
test("every colour control is rendered from the declared task list", () => {
  /*
   * Re-pointed, and made stricter.
   *
   * The page used to render one control per colour, straight from
   * `APPEARANCE_SETTINGS`. It now renders one editor per *task* — the thing on
   * the screen — with that thing's two or three colours inside it, and the
   * partition is asserted to be total and disjoint in `appearance-tasks.test.ts`.
   * So "from the declared map" is still the property; the declaration simply
   * gained a layer that speaks the owner's vocabulary.
   */
  const controls = read("src/app/staff/appearance/ColorControls.tsx");
  const panels = read("src/app/staff/appearance/panels.tsx");
  assert.match(panels, /tasksForSection\(/, "sections come from the declaration, not from the page");
  assert.match(controls, /settingFor\(field\.key\)/, "each field resolves to its real map entry");
  assert.match(controls, /setting\.description/, "and renders that entry's own explanation");

  /*
   * There is exactly one colour control component.
   *
   * A second, hand-written swatch beside the declared ones would be a control
   * with no description, no inheritance handling and no search terms — which is
   * precisely what these passes removed. `ColorField` is private to
   * `ColorControls.tsx`; nothing else may define one.
   */
  for (const file of ["page.tsx", "panels.tsx", "sections.tsx", "PreviewStage.tsx"]) {
    assert.doesNotMatch(
      read(`src/app/staff/appearance/${file}`),
      /function ColorField/,
      `${file} must not define a second colour control`
    );
  }
  assert.match(controls, /function ColorField/, "the one colour control lives here");

  // Every colour still reaches a control, and no colour reaches two. Asserted
  // here as well as in the task suite because this is the test that would be
  // deleted if somebody decided the task layer had replaced the map.
  const owned = ownedKeys();
  assert.equal(new Set(owned).size, owned.length, "a colour with two controls");
  assert.equal(owned.length, APPEARANCE_SETTINGS.length, "a colour with no control");
});

test("account tabs use the shared configurable tab system", () => {
  const page = read("src/app/account/profile/page.tsx");
  assert.match(page, /className="ui-tabs/);
  assert.match(page, /className=\{`ui-tab/);
  assert.match(page, /role="tab"/);
  assert.match(page, /aria-selected=/);
});
