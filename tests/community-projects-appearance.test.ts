import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { sectionForTask } from "../src/theme/appearanceSections.ts";

const read = (path: string) => readFileSync(path, "utf8");

test("projects is the canonical public route while info remains compatible", () => {
  for (const path of [
    "src/app/projects/page.tsx",
    "src/app/projects/[slug]/page.tsx",
    "src/app/projects/[slug]/update/page.tsx",
    "src/app/projects/category/[slug]/page.tsx",
    "src/app/projects/submit/page.tsx",
    "src/app/projects/mine/page.tsx",
  ]) assert.equal(existsSync(path), true, `${path} is missing`);

  const publicSources = [read("src/components/SiteHeader.tsx"), read("src/app/projects/ProjectsIndexClient.tsx"), read("src/components/info/InfoCard.tsx")].join("\n");
  assert.match(publicSources, /\/projects/);
  assert.doesNotMatch(publicSources, /href=[^\n]*\/info/);
});

test("community and projects share the customer content design system", () => {
  const community = read("src/app/community/page.tsx");
  const projects = read("src/app/projects/ProjectsIndexClient.tsx");
  for (const source of [community, projects]) {
    assert.match(source, /content-hub/);
    assert.match(source, /content-hero/);
    assert.match(source, /content-search/);
    assert.match(source, /content-grid-card/);
  }
});

test("appearance has a dedicated navbar editor and expanded controls", () => {
  const runtime = read("src/theme/runtime.ts");
  const pdf = read("src/app/api/info/pdf/[slug]/route.ts");

  /*
   * The navbar's shape controls and its colours are now in the same section.
   * They used to be a section apart — shape under "Shapes & density", colour
   * under "Colours" — which is why "make the header darker" meant visiting two
   * places. `ColorSection`'s `only` prop is the split, and it is a filter over
   * one list, so each colour still has exactly one control.
   */
  const map = read("src/theme/appearanceMap.ts");
  const panels = read("src/app/staff/appearance/panels.tsx");
  for (const label of ["Shape and behaviour", "When scrolling", "Surface shadows", "Border contrast"]) {
    assert.match(panels, new RegExp(label));
  }
  for (const label of ["Navbar background", "Current page link", "Navbar link text"]) {
    assert.match(map, new RegExp(label));
  }
  assert.match(panels, /publicNavigationStyle/, "the navbar treatment is still editable");
  /*
   * The navbar's colours live in the Navigation workspace beside its shape, and
   * 5.0 brought the five hover/utility/menu tasks in with them — they were
   * filed under a collapsed "Advanced" disclosure by rarity, which is what made
   * "what is the difference between rest, hover and current page" unanswerable
   * without knowing where to look.
   */
  assert.match(panels, /function NavigationPanel/);
  assert.match(panels, /Link states/, "rest, hover and current page are shown together");
  for (const id of ["navbar", "navbar-active", "advanced-navbar-hover", "advanced-count-badge"]) {
    assert.equal(sectionForTask(id), "navigation", `${id} belongs in Navigation`);
  }
  assert.match(runtime, /publicNavigationStyle: "underline"/);
  assert.doesNotMatch(pdf, /schassis\.info/i);
  assert.match(pdf, /keymoura\.com\/projects/);
});
