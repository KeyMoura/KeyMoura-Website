import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  EMPTY_DETAIL_CONTENT,
  parseDetailContent,
  serializeDetailContent,
  type ProductDetailContent,
} from "../src/lib/commerce/productContent.ts";
import {
  addRow,
  blankRow,
  CONTENT_LIMITS,
  CONTENT_LIST_KEYS,
  CONTENT_LIST_META,
  describeIncompleteRows,
  incompleteRowIndexes,
  isListFull,
  MAX_ENTRIES,
  moveRow,
  removeRow,
  updateRow,
} from "../src/lib/commerce/productContentEditing.ts";
import ProductContentEditor from "../src/components/staff/ProductContentEditor.tsx";

const editorSource = readFileSync("src/components/staff/ProductContentEditor.tsx", "utf8");

/**
 * Source with comments removed.
 *
 * Several assertions below are of the form "this must not appear". The prose in
 * this component explains *why* it no longer re-parses its own state and
 * therefore names `parseDetailContent` in order to say it is not called.
 * Matching the comment instead of the code would fail on the documentation.
 */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const clone = (content: ProductDetailContent): ProductDetailContent => structuredClone(content);

/** Content as it comes back from the column: two of everything, all complete. */
const saved = (): ProductDetailContent =>
  parseDetailContent({
    benefits: [
      { title: "Machined from billet", body: "No cast porosity" },
      { title: "Weighted", body: "Shorter throws" },
    ],
    specifications: [
      { name: "Thread", value: "M10 x 1.25" },
      { name: "Material", value: "6061 aluminium" },
    ],
    compatibility: [
      { value: "Miata NA", note: "1989-1997" },
      { value: "Miata NB", note: "1998-2005" },
    ],
    included: [
      { value: "Shift knob", note: "" },
      { value: "Hex key", note: "2.5 mm" },
    ],
    faq: [
      { question: "Does it fit a Miata?", answer: "Yes" },
      { question: "Is it reversible?", answer: "Yes, keep the original" },
    ],
  });

const render = (content: ProductDetailContent, disabled = false) =>
  renderToStaticMarkup(
    createElement(ProductContentEditor, {
      draft: { name: "Premade Shift Knob" },
      onChange: () => {},
      content,
      onContentChange: () => {},
      disabled,
    }),
  );

/**
 * Every rendered `<button>`, with the name a screen reader would announce.
 *
 * The disabled check matches the HTML attribute React emits (`disabled=""`) and
 * not the bare word, because every one of these controls carries a Tailwind
 * `disabled:opacity-40` class that a looser pattern reports as disabled.
 */
function buttons(html: string): { name: string; type: string | null; disabled: boolean }[] {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attributes, inner]) => ({
    name: /aria-label="([^"]*)"/.exec(attributes)?.[1] ?? inner.replace(/<[^>]*>/g, "").trim(),
    type: /\btype="([^"]*)"/.exec(attributes)?.[1] ?? null,
    disabled: /\sdisabled(=""|\s|$)/.test(attributes),
  }));
}

const inputValues = (html: string) => [...html.matchAll(/<input\b[^>]*\bvalue="([^"]*)"/g)].map(([, value]) => value);
const textareaValues = (html: string) =>
  [...html.matchAll(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/g)].map(([, value]) => value);

// ---------------------------------------------------------------------------
// The defect: an Add button must produce a row
//
// Every one of these returned an unchanged list in the shipped build, because
// the editor rebuilt its state with `parseDetailContent` on every mutation and
// a freshly added row is blank — which is exactly what that parser drops.
// ---------------------------------------------------------------------------

test("every Add button appends exactly one blank row to an empty list", () => {
  for (const key of CONTENT_LIST_KEYS) {
    const next = addRow(EMPTY_DETAIL_CONTENT, key);
    assert.equal(next[key].length, 1, `${key}: Add produced no row`);
    assert.deepEqual(next[key][0], blankRow(key), `${key}: the new row is not a blank of the right shape`);
    // The other four lists are untouched, by identity and not merely by value.
    for (const other of CONTENT_LIST_KEYS) {
      if (other === key) continue;
      assert.equal(next[other], EMPTY_DETAIL_CONTENT[other], `${key}: adding disturbed ${other}`);
    }
  }
});

