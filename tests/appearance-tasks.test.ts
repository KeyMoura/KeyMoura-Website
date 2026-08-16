import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { APPEARANCE_SETTINGS } from "../src/theme/appearanceMap.ts";
import {
  APPEARANCE_TASK_SECTIONS,
  APPEARANCE_TASKS,
  directTaskMatches,
  ownedKeys,
  searchAppearanceTasks,
  settingFor,
  taskById,
  taskMatchStrength,
  tasksInSection,
} from "../src/theme/appearanceTasks.ts";

/**
 * Appearance as tasks rather than tokens.
 *
 * The owner's report was that the page had become *harder* to navigate, and the
 * cause was arithmetic: thirty-four editable colours, and the two things they
 * actually named — the Customizable badge and the custom project button —
 * returned four search results each, every one of them plausible.
 *
 * These tests pin the properties that make the task layer trustworthy rather
 * than merely tidier: the partition is total (nothing became uneditable) and
 * disjoint (no colour has two controls), search resolves a thing to one answer,
 * and the vocabulary contains no token names.
 */

const page = readFileSync("src/app/staff/appearance/page.tsx", "utf8");

test("every colour has exactly one home", () => {
  const owned = ownedKeys();
  const duplicates = owned.filter((key, index) => owned.indexOf(key) !== index);
  assert.deepEqual(duplicates, [], "two controls writing one value is how an editor contradicts itself");

  const all = APPEARANCE_SETTINGS.map((setting) => setting.key);
  const missing = all.filter((key) => !owned.includes(key));
  assert.deepEqual(missing, [], "a colour with no task is a colour that became uneditable");

  const unknown = owned.filter((key) => !all.includes(key));
  assert.deepEqual(unknown, [], "a task names a colour the theme does not have");
});

test("nothing was removed — every colour is still reachable", () => {
  assert.equal(ownedKeys().length, APPEARANCE_SETTINGS.length);
  for (const key of ownedKeys()) {
    assert.ok(settingFor(key), `${key} must resolve to a real map entry`);
  }
});

test("the default view is small and the rare controls are in Advanced", () => {
  const everyday = APPEARANCE_TASKS.filter((task) => task.section !== "advanced");
  assert.ok(everyday.length <= 12, `the simple view must stay small, saw ${everyday.length}`);

  // And the everyday sections are the ones the brief named.
  const sections = APPEARANCE_TASK_SECTIONS.map((section) => section.id);
  assert.deepEqual(sections, ["brand", "buttons", "cards", "navigation", "forms", "advanced"]);
  for (const section of sections) {
    assert.ok(tasksInSection(section).length > 0, `${section} must not be an empty heading`);
  }
});

test("Advanced holds the uncommon colours, not the common ones", () => {
  const advanced = tasksInSection("advanced").flatMap((task) => task.fields.map((field) => field.key));
  for (const common of ["primaryColor", "accentColor", "background", "surface", "text", "badgeBackground"]) {
    assert.ok(!advanced.includes(common as never), `${common} belongs in the everyday view`);
  }
  // The hover and utility states are exactly what it is for.
  for (const rare of ["navigationUtilityHoverBorder", "navigationMobileText", "navigationBadgeText"]) {
    assert.ok(advanced.includes(rare as never), `${rare} should be tucked away`);
  }
});

// ---------------------------------------------------------------------------
// Search — the reported failure
// ---------------------------------------------------------------------------

test("searching “customizable” gives one obvious answer", () => {
  const direct = directTaskMatches("customizable");
  assert.deepEqual(direct.map((task) => task.id), ["customizable-badge"]);

  const results = searchAppearanceTasks("customizable");
  assert.equal(results[0].id, "customizable-badge", results.map((task) => task.label).join(", "));
  assert.equal(results[0].label, "Customizable badge");
  // And it carries all three of its colours, so opening it finishes the job.
  assert.deepEqual(results[0].fields.map((field) => field.role), ["Background", "Text", "Border"]);

  /*
   * Brand accent comes back too, and should.
   *
   * The badge follows the accent until it is given its own colour, so an owner
   * searching "customizable" who has never set the badge is genuinely looking
   * at the accent. Hiding that would be a lie; listing it *first* would be the
   * original complaint. It ranks second, as a related result.
   */
  assert.ok(results.slice(1).some((task) => task.id === "brand-accent"));
  assert.equal(taskMatchStrength(taskById("brand-accent")!, "customizable"), 1);
  assert.ok(results.length <= 2, results.map((task) => task.label).join(", "));
});

test("searching “custom project” gives one obvious answer", () => {
  const direct = directTaskMatches("custom project");
  assert.deepEqual(direct.map((task) => task.id), ["custom-project-button"]);

  const results = searchAppearanceTasks("custom project");
  assert.equal(results[0].id, "custom-project-button", results.map((task) => task.label).join(", "));
  assert.equal(results[0].fields.length, 3);
  assert.ok(results.length <= 2, results.map((task) => task.label).join(", "));
});

