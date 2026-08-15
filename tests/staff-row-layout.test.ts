import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * The staff list-row layout contract.
 *
 * ## The bug this file exists to prevent
 *
 * `.staff-row` was a two-track grid with no named areas, and every list passed
 * it exactly two children — `staff-row-main` and `staff-row-aside` — until
 * `/staff/catalog` passed three by adding a thumbnail. Grid auto-placement then
 * did the only thing it could: the 48px image took the `1fr` track, the product
 * name was squeezed into the `auto` track at the far right, and the badges
 * wrapped onto a second grid line underneath. Measured in the browser at a
 * 900px container the tracks resolved to `740px 110px`.
 *
 * Nothing was misspelled and nothing threw. The row simply had more content
 * than its template described, which is a failure mode that only named areas
 * remove — so these tests assert the areas exist and cover every combination of
 * optional slot, rather than asserting pixel positions that a font change would
 * break.
 */

const globalsCss = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
const staffCatalog = readFileSync(new URL("../src/app/staff/catalog/page.tsx", import.meta.url), "utf8");

/** Every `grid-template-areas` value declared for a `.staff-row` variant. */
function rowTemplates(): { selector: string; areas: string }[] {
  const stripped = globalsCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selector: string; areas: string }[] = [];
  const re = /(\.staff-row(?::has\([^)]*\))*)\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped))) {
    const areas = /grid-template-areas:\s*([^;]+);/.exec(match[2]);
    if (areas) out.push({ selector: match[1], areas: areas[1].replace(/\s+/g, " ").trim() });
  }
  return out;
}

test("the row declares named areas rather than relying on auto-placement", () => {
  const templates = rowTemplates();
  assert.ok(templates.length >= 4, `expected a template per slot combination, saw ${templates.length}`);
  for (const { selector, areas } of templates) {
    assert.match(areas, /"[^"]*main[^"]*"/, `${selector} must place the identity slot`);
    assert.match(areas, /"[^"]*aside[^"]*"/, `${selector} must place the status slot`);
  }
});

test("every optional slot has a template that names it", () => {
  /*
   * The rule that was broken twice: a `grid-area` naming an area the active
   * template does not declare does not degrade — it creates an implicit track
   * and drifts to a corner. Adding the price slot reproduced the original bug
   * in the stacked layout until every combination was spelled out.
   */
  const templates = rowTemplates();
  const withMedia = templates.filter((entry) => entry.selector.includes("staff-row-media"));
  const withFigure = templates.filter((entry) => entry.selector.includes("staff-row-figure"));
  const withBoth = templates.filter(
    (entry) => entry.selector.includes("staff-row-media") && entry.selector.includes("staff-row-figure")
  );

  assert.ok(withMedia.length > 0, "a row carrying a thumbnail needs its own template");
  assert.ok(withFigure.length > 0, "a row carrying a figure needs its own template");
  assert.ok(withBoth.length > 0, "a row carrying both needs its own template — this is the combination that broke");

  for (const { selector, areas } of withMedia) {
    assert.match(areas, /media/, `${selector} claims a thumbnail but never places it`);
  }
  for (const { selector, areas } of withFigure) {
    assert.match(areas, /figure/, `${selector} claims a figure but never places it`);
  }
});

test("the row switches on its container, not the viewport", () => {
  /*
   * The catalog list renders in a 380px editor column at `xl` and full width
   * below it, so viewport width has never been the question worth asking — the
   * same lesson `.staff-people` already records. A media query here puts a
   * four-column row inside a 380px box.
   */
  assert.match(globalsCss, /\.staff-rows\s*\{[^}]*container:\s*staff-rows\s*\/\s*inline-size/, "the list must be a container");
  assert.match(globalsCss, /@container staff-rows \(min-width:/, "the row must query its own container");

  const stripped = globalsCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const mediaBlocks = stripped.match(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g) ?? [];
  for (const block of mediaBlocks) {
    assert.doesNotMatch(
      block,
      /\.staff-row\s*\{[^}]*grid-template-columns/,
      "the row's column layout must not be driven by a viewport media query"
    );
  }
});

test("the staff catalog row fills the slots the layout declares", () => {
  assert.match(staffCatalog, /className="staff-row-media"/, "the thumbnail must use the shared media slot");
  assert.match(staffCatalog, /className="staff-row-main"/);
  assert.match(staffCatalog, /className="staff-row-figure"/, "price belongs in the aligned figure slot");
  assert.match(staffCatalog, /className="staff-row-aside"/);

  // The bare utility thumbnail is what bypassed the row system in the first
  // place: it was a grid child the template knew nothing about.
  assert.doesNotMatch(
    staffCatalog,
    /<span className="relative h-12 w-12 shrink-0/,
    "the thumbnail must not go back to being an unslotted grid child"
  );
});

test("badges stay in the status slot rather than floating in the identity column", () => {
  // Both stock and status badges live inside `staff-row-aside`, so they wrap as
  // one group. A badge emitted as a direct child of the row would be
  // auto-placed again, which is precisely the "detached pill" report.
  const asideBlock = /<span className="staff-row-aside">([\s\S]*?)<\/span>\s*<\/button>/.exec(staffCatalog);
  assert.ok(asideBlock, "the catalog row must keep a status slot");
  assert.match(asideBlock![1], /left<\/Badge>|\{product\.inventory_quantity\} left/, "the stock pill belongs with the status pill");
  assert.match(asideBlock![1], /Active/, "the active pill belongs in the status slot");
});

test("the thumbnail has one size, so images line up down the list", () => {
  const media = /\.staff-row-media\s*\{([^}]*)\}/.exec(globalsCss.replace(/\/\*[\s\S]*?\*\//g, ""));
  assert.ok(media, "the media slot needs a rule of its own");
  assert.match(media![1], /width:\s*3rem/);
  assert.match(media![1], /height:\s*3rem/);
});