test("Add works the same on a list that already holds rows", () => {
  const base = saved();
  for (const key of CONTENT_LIST_KEYS) {
    const next = addRow(base, key);
    assert.equal(next[key].length, 3, `${key}: expected a third row`);
    assert.deepEqual(next[key].slice(0, 2), base[key], `${key}: the two existing rows changed`);
  }
});

test("adding several rows in a row keeps every one of them", () => {
  let content = EMPTY_DETAIL_CONTENT;
  for (let i = 0; i < 5; i += 1) content = addRow(content, "benefits");
  assert.equal(content.benefits.length, 5);

  // And typing into them does not disturb the siblings.
  content = updateRow(content, "benefits", 0, { title: "First" });
  content = updateRow(content, "benefits", 4, { title: "Fifth" });
  assert.deepEqual(
    content.benefits.map((row) => row.title),
    ["First", "", "", "", "Fifth"],
  );
});

test("adding one kind of content never resets another", () => {
  let content = saved();
  const before = clone(content);
  for (const key of CONTENT_LIST_KEYS) content = addRow(content, key);

  for (const key of CONTENT_LIST_KEYS) {
    assert.equal(content[key].length, 3, `${key}: expected two saved rows plus one new`);
    assert.deepEqual(content[key].slice(0, 2), before[key], `${key}: saved rows were altered`);
  }
});

test("a list refuses to grow past the cap the parser enforces", () => {
  let content = EMPTY_DETAIL_CONTENT;
  for (let i = 0; i < MAX_ENTRIES + 5; i += 1) content = addRow(content, "included");

  assert.equal(content.included.length, MAX_ENTRIES, "the editor must not hold rows a save would drop");
  assert.equal(isListFull(content, "included"), true);
  // At the cap the reducer returns the *same object*, so nothing is marked dirty.
  assert.equal(addRow(content, "included"), content);
});

// ---------------------------------------------------------------------------
// Editing: what staff type is what is held
// ---------------------------------------------------------------------------

test("a trailing space survives, so multi-word values can be typed", () => {
  // The shipped editor trimmed on every keystroke, so the space between two
  // words was deleted before the second word could be started: typing
  // "Shift knob" produced "Shiftknob".
  let content = addRow(EMPTY_DETAIL_CONTENT, "benefits");
  for (const value of ["S", "Sh", "Shi", "Shif", "Shift", "Shift ", "Shift k"]) {
    content = updateRow(content, "benefits", 0, { title: value });
    assert.equal(content.benefits[0].title, value, `verbatim input lost at "${value}"`);
  }
});

test("editing a FAQ row keeps every FAQ row", () => {
  // The shipped editor passed FAQ rows back through a parser that reads them as
  // `question`/`answer` while the editor holds `title`/`body`, so every row
  // parsed to blank and the whole list was wiped by a single keystroke — and
  // then saved as empty.
  const content = saved();
  const next = updateRow(content, "faq", 0, { title: "Does it fit a Miata NA?" });

  assert.equal(next.faq.length, 2, "editing one question destroyed the list");
  assert.equal(next.faq[0].title, "Does it fit a Miata NA?");
  assert.equal(next.faq[0].body, "Yes", "the answer beside the edited question was lost");
  assert.deepEqual(next.faq[1], content.faq[1], "the untouched question changed");
});

test("clearing half of a specification leaves the row in place to be retyped", () => {
  const content = saved();
  const cleared = updateRow(content, "specifications", 0, { value: "" });
  assert.equal(cleared.specifications.length, 2, "the row vanished mid-edit");
  assert.equal(cleared.specifications[0].name, "Thread");

  const retyped = updateRow(cleared, "specifications", 0, { value: "M10 x 1.5" });
  assert.equal(retyped.specifications[0].value, "M10 x 1.5");
});