test("the best answer is always first, never buried under a related one", () => {
  for (const [query, expected] of [
    ["customizable", "customizable-badge"],
    ["custom project", "custom-project-button"],
    ["navbar", "navbar"],
    ["add to cart", "primary-button"],
    ["form", "form-input"],
  ] as const) {
    const results = searchAppearanceTasks(query);
    assert.ok(results.length > 0, query);
    assert.equal(results[0].id, expected, `“${query}” → ${results.map((task) => task.label).join(", ")}`);
  }
});

test("searching “navbar” finds the navbar, not a bank of tokens", () => {
  const results = searchAppearanceTasks("navbar");
  assert.ok(results.length <= 4, results.map((task) => task.label).join(", "));
  assert.ok(results.some((task) => task.id === "navbar"));
});

test("a search for something real always answers, even when it is shared", () => {
  // "price" has no colour of its own; the honest answer is where it comes from.
  // That answer is the *brand* primary, not the primary button: the button now
  // has its own optional fill, so pointing a price at it would send an owner to
  // a control that does not move prices.
  const price = searchAppearanceTasks("price");
  assert.ok(price.some((task) => task.id === "product-price"));
  const pointer = taskById("product-price");
  assert.equal(pointer?.fields.length, 0, "a pointer must not duplicate the control");
  assert.equal(pointer?.pointer?.toTaskId, "brand-primary");
  assert.ok((pointer?.pointer?.because ?? "").length > 30, "it must say why");

  const focus = searchAppearanceTasks("focus");
  assert.ok(focus.some((task) => task.id === "form-focus"));
});

test("every pointer names a task that exists", () => {
  for (const task of APPEARANCE_TASKS) {
    if (!task.pointer) continue;
    assert.ok(taskById(task.pointer.toTaskId), `${task.id} points at a task that does not exist`);
    assert.ok(
      (taskById(task.pointer.toTaskId)?.fields.length ?? 0) > 0,
      "a pointer must lead somewhere with an actual control"
    );
  }
});

test("everything the old token search could find is still findable", () => {
  // The task haystack includes each field's `usedBy` prose, so the vocabulary
  // did not shrink when the number of results did.
  for (const term of ["cart", "checkout", "stepper", "footer", "dropdown", "input", "badge", "border"]) {
    assert.ok(searchAppearanceTasks(term).length > 0, `“${term}” must still find something`);
  }
});

test("an empty query returns everything rather than nothing", () => {
  assert.equal(searchAppearanceTasks("").length, APPEARANCE_TASKS.length);
  assert.equal(searchAppearanceTasks("   ").length, APPEARANCE_TASKS.length);
});

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

test("no task speaks in tokens, variables or inheritance jargon", () => {
  const jargon = /--km-|--brand-|css variable|custom propert|token|unset|inherit|fallback|var\(/i;
  for (const task of APPEARANCE_TASKS) {
    assert.ok(!jargon.test(task.label), `${task.id} label: ${task.label}`);
    assert.ok(!jargon.test(task.description), `${task.id} description: ${task.description}`);
    for (const keyword of task.keywords ?? []) {
      assert.ok(!jargon.test(keyword), `${task.id} keyword: ${keyword}`);
    }
  }
});

test("field roles are the words a person uses about a thing", () => {
  const allowed = new Set(["Background", "Text", "Border", "Colour", "Fade"]);
  for (const task of APPEARANCE_TASKS) {
    for (const field of task.fields) {
      assert.ok(allowed.has(field.role), `${task.id}: ${field.role}`);
    }
  }
});

test("every task says what it is, in a sentence", () => {
  for (const task of APPEARANCE_TASKS) {
    assert.ok(task.label.length > 2, task.id);
    assert.ok(task.description.length > 25, `${task.id} needs a real sentence`);
    assert.ok(task.id === task.id.toLowerCase(), "ids are stable slugs");
  }
});

test("inheritance is offered as following the brand accent, never as “unset”", () => {
  /*
   * The words the owner sees for an optional colour. "Unset" and "clear"
   * describe the storage — an empty string, and a CSS variable that is not
   * emitted at all. What they are actually deciding is whether this thing has
   * its own colour or follows the brand, and that is what the control says.
   *
   * 5.0 moved the control into `ColorControls.tsx` and made it a button pair
   * whose label is read from the map, so a field that follows the *primary*
   * no longer offers to make it follow the accent.
   */
  const controls = readFileSync("src/app/staff/appearance/ColorControls.tsx", "utf8");
  assert.ok(controls.includes("Give it its own colour"), "opting out must be offered in words");
  assert.ok(controls.includes("Follow "), "opting back in must name what it follows");
  assert.match(controls, /setting\.optional\.inheritsFrom/, "the wording comes from the map, never a hard-coded accent");
  for (const source of [page, controls]) {
    const visible = source.match(/>[^<>{}]*\bunset\b[^<>{}]*</gi) ?? [];
    assert.deepEqual(visible, [], `"unset" must not reach the screen: ${visible.join(" | ")}`);
  }
});
