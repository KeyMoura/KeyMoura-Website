import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { APPEARANCE_SETTINGS, settingsForElement } from "../src/theme/appearanceMap.ts";
import { APPEARANCE_TASKS } from "../src/theme/appearanceTasks.ts";
import { defaultSiteTheme, normalizeSiteTheme } from "../src/theme/runtime.ts";

/**
 * Which rendered components consume which appearance role.
 *
 * `appearance-token-map.test.ts` keeps the *map* honest — every colour is
 * explained, every variable exists. It cannot catch the failure this file is
 * about: a component that stops reading the role it is documented to use.
 *
 * That is exactly what had happened to the storefront's Buy now button. Three
 * components implemented the primary action independently, and only two of
 * them were ever taught about the Primary button *style* setting, so a shop set
 * to "Outline" got outline buttons everywhere except the one CTA a customer is
 * most likely to press. Nothing failed; the map was still true; the button was
 * simply not wired to it.
 *
 * These assertions are about derivation, not pixels. They say "this class
 * reads that variable", which is the property that actually broke, and which
 * survives a palette change that would invalidate any screenshot.
 */

const globalsCss = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

/** The declaration block for a selector, with comments and whitespace flattened. */
function ruleFor(selector: string): string {
  const stripped = globalsCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const index = stripped.indexOf(`${selector} {`);
  assert.notEqual(index, -1, `globals.css has no rule for "${selector}"`);
  const end = stripped.indexOf("}", index);
  return stripped.slice(index, end).replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// The primary action role
// ---------------------------------------------------------------------------

/**
 * The three primary call-to-action implementations, and the role they must all
 * resolve through. `.product-card-action` is the storefront's Buy now.
 */
const PRIMARY_CONSUMERS = [".ui-btn-primary", ".catalog-action-primary", ".product-card-action"];

test("every primary call-to-action derives its colours from the primary action role", () => {
  for (const selector of PRIMARY_CONSUMERS) {
    const rule = ruleFor(selector);
    assert.match(rule, /var\(--primary-action-bg\)/, `${selector} must take its fill from the primary role`);
    assert.match(rule, /var\(--primary-action-text\)/, `${selector} must take its label colour from the primary role`);
    assert.match(rule, /var\(--primary-action-border\)/, `${selector} must take its edge from the primary role`);
  }
});

test("no primary call-to-action re-implements the brand colour directly", () => {
  for (const selector of PRIMARY_CONSUMERS) {
    const rule = ruleFor(selector);
    // Reading --brand-primary here is how Buy now drifted out of the system:
    // it looked right, and silently ignored every button style.
    assert.doesNotMatch(
      rule,
      /(background|color|border)[^;]*var\(--brand-primary/,
      `${selector} must go through the primary role, not straight to the brand colour`
    );
  }
});

test("the primary role is owner-controllable in fill, label and edge", () => {
  // Each owner-facing variable must be read *with* a fallback, so leaving it
  // unset keeps following the brand colour instead of blanking the button.
  assert.match(globalsCss, /--primary-action-bg: var\(--km-primary-button-bg,/, "the fill must be settable");
  assert.match(globalsCss, /--primary-action-text: var\(--km-primary-button-text,/, "the label must be settable");
  assert.match(globalsCss, /--primary-action-border: var\(--km-primary-button-border,/, "the edge must be settable");
});

test("each non-solid primary style re-points the label away from the on-fill colour", () => {
  /*
   * Soft and Outline used to keep `--km-primary-button-text` — a near-black
   * chosen to sit on gold — while removing the gold. Measured in the browser
   * that was 1.05:1: invisible. Framed was the only variant that had worked it
   * out. Each non-solid style must therefore state a label colour of its own.
   */
  for (const style of ["soft", "outline", "framed"]) {
    const rule = ruleFor(`[data-primary-button-style="${style}"]`);
    assert.match(
      rule,
      /--primary-action-text: var\(--brand-primary\)/,
      `the "${style}" primary style must draw its label in the brand colour, not the on-fill colour`
    );
  }
});

test("the storefront Buy now button is findable and explained in the editor", () => {
  // The owner's actual question was "which setting controls this?", asked of a
  // button whose name appeared nowhere in the editor.
  const byElement = settingsForElement("Buy now").map((setting) => setting.key);
  for (const key of ["primaryButtonBackground", "primaryButtonText", "primaryButtonBorder"]) {
    assert.ok(byElement.includes(key as never), `Buy now must resolve to ${key}`);
  }

  const task = APPEARANCE_TASKS.find((entry) => entry.id === "primary-button");
  assert.ok(task, "the primary button task must exist");
  assert.match(task!.description, /Buy now/, "the task must name the button by what it says on screen");
});

test("the primary button has background, text and border, like the secondary already did", () => {
  // The asymmetry that made the fill unreachable: secondary had all three,
  // primary had only its text, so the fill was only movable via the brand
  // colour — which also moves prices and focus rings.
  const keys = APPEARANCE_SETTINGS.map((setting) => setting.key);
  for (const key of ["primaryButtonBackground", "primaryButtonText", "primaryButtonBorder"]) {
    assert.ok(keys.includes(key as never), `${key} must be a real control`);
  }
});

test("the new primary overrides stay optional, so an untouched site is unchanged", () => {
  const normalized = normalizeSiteTheme({}) as unknown as Record<string, string>;
  assert.equal(normalized.primaryButtonBackground, "", "must keep following the brand colour until set");
  assert.equal(normalized.primaryButtonBorder, "", "must keep following the fill until set");
  assert.equal(defaultSiteTheme.primaryButtonBackground, "");
  assert.equal(defaultSiteTheme.primaryButtonBorder, "");

  const set = normalizeSiteTheme({ primaryButtonBackground: "#1d4ed8" }) as unknown as Record<string, string>;
  assert.equal(set.primaryButtonBackground, "#1d4ed8");
});

test("every optional colour declares what it actually follows", () => {
  /*
   * The editor paints the automatic swatch with this, labels the toggle with
   * it, and writes it into the field when automatic is switched off. It was
   * hard-coded to the accent for every optional colour, so the two
   * primary-button overrides — which follow the *primary* — showed an orange
   * swatch, said "Use brand accent", and repainted the button orange the
   * moment an owner opted out of automatic.
   */
  const optional = APPEARANCE_SETTINGS.filter((setting) => setting.optional);
  assert.ok(optional.length >= 7, "the optional overrides should all be flagged");
  for (const setting of optional) {
    assert.ok(
      setting.optional?.follows,
      `${setting.key} must say which colour it follows, not leave the editor to assume the accent`
    );
  }
  const followsFor = (key: string) =>
    APPEARANCE_SETTINGS.find((setting) => setting.key === key)?.optional?.follows;
  assert.equal(followsFor("primaryButtonBackground"), "primaryColor");
  assert.equal(followsFor("primaryButtonBorder"), "primaryButtonBackground");
  assert.equal(followsFor("badgeBackground"), "accentColor");
  assert.equal(followsFor("secondaryButtonBackground"), "accentColor");
});

test("the editor resolves each automatic colour rather than assuming the accent", () => {
  const page = readFileSync(new URL("../src/app/staff/appearance/page.tsx", import.meta.url), "utf8");
  const controls = readFileSync(new URL("../src/app/staff/appearance/ColorControls.tsx", import.meta.url), "utf8");
  assert.match(page, /case "primaryColor":\s*\n\s*return form\.primaryColor;/, "a primary-following field must show the primary");
  assert.match(
    page,
    /case "primaryButtonBackground":\s*\n\s*return form\.theme\.primaryButtonBackground \|\| form\.primaryColor;/,
    "the border must follow the fill, falling back to the primary"
  );
  /*
   * Opting out must seed the field with what was already rendering, so that
   * giving a colour its own value never changes what is on screen — it only
   * stops it tracking future palette changes.
   *
   * 5.0 replaced the checkbox with a button pair. The two states are not
   * symmetrical — "following the accent" is a statement about where the value
   * comes from and "custom #E5A000" is a value — and one checkbox label had to
   * describe both, which is how it ended up saying "Use brand accent" on the
   * three fields that follow the primary.
   */
  assert.match(controls, /onChange\(following \? fallback : ""\)/);
  assert.doesNotMatch(controls, /onChange\(following \? accent : ""\)/, "the accent must not be written into a primary-following field");
  // And the control must name the colour this particular field follows, which
  // it takes from the map rather than assuming.
  assert.match(controls, /setting\.optional\.inheritsFrom/);
  assert.match(controls, /Following <b[^>]*>\{setting\.optional\?\.inheritsFrom\}/);
});

test("the contrast warning checks the fill that actually renders", () => {
  /*
   * With a Primary button background set, the fill is that override — not the
   * brand colour. Comparing the label against `primaryColor` let a dark
   * override with the default near-black label pass, then publish an
   * unreadable Buy now, Checkout and every staff primary action.
   */
  const page = readFileSync(new URL("../src/app/staff/appearance/page.tsx", import.meta.url), "utf8");
  assert.match(page, /const primaryFill = form\.theme\.primaryButtonBackground \|\| form\.primaryColor;/);
  assert.match(page, /const secondaryFill = form\.theme\.secondaryButtonBackground \|\| form\.accentColor;/);
  assert.match(page, /contrast\(form\.theme\.primaryButtonText, primaryFill\)/);
  assert.match(page, /contrast\(form\.theme\.secondaryButtonText, secondaryFill\)/);
  assert.doesNotMatch(
    page,
    /contrast\(form\.theme\.primaryButtonText, form\.primaryColor\)/,
    "the check must not compare the label against a colour the button may not be using"
  );
  // The non-solid shapes draw the label in the brand colour, on the fill.
  assert.match(page, /contrast\(form\.primaryColor, primaryFill\)/);
});

test("the appearance preview shows the real Buy now component, not an approximation", () => {
  const page = readFileSync(new URL("../src/app/staff/appearance/page.tsx", import.meta.url), "utf8");
  const stage = readFileSync(new URL("../src/app/staff/appearance/PreviewStage.tsx", import.meta.url), "utf8");
  /*
   * Stronger than it was. The preview used to render `.product-card-action`
   * itself — the real class, but hand-written markup around it. It now mounts
   * `ProductCard`, the component the catalog mounts, in `.catalog-grid`, the
   * container the catalog uses, in both of the real view modes. There is no
   * approximation left to drift.
   */
  assert.match(stage, /import ProductCard/, "the preview must mount the real card");
  assert.match(stage, /<ProductCard /);
  assert.match(stage, /className="catalog-grid"/);
  assert.match(page, /"--km-primary-button-bg": form\.theme\.primaryButtonBackground/, "the preview must emit the new fill");
  assert.match(page, /"--km-primary-button-border": form\.theme\.primaryButtonBorder/, "the preview must emit the new edge");
});

// ---------------------------------------------------------------------------
// The other roles named in the coverage matrix
// ---------------------------------------------------------------------------

test("secondary buttons, badges, inputs and navigation read their documented variables", () => {
  const cases: [string, string[]][] = [
    [".ui-btn-secondary", ["--km-secondary-button-bg", "--km-secondary-button-border", "--km-secondary-button-text"]],
    [".ui-badge-accent", ["--km-badge-border", "--km-badge-bg", "--km-badge-text"]],
    [".ui-input", ["--border", "--panel-strong", "--text"]],
  ];
  for (const [selector, variables] of cases) {
    const rule = ruleFor(selector);
    for (const variable of variables) {
      assert.match(rule, new RegExp(`var\\(${variable}`), `${selector} must read ${variable}`);
    }
  }
});

test("status colours stay literal, and the editor says so rather than implying control", () => {
  for (const selector of [".ui-badge-success", ".ui-badge-danger"]) {
    const rule = ruleFor(selector);
    assert.match(rule, /#(4ade80|fb7185)/, `${selector} is intentionally fixed and must stay literal`);
  }
  const panels = readFileSync(new URL("../src/app/staff/appearance/panels.tsx", import.meta.url), "utf8");
  assert.match(
    panels,
    /deliberately fixed green and red/,
    "the editor must tell the truth about which statuses it cannot theme"
  );
  // And it must say why, beside the badges themselves, in the section where a
  // shop owner would look for them.
  assert.match(panels, /Sold out badge in your accent green/);
});