test("an out-of-range index is a no-op rather than a corrupted list", () => {
  const content = saved();
  for (const index of [-1, 2, 99, 1.5, Number.NaN]) {
    assert.equal(updateRow(content, "benefits", index, { title: "x" }), content);
    assert.equal(removeRow(content, "benefits", index), content);
  }
});

// ---------------------------------------------------------------------------
// Remove and reorder
// ---------------------------------------------------------------------------

test("remove takes the first, middle, or last row and only that row", () => {
  const content = parseDetailContent({
    benefits: [
      { title: "A", body: "a" },
      { title: "B", body: "b" },
      { title: "C", body: "c" },
    ],
  });

  assert.deepEqual(removeRow(content, "benefits", 0).benefits.map((r) => r.title), ["B", "C"]);
  assert.deepEqual(removeRow(content, "benefits", 1).benefits.map((r) => r.title), ["A", "C"]);
  assert.deepEqual(removeRow(content, "benefits", 2).benefits.map((r) => r.title), ["A", "B"]);

  // Bodies travel with their own titles.
  assert.deepEqual(removeRow(content, "benefits", 1).benefits.map((r) => r.body), ["a", "c"]);
});

test("remove leaves the other four lists untouched", () => {
  const content = saved();
  for (const key of CONTENT_LIST_KEYS) {
    const next = removeRow(content, key, 0);
    assert.equal(next[key].length, 1, `${key}: expected one row left`);
    for (const other of CONTENT_LIST_KEYS) {
      if (other === key) continue;
      assert.equal(next[other], content[other], `${key}: removing disturbed ${other}`);
    }
  }
});

test("reorder swaps neighbours and affects only the list it was asked about", () => {
  const content = saved();
  const moved = moveRow(content, "specifications", 0, 1);
  assert.deepEqual(moved.specifications.map((r) => r.name), ["Material", "Thread"]);
  assert.deepEqual(moved.specifications.map((r) => r.value), ["6061 aluminium", "M10 x 1.25"]);

  for (const other of CONTENT_LIST_KEYS) {
    if (other === "specifications") continue;
    assert.equal(moved[other], content[other], `reordering specifications disturbed ${other}`);
  }

  // Moving back restores the original order exactly.
  assert.deepEqual(moveRow(moved, "specifications", 1, -1).specifications, content.specifications);
});

test("reordering past either end changes nothing at all", () => {
  const content = saved();
  assert.equal(moveRow(content, "benefits", 0, -1), content);
  assert.equal(moveRow(content, "benefits", content.benefits.length - 1, 1), content);
});

// ---------------------------------------------------------------------------
// Empty rows are refused out loud, not discarded in silence
// ---------------------------------------------------------------------------

test("the warning counts exactly the rows a save would drop", () => {
  // This is the invariant that keeps the notice honest: whatever the editor
  // says will not be saved is precisely what `serializeDetailContent` removes.
  const content = parseDetailContent({
    benefits: [{ title: "Real", body: "" }],
    specifications: [{ name: "Thread", value: "M10" }],
    compatibility: [{ value: "Miata", note: "" }],
    included: [{ value: "Knob", note: "" }],
    faq: [{ question: "Q", answer: "A" }],
  });

  let withBlanks = content;
  for (const key of CONTENT_LIST_KEYS) withBlanks = addRow(addRow(withBlanks, key), key);
  // One half-filled specification, which is incomplete for a different reason.
  withBlanks = updateRow(withBlanks, "specifications", 1, { name: "Finish" });

  const serialized = serializeDetailContent(withBlanks);
  for (const key of CONTENT_LIST_KEYS) {
    const kept = withBlanks[key].length - incompleteRowIndexes(withBlanks, key).length;
    assert.equal(kept, serialized[key].length, `${key}: the warning disagrees with what is saved`);
  }
});

