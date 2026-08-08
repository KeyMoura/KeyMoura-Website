import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  APPEARANCE_GROUPS,
  APPEARANCE_SETTINGS,
  appearanceSettingsByGroup,
  searchAppearanceSettings,
  settingsForElement,
} from "../src/theme/appearanceMap.ts";
import { defaultSiteTheme, normalizeSiteTheme, optionalVars } from "../src/theme/runtime.ts";

/**
 * The appearance token map: what every colour control actually changes.
 *
 * These exist because the previous Appearance page could go wrong in a way no
 * other layer could see. A control labelled "Accent / selected states" that in
 * fact drove eight unrelated things was not a type error, not a lint error and
 * not a failing render — it was simply a page that could not answer "which
 * setting controls this?". The map turns that answer into data, and this suite
 * is what keeps the data honest.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const globalsCss = read("src/app/globals.css");
const rootLayout = read("src/app/layout.tsx");

/** Colour-valued keys on the theme, found by value rather than by a second hand-written list. */
const themeColorKeys = Object.entries(defaultSiteTheme)
  .filter(([, value]) => typeof value === "string" && (value === "" || value.startsWith("#")))
  .map(([key]) => key);

test("every theme colour is explained exactly once", () => {
  const mapped = APPEARANCE_SETTINGS.map((setting) => setting.key).filter(
    (key) => key !== "primaryColor" && key !== "accentColor"
  );
  const duplicates = mapped.filter((key, index) => mapped.indexOf(key) !== index);
  assert.deepEqual(duplicates, [], "a colour listed twice would render two controls writing the same value");

  const missing = themeColorKeys.filter((key) => !(mapped as string[]).includes(key));
  assert.deepEqual(
    missing,
    [],
    "a theme colour with no map entry is a setting the page cannot render, or renders with no explanation"
  );

  const unknown = (mapped as string[]).filter((key) => !themeColorKeys.includes(key));
  assert.deepEqual(unknown, [], "the map names a colour the theme does not have");
});

test("the two brand colours are mapped", () => {
  for (const key of ["primaryColor", "accentColor"]) {
    assert.ok(
      APPEARANCE_SETTINGS.some((setting) => setting.key === key),
      `${key} lives outside the theme object and is still a control`
    );
  }
});

test("every declared CSS variable is one the stylesheet actually reads", () => {
  for (const setting of APPEARANCE_SETTINGS) {
    assert.ok(
      globalsCss.includes(setting.variable),
      `${setting.label} claims ${setting.variable}, which no rule in globals.css uses`
    );
  }
});

test("every mapped variable is emitted by the root layout", () => {
  for (const setting of APPEARANCE_SETTINGS) {
    assert.ok(
      rootLayout.includes(`"${setting.variable}"`),
      `${setting.variable} is mapped and previewed but never reaches the live site`
    );
  }
});

test("every setting carries the three things a bare label cannot", () => {
  for (const setting of APPEARANCE_SETTINGS) {
    assert.ok(setting.label.length > 2, `${setting.key} needs a human name`);
    assert.ok(setting.description.length > 15, `${setting.key} needs a real sentence, not a restated label`);
    assert.ok(setting.usedBy.length > 0, `${setting.key} must name at least one thing it changes`);
    // A label that is only the token name is what this whole file exists to
    // prevent. Nothing user-facing may read like a CSS custom property.
    assert.ok(!/^--/.test(setting.label), `${setting.key} exposes a variable name as its label`);
    assert.ok(!setting.label.includes("_"), `${setting.key} exposes a schema-shaped label`);
  }
});

test("every group renders and declares its scope", () => {
  for (const group of APPEARANCE_GROUPS) {
    const settings = appearanceSettingsByGroup(group.id);
    assert.ok(settings.length > 0, `group "${group.label}" would render as an empty heading`);
    assert.ok(
      ["storefront", "staff", "both"].includes(group.scope),
      `group "${group.label}" must say whether it touches the storefront, the staff area or both`
    );
  }
  const grouped = APPEARANCE_SETTINGS.filter((setting) =>
    APPEARANCE_GROUPS.some((group) => group.id === setting.group)
  );
  assert.equal(grouped.length, APPEARANCE_SETTINGS.length, "a setting is filed under a group that does not exist");
});

/**
 * The findability cases, named from the owner's own report.
 *
 * Each searches for a word somebody would say while looking at their screen —
 * not the token's name. That is the failure being closed: "Customizable" was
 * findable only by knowing it is an accent.
 */
test("searching by what is on screen finds the control", () => {
  const cases: [string, string][] = [
    ["customizable", "badgeBackground"],
    ["custom project", "secondaryButtonBackground"],
    ["badge", "badgeText"],
    ["cart", "navigationBadgeBackground"],
    ["price", "primaryColor"],
    ["add to cart", "primaryButtonText"],
    ["product card", "surface"],
    ["input", "surfaceStrong"],
    ["navbar", "navigationBackground"],
    ["menu", "navigationMobileBackground"],
    ["accent", "accentColor"],
    ["button", "primaryButtonText"],
    ["text", "text"],
    ["catalog", "secondaryButtonText"],
  ];
  for (const [query, expected] of cases) {
    const found = searchAppearanceSettings(query).map((setting) => setting.key);
    assert.ok((found as string[]).includes(expected), `searching "${query}" should surface ${expected}; got ${found.join(", ")}`);
  }
});

test("an empty search returns everything rather than nothing", () => {
  assert.equal(searchAppearanceSettings("").length, APPEARANCE_SETTINGS.length);
  assert.equal(searchAppearanceSettings("   ").length, APPEARANCE_SETTINGS.length);
});

