import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Label-to-control spacing, as a rule rather than a look.
 *
 * The reported defect was `Project type *` sitting on top of its dropdown on
 * `/orders/new`. The cause was not that one field: every control on all four
 * steps shared `const input = "ui-input mt-1"` — 4px — while `/staff/orders/new`
 * used `mt-2` and the rest of the project used `.ui-label`. Three spacings, so
 * "fix the spacing" had no single answer.
 *
 * These assert the *system* held afterwards: one place decides the spacing, and
 * the forms use it instead of choosing their own.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const globalsCss = read("src/app/globals.css");
/**
 * Since Custom Project Request 3.0 the request form's fields live in
 * `CustomRequestSteps` and its review/contact fields in `CustomRequestWizard`;
 * `/orders/new/page.tsx` is a server component that loads the catalog. Both
 * halves are read here so "no field on this form sets its own spacing" still
 * covers the whole form.
 */
const customRequestForm =
  read("src/components/orders/CustomRequestSteps.tsx") +
  read("src/components/orders/CustomRequestWizard.tsx");
const requestControls = read("src/components/orders/RequestControls.tsx");
const designSystem = read("src/components/ui/DesignSystem.tsx");

test("label spacing is declared once, in the stylesheet", () => {
  const label = globalsCss.match(/\.ui-label\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(label, /margin-bottom:\s*0\.5rem/, ".ui-label owns the gap between a label and its control");
  assert.match(label, /display:\s*block/, "an inline label would sit beside the control rather than above it");
});

test("the required marker has room and is not the label's last character", () => {
  const required = globalsCss.match(/\.ui-required\s*\{[^}]*\}/)?.[0] ?? "";
  assert.ok(required, ".ui-required must exist; a bare * in the label string is what collided with the control");
  assert.match(required, /margin-left/, "the marker needs separation from the label's last word");
});

test("help text is a system class, not a per-page span", () => {
  const help = globalsCss.match(/\.ui-help\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(help, /margin-top/, "help text needs its own gap below the control");
});

/**
 * The regression that matters.
 *
 * `mt-1` on a control is the exact defect. If it comes back on this page — in
 * the shared constant or on any single field — the label is 4px from its
 * control again.
 */
test("the custom request form no longer sets its own control spacing", () => {
  assert.doesNotMatch(
    customRequestForm,
    /const input\s*=\s*"[^"]*\bmt-\d/,
    "the shared control class must not carry a margin; spacing belongs to .ui-label"
  );
  assert.doesNotMatch(
    customRequestForm,
    /className=\{`\$\{input\}[^`]*\bmt-\d/,
    "no field may re-add a margin on top of the shared class"
  );
});

test("every field on the custom request form goes through the shared component", () => {
  // The old shape: a bare text node inside a label, with the control after it.
  // It is what made the label unstyleable and the spacing per-field.
  assert.doesNotMatch(
    customRequestForm,
    /<label className="text-sm">[A-Z]/,
    "a bare label text node bypasses .ui-label entirely"
  );
  // `RequestField` is `Field` plus the error association a validated form
  // needs; `ChoiceGroup` is the fieldset/legend a group of radios needs, which
  // one `<label>` cannot be. Both keep `.ui-label`, which is what this file is
  // really about.
  assert.ok(
    customRequestForm.includes("<RequestField") || customRequestForm.includes("<Field"),
    "the form should render fields through a shared component"
  );
  assert.match(requestControls, /className="ui-label"/, "the shared field must still use .ui-label");
});

test("the required fields are marked as required, not merely asterisked", () => {
  // The project type is a group of radio cards now, so its required-ness is
  // carried by the group rather than by a dropdown's label.
  assert.match(customRequestForm, /legend="What kind of project is this\?"/);
  assert.match(
    customRequestForm,
    /label="Tell us what you want made and what it needs to do"\s*\n?\s*htmlFor=\{descriptionId\}\s*\n?\s*required/,
    "the description is validated at 20 characters, so it is required"
  );
  assert.doesNotMatch(
    customRequestForm,
    /label="[^"]*\*"/,
    "the asterisk is the component's job, so it can carry a text equivalent"
  );
});

test("the asterisk is hidden from screen readers and replaced with a word", () => {
  assert.match(
    designSystem,
    /ui-required" aria-hidden="true"/,
    "a bare * is announced as 'star' or skipped, depending on the reader"
  );
  assert.match(designSystem, /sr-only">\s*\(required\)/, "required needs a text equivalent");
});

test("MenuSelect fields carry their own accessible name", () => {
  // A wrapping <label> names a form control, but MenuSelect renders a button,
  // which it does not name. Every MenuSelect on the page must say what it is.
  const menuSelects = customRequestForm.match(/<MenuSelect[^/]*/g) ?? [];
  assert.ok(menuSelects.length >= 2, "the form has a project type and a material dropdown");
  for (const element of menuSelects) {
    assert.match(element, /ariaLabel=/, `a MenuSelect without ariaLabel is an unnamed button: ${element.slice(0, 60)}`);
  }
});