test("each list explains what an incomplete row is missing", () => {
  for (const key of CONTENT_LIST_KEYS) {
    assert.equal(describeIncompleteRows(EMPTY_DETAIL_CONTENT, key), null, `${key}: warned about nothing`);

    const one = addRow(EMPTY_DETAIL_CONTENT, key);
    const message = describeIncompleteRows(one, key);
    assert.ok(message, `${key}: a blank row produced no warning`);
    assert.match(message, /^1 incomplete /, `${key}: "${message}" does not count the rows`);
    assert.ok(message.includes(CONTENT_LIST_META[key].noun), `${key}: "${message}" does not name the list`);
    assert.ok(message.endsWith("."), `${key}: "${message}" is not a sentence`);

    // Plural agreement, because "2 incomplete benefit" reads as a typo.
    const two = addRow(one, key);
    assert.ok(describeIncompleteRows(two, key)?.includes(CONTENT_LIST_META[key].plural));
  }
});

test("a specification is incomplete until both halves are filled", () => {
  let content = addRow(EMPTY_DETAIL_CONTENT, "specifications");
  assert.deepEqual(incompleteRowIndexes(content, "specifications"), [0]);

  content = updateRow(content, "specifications", 0, { name: "Thread" });
  assert.deepEqual(incompleteRowIndexes(content, "specifications"), [0], "a name alone is not a specification");

  content = updateRow(content, "specifications", 0, { value: "M10" });
  assert.deepEqual(incompleteRowIndexes(content, "specifications"), []);

  // Whitespace is not content, matching the parser.
  content = updateRow(content, "specifications", 0, { value: "   " });
  assert.deepEqual(incompleteRowIndexes(content, "specifications"), [0]);
});

test("a benefit needs only one of its two halves", () => {
  const titleOnly = updateRow(addRow(EMPTY_DETAIL_CONTENT, "benefits"), "benefits", 0, { title: "Solid" });
  assert.deepEqual(incompleteRowIndexes(titleOnly, "benefits"), []);
  const bodyOnly = updateRow(addRow(EMPTY_DETAIL_CONTENT, "benefits"), "benefits", 0, { body: "Machined" });
  assert.deepEqual(incompleteRowIndexes(bodyOnly, "benefits"), []);
});

// ---------------------------------------------------------------------------
// Save and reload
// ---------------------------------------------------------------------------

test("rows added in the editor survive a save and a reload", () => {
  let content = EMPTY_DETAIL_CONTENT;
  for (const key of CONTENT_LIST_KEYS) content = addRow(content, key);
  content = updateRow(content, "benefits", 0, { title: "Machined from billet", body: "No porosity" });
  content = updateRow(content, "specifications", 0, { name: "Thread", value: "M10 x 1.25" });
  content = updateRow(content, "compatibility", 0, { value: "Miata NA", note: "1989-1997" });
  content = updateRow(content, "included", 0, { value: "Shift knob" });
  content = updateRow(content, "faq", 0, { title: "Does it fit?", body: "Yes" });

  // What the page would write to `products.detail_content`…
  const stored = serializeDetailContent(content);
  // …and what the editor would load back out of it.
  const reloaded = parseDetailContent(JSON.parse(JSON.stringify(stored)));

  for (const key of CONTENT_LIST_KEYS) assert.equal(reloaded[key].length, 1, `${key}: lost on the round trip`);
  assert.equal(reloaded.benefits[0].title, "Machined from billet");
  assert.equal(reloaded.specifications[0].value, "M10 x 1.25");
  assert.equal(reloaded.compatibility[0].note, "1989-1997");
  assert.equal(reloaded.included[0].value, "Shift knob");
  assert.equal(reloaded.faq[0].title, "Does it fit?", "the question did not survive serialization");
  assert.equal(reloaded.faq[0].body, "Yes", "the answer did not survive serialization");
});

test("a blank row left behind is dropped on save and nothing else is", () => {
  let content = saved();
  for (const key of CONTENT_LIST_KEYS) content = addRow(content, key);

  const stored = serializeDetailContent(content);
  const reloaded = parseDetailContent(JSON.parse(JSON.stringify(stored)));
  for (const key of CONTENT_LIST_KEYS) {
    assert.equal(stored[key].length, 2, `${key}: the two real rows must survive`);
    assert.deepEqual(reloaded[key], saved()[key], `${key}: a real row was altered`);
  }
});