test("a search that matches nothing returns nothing, not everything", () => {
  assert.deepEqual(searchAppearanceSettings("zzzzz-no-such-thing"), []);
});

/**
 * The elements the owner named, each resolvable to a control.
 *
 * This is the acceptance test for the whole pass: every one of these was a
 * thing somebody could see and could not find a setting for.
 */
test("every element the owner asked about resolves to at least one control", () => {
  const elements = [
    "Customizable",
    "Start a custom project",
    "Request a Custom Version",
    "Add to Cart",
    "price",
    "Product cards",
    "cart count",
    "phone menu",
    "input",
  ];
  for (const element of elements) {
    const settings = settingsForElement(element);
    assert.ok(settings.length > 0, `nothing in the map claims to control "${element}"`);
  }
});

test("the Customizable badge has its own background, text and border", () => {
  const forBadge = settingsForElement("Customizable").map((setting) => setting.key);
  for (const key of ["badgeBackground", "badgeText", "badgeBorder"]) {
    assert.ok((forBadge as string[]).includes(key), `the badge needs a ${key} control of its own, not only the accent`);
  }
});

test("the custom project CTA has its own background, text and border", () => {
  const forCta = settingsForElement("Start a custom project").map((setting) => setting.key);
  for (const key of ["secondaryButtonBackground", "secondaryButtonText", "secondaryButtonBorder"]) {
    assert.ok((forCta as string[]).includes(key), `the CTA needs a ${key} control; ${key} is missing`);
  }
});

/**
 * "Unset" has to survive the round trip.
 *
 * If normalisation replaced `""` with a default hex, the badge would freeze at
 * whatever the accent was the first time anything saved, and would stop
 * following a later palette change — silently, and only on sites that had
 * opened the page.
 */
test("an optional colour left unset stays unset", () => {
  const optional = APPEARANCE_SETTINGS.filter((setting) => setting.optional).map((setting) => setting.key);
  assert.ok(optional.length >= 5, "the five optional overrides should be flagged as optional");

  const normalized = normalizeSiteTheme({}) as unknown as Record<string, string>;
  for (const key of optional) {
    assert.equal(normalized[key], "", `${key} must normalise to "" so it keeps following the accent`);
  }
});

test("an optional colour that is set survives, and a malformed one falls back to inheriting", () => {
  const set = normalizeSiteTheme({ badgeBackground: "#123456" }) as unknown as Record<string, string>;
  assert.equal(set.badgeBackground, "#123456");

  const bad = normalizeSiteTheme({ badgeBackground: "not-a-colour" }) as unknown as Record<string, string>;
  assert.equal(bad.badgeBackground, "", "a malformed value inherits rather than becoming a hard-coded colour");
});

test("a required colour is never left empty", () => {
  const required = APPEARANCE_SETTINGS.filter(
    (setting) => !setting.optional && setting.key !== "primaryColor" && setting.key !== "accentColor"
  );
  const normalized = normalizeSiteTheme({}) as unknown as Record<string, string>;
  for (const setting of required) {
    assert.match(
      normalized[setting.key],
      /^#[0-9a-f]{6}$/i,
      `${setting.key} is not optional, so it must always resolve to a colour`
    );
  }
});

/**
 * The mechanism behind "unset means inherit".
 *
 * An empty custom property is still *defined*, so `var(--x, fallback)` would
 * resolve it to nothing rather than to the derivation behind it. Dropping the
 * declaration entirely is the only thing that makes the fallback reachable.
 */
test("optionalVars omits unset values entirely", () => {
  const out = optionalVars({ "--a": "#fff", "--b": "", "--c": "#000" });
  assert.deepEqual(out, { "--a": "#fff", "--c": "#000" });
  assert.ok(!("--b" in out), "an empty override must be absent, not present-and-empty");
});

test("each optional setting keeps its CSS fallback, so unset renders as before", () => {
  for (const setting of APPEARANCE_SETTINGS.filter((entry) => entry.optional)) {
    // `var(--km-badge-bg, …)` — the comma proves a fallback exists. Without one,
    // an untouched site would lose the colour instead of inheriting it.
    const withFallback = new RegExp(`var\\(\\s*${setting.variable}\\s*,`);
    assert.match(
      globalsCss,
      withFallback,
      `${setting.variable} must always be read with a fallback, or leaving it unset removes the colour`
    );
  }
});

test("every optional setting says what it follows", () => {
  for (const setting of APPEARANCE_SETTINGS.filter((entry) => entry.optional)) {
    assert.ok(
      (setting.optional?.inheritsFrom.length ?? 0) > 5,
      `${setting.key} is optional, so the page has to be able to say what it follows`
    );
  }
});

/**
 * Status colours are deliberately not configurable.
 *
 * Recorded as an assertion rather than a comment: a red that could be
 * reassigned would stop meaning "stopped". If somebody later routes these
 * through the theme, this test is the conversation.
 */
test("semantic status colours stay fixed and unmapped", () => {
  for (const variable of ["--km-danger", "--km-success"]) {
    assert.ok(
      !APPEARANCE_SETTINGS.some((setting) => setting.variable === variable),
      `${variable} is intentionally fixed; success and danger must not become theme colours`
    );
  }
  assert.match(globalsCss, /\.ui-badge-danger\s*\{[^}]*#fb7185/, "danger stays a literal red");
  assert.match(globalsCss, /\.ui-badge-success\s*\{[^}]*#4ade80/, "success stays a literal green");
});
