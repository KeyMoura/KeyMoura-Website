import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

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

test("appearance has a dedicated classic navbar editor and expanded controls", () => {
  const appearance = read("src/app/staff/appearance/page.tsx");
  const runtime = read("src/theme/runtime.ts");
  const pdf = read("src/app/api/info/pdf/[slug]/route.ts");

  // The navbar's shape controls stayed on the page; its colours moved into the
  // token map, where each one also says what it changes. Asserting both halves
  // is stronger than the old check, which only proved a label existed in JSX.
  const map = read("src/theme/appearanceMap.ts");
  for (const label of ["Navigation bar", "Scroll behavior", "Surface shadows", "Border contrast"]) {
    assert.match(appearance, new RegExp(label));
  }
  for (const label of ["Navbar background", "Current page link", "Navbar link text"]) {
    assert.match(map, new RegExp(label));
  }
  assert.match(appearance, /publicNavigationStyle/, "the classic navbar choice is still editable");
  assert.match(runtime, /publicNavigationStyle: "classic"/);
  assert.doesNotMatch(pdf, /schassis\.info/i);
  assert.match(pdf, /keymoura\.com\/projects/);
});