test("FAQs are stored under the keys the reader looks for", () => {
  // Not a shape preference: `serializeDetailContent` wrote FAQ rows as
  // title/body while `parseDetailContent` read question/answer, so every FAQ a
  // staff member saved came back empty — invisible on the product page and
  // gone from the editor on the next load.
  const stored = serializeDetailContent(saved());
  assert.deepEqual(Object.keys(stored.faq[0]).sort(), ["answer", "question"]);
  assert.equal(stored.faq[0].question, "Does it fit a Miata?");
  assert.equal(stored.faq[0].answer, "Yes");

  const reloaded = parseDetailContent(JSON.parse(JSON.stringify(stored)));
  assert.equal(reloaded.faq.length, 2, "a saved FAQ did not survive the column");
  assert.deepEqual(reloaded.faq, saved().faq);
});

test("a FAQ already stored in the editor's own shape still loads", () => {
  // Anything written by the shipped build sits in the column as title/body.
  // The parser is total about the column's contents, so it reads both.
  const legacy = parseDetailContent({ faq: [{ title: "Old question", body: "Old answer" }] });
  assert.deepEqual(legacy.faq, [{ title: "Old question", body: "Old answer" }]);

  // And a row carrying both wins on the canonical pair.
  const both = parseDetailContent({ faq: [{ question: "Canonical", answer: "A", title: "Stale", body: "B" }] });
  assert.deepEqual(both.faq, [{ title: "Canonical", body: "A" }]);
});

test("saved content reloads into the editor unchanged", () => {
  const content = saved();
  assert.deepEqual(parseDetailContent(serializeDetailContent(content)), content);
});

// ---------------------------------------------------------------------------
// The rendered editor
// ---------------------------------------------------------------------------

test("every button in the editor is type=button", () => {
  // Nothing here may submit. The editor sits on a page that also carries a
  // create-product form, and a control defaulting to type=submit is one
  // refactor away from being inside it.
  for (const content of [EMPTY_DETAIL_CONTENT, saved()]) {
    for (const button of buttons(render(content))) {
      assert.equal(button.type, "button", `"${button.name}" is not type="button"`);
    }
  }
});

test("no button relies on anything but a real button element", () => {
  const html = render(saved());
  // Keyboard activation comes free from <button>; it does not from a div with
  // an onClick, and a tabindex would be a sign someone had reached for one.
  assert.ok(!/tabindex=/i.test(html), "a tabindex in this editor means a control is not a button");
  assert.ok(!/role="button"/.test(html), "a faked button is not keyboard-activatable by default");
  assert.ok(buttons(html).length > 0);
});

test("the five Add buttons are present and distinctly named", () => {
  const html = render(EMPTY_DETAIL_CONTENT);
  const names = buttons(html).map((button) => button.name);

  for (const key of CONTENT_LIST_KEYS) {
    const label = CONTENT_LIST_META[key].addLabel;
    assert.ok(names.includes(label), `missing Add control: ${label}`);
  }
  // The shipped build named both entry lists "Add an entry", so a screen-reader
  // user could not tell the fitment list from the included-items list.
  assert.equal(new Set(names).size, names.length, `duplicate button names: ${names.join(", ")}`);
});

test("every row control names its list and its position", () => {
  const names = buttons(render(saved())).map((button) => button.name);

  for (const key of CONTENT_LIST_KEYS) {
    const noun = CONTENT_LIST_META[key].noun;
    for (const position of [1, 2]) {
      for (const expected of [`Move ${noun} ${position} up`, `Move ${noun} ${position} down`, `Remove ${noun} ${position}`]) {
        assert.ok(names.includes(expected), `missing control: ${expected}`);
      }
    }
  }
  assert.equal(new Set(names).size, names.length, "row controls are not uniquely named");
  // Positions staff see start at 1. The shipped build labelled the first row's
  // up arrow "Move to position 0", a position that does not exist.
  assert.ok(!names.some((name) => /\b0\b/.test(name)), "a control names position 0");
});

test("the empty state renders the Add buttons and no rows", () => {
  const html = render(EMPTY_DETAIL_CONTENT);
  assert.equal(buttons(html).filter((b) => b.name.startsWith("Move ") || b.name.startsWith("Remove ")).length, 0);
  assert.equal(buttons(html).filter((b) => b.name.startsWith("Add ")).length, CONTENT_LIST_KEYS.length);
  assert.ok(!/will not be saved/.test(html), "an empty editor must not warn about anything");
});

test("one pre-existing row renders with its arrows correctly disabled", () => {
  const one = parseDetailContent({ benefits: [{ title: "Solid", body: "Billet" }] });
  const controls = buttons(render(one)).filter((button) => button.name.includes("benefit 1"));

  assert.equal(controls.length, 3, "expected up, down and remove");
  assert.equal(controls.find((c) => c.name.endsWith("up"))?.disabled, true, "the only row cannot move up");
  assert.equal(controls.find((c) => c.name.endsWith("down"))?.disabled, true, "the only row cannot move down");
  assert.equal(controls.find((c) => c.name.startsWith("Remove"))?.disabled, false);
});

test("multiple pre-existing rows render every value in order", () => {
  const html = render(saved());
  const values = inputValues(html);

  for (const expected of [
    "Machined from billet",
    "Weighted",
    "Thread",
    "M10 x 1.25",
    "Material",
    "6061 aluminium",
    "Miata NA",
    "1989-1997",
    "Shift knob",
    "Does it fit a Miata?",
  ]) {
    assert.ok(values.includes(expected), `saved value not rendered: ${expected}`);
  }
  // Bodies and answers are textareas, not inputs.
  for (const expected of ["No cast porosity", "Shorter throws", "Yes"]) {
    assert.ok(textareaValues(html).includes(expected), `saved long text not rendered: ${expected}`);
  }

  assert.equal(values.indexOf("Machined from billet") < values.indexOf("Weighted"), true, "benefit order is wrong");
});

test("a row added through the reducer appears in the rendered editor", () => {
  // The component's Add handler is `onContentChange(addRow(content, key))`.
  // Feeding that result back is what the page does, so this is the click's
  // full effect: an editable row that was not there before.
  const before = render(saved());
  const after = render(addRow(saved(), "benefits"));

  assert.equal(inputValues(before).filter((value) => value === "").length + 1, inputValues(after).filter((value) => value === "").length);
  assert.ok(buttons(after).some((button) => button.name === "Remove benefit 3"), "the third benefit has no controls");
  assert.ok(/will not be saved/.test(after), "the blank row is not explained");
  assert.ok(!/will not be saved/.test(before));
});

test("the disabled editor disables every control, including Add", () => {
  // Staff without `catalog.manage` may read the content and change nothing.
  for (const button of buttons(render(saved(), true))) {
    assert.equal(button.disabled, true, `"${button.name}" is usable without permission`);
  }
});

test("fields stop at the length the parser would truncate at", () => {
  const html = render(saved());
  for (const limit of new Set(Object.values(CONTENT_LIMITS).flatMap((entry) => Object.values(entry)))) {
    assert.ok(html.includes(`maxLength="${limit}"`) || html.includes(`maxlength="${limit}"`), `no field caps at ${limit}`);
  }
});

// ---------------------------------------------------------------------------
// Guards against the shipped defect returning
// ---------------------------------------------------------------------------

test("the editor never re-parses its own state", () => {
  // This is the whole bug in one assertion. `parseDetailContent` drops blank
  // and incomplete rows by design; running it as the editor's reducer deleted
  // every row the Add buttons created, in the same tick.
  const source = code(editorSource);
  assert.ok(!/parseDetailContent\s*\(/.test(source), "the editor is parsing its own state again");
  assert.ok(!/serializeDetailContent\s*\(/.test(source), "normalization belongs at the save boundary");
});

test("every list mutation goes through the pure editing module", () => {
  assert.match(editorSource, /from "@\/lib\/commerce\/productContentEditing"/);
  for (const helper of ["addRow", "removeRow", "moveRow", "updateRow"]) {
    assert.ok(code(editorSource).includes(`${helper}(`), `the editor does not use ${helper}`);
  }
});

test("the editor creates no form of its own", () => {
  // The staff catalog page already has a create-product form. A second form
  // here, or a nested one, would make Enter in a text field submit something.
  assert.ok(!/<form\b/.test(editorSource), "the content editor must not introduce a form");
  const page = readFileSync("src/app/staff/catalog/page.tsx", "utf8");
  const editorPosition = page.indexOf("<ProductContentEditor");
  assert.ok(editorPosition > page.indexOf("</form>"), "the editor is rendered inside the create-product form");
});

test("the editor is a client component and the page owns the content state", () => {
  assert.match(editorSource, /^"use client";/);
  const page = readFileSync("src/app/staff/catalog/page.tsx", "utf8");
  assert.match(page, /^"use client";/);
  // Saving still normalizes exactly once, at the boundary.
  assert.match(page, /detail_content: serializeDetailContent\(content\)/);
  assert.match(page, /parseDetailContent\(savedProduct\.detail_content\)/);
});

test("every change is sent as an updater, not a value", () => {
  // Two activations inside one React batch — a double-click on Add, or two
  // keystrokes in the same tick — both derive from the content captured at
  // render, so the second silently overwrites the first. Measured in a browser
  // against the value form: clicking Add twice quickly produced one row.
  const source = code(editorSource);
  const calls = [...source.matchAll(/onContentChange\(([^)]*)/g)].map(([, argument]) => argument.trim());
  assert.ok(calls.length > 0, "the editor does not report content changes at all");
  for (const argument of calls) {
    assert.ok(argument.startsWith("(current"), `onContentChange(${argument}…) passes a value, not an updater`);
  }
  // The page hands React's own setter straight through, which takes updaters.
  assert.match(readFileSync("src/app/staff/catalog/page.tsx", "utf8"), /onContentChange=\{setContent\}/);
});

test("batched changes compose instead of overwriting", () => {
  // What the updater form guarantees, stated against the reducer the editor
  // hands to React: applying two in sequence yields both rows.
  const updaters = [
    (current: ProductDetailContent) => addRow(current, "benefits"),
    (current: ProductDetailContent) => addRow(current, "benefits"),
  ];
  const settled = updaters.reduce((current, update) => update(current), EMPTY_DETAIL_CONTENT);
  assert.equal(settled.benefits.length, 2, "a double-click must add two rows");
});

test("focus is sent to the field of a newly added row", () => {
  const source = code(editorSource);
  // Add parks the new row's id; the field claims it as it mounts.
  assert.match(source, /pendingFocus\.current = `\$\{key\}-\$\{content\[key\]\.length\}`/);
  assert.match(source, /pendingFocus\.current = null;\s*element\.focus\(\)/);

  // Every list's first field is wired to that same id.
  const wired = [...source.matchAll(/ref=\{focusOnMount\(`([^`]+)`\)\}/g)].map(([, id]) => id);
  for (const key of CONTENT_LIST_KEYS) {
    // The two entry lists share a generated section, so their id is built from
    // the loop variable rather than written out.
    const expected = key === "compatibility" || key === "included" ? "${key}-${index}" : `${key}-\${index}`;
    assert.ok(wired.includes(expected), `${key}: the first field is not focusable after Add`);
  }
});

test("no component is declared inside the editor's render body", () => {
  // A component defined in a render body is a new type every render, so React
  // remounts it and focus is lost the moment a control is used. `ListControls`
  // did exactly that in the shipped build.
  assert.match(editorSource, /^function ListControls\(/m);
  assert.match(editorSource, /^function IncompleteNotice\(/m);
  const body = editorSource.slice(editorSource.indexOf("export default function ProductContentEditor"));
  assert.ok(
    !/const [A-Z]\w* = (\(|function)/.test(body),
    "a capitalized value is being built inside the render body; React reads that as a component type",
  );
});
