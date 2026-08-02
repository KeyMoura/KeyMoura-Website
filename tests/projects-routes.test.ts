import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const exists = (path: string) => existsSync(new URL(`../${path}`, import.meta.url));

const CANONICAL = [
  "src/app/projects/page.tsx",
  "src/app/projects/mine/page.tsx",
  "src/app/projects/submit/page.tsx",
  "src/app/projects/[slug]/page.tsx",
  "src/app/projects/[slug]/update/page.tsx",
  "src/app/projects/category/[slug]/page.tsx",
];

const LEGACY = [
  ["src/app/info/page.tsx", '"/projects"'],
  ["src/app/info/mine/page.tsx", '"/projects/mine"'],
  ["src/app/info/submit/page.tsx", '"/projects/submit"'],
  ["src/app/info/[slug]/page.tsx", "`/projects/${encodeURIComponent(slug)}`"],
  ["src/app/info/[slug]/update/page.tsx", "`/projects/${encodeURIComponent(slug)}/update`"],
  ["src/app/info/category/[slug]/page.tsx", "`/projects/category/${encodeURIComponent(slug)}`"],
] as const;

test("Projects lives at /projects, not behind a re-export of /info", () => {
  for (const path of CANONICAL) {
    assert.ok(exists(path), `missing canonical route: ${path}`);
    const source = read(path);
    assert.ok(!/export \{ default \} from/.test(source), `${path} should hold the implementation, not re-export it`);
  }
  assert.ok(exists("src/app/projects/ProjectsIndexClient.tsx"));
  assert.ok(!exists("src/app/info/InfoIndexClient.tsx"), "the client moved with its route");
});

test("every legacy /info page permanently redirects to its /projects equivalent", () => {
  for (const [path, target] of LEGACY) {
    assert.ok(exists(path), `missing legacy alias: ${path}`);
    const source = read(path);
    assert.match(source, /permanentRedirect\(/, `${path} must redirect`);
    assert.ok(source.includes(target), `${path} must redirect to ${target}`);
    // A redirect shim renders nothing; it must not carry a second copy of the page.
    assert.ok(source.length < 900, `${path} looks like more than a redirect shim`);
  }
});

test("dynamic legacy slugs are encoded before being put in the redirect URL", () => {
  for (const [path] of LEGACY.filter(([p]) => p.includes("[slug]"))) {
    assert.match(read(path), /encodeURIComponent\(slug\)/, `${path} must encode the slug`);
  }
});

test("the /api/info handlers stay put for existing API consumers", () => {
  for (const route of [
    "src/app/api/info/submit/route.ts",
    "src/app/api/info/updates/submit/route.ts",
    "src/app/api/info/pdf/[slug]/route.ts",
  ]) {
    assert.ok(exists(route), `API backward compatibility removed: ${route}`);
  }
});

test("nothing in the app links to the legacy /info page prefix", () => {
  const palette = read("src/components/CommandPalette.tsx");
  const header = read("src/components/SiteHeader.tsx");
  const footer = read("src/components/SiteFooter.tsx");
  for (const [name, source] of [["palette", palette], ["header", header], ["footer", footer]] as const) {
    assert.ok(!/href="\/info/.test(source), `${name} still links to /info`);
    assert.ok(!/push\("\/info/.test(source), `${name} still navigates to /info`);
  }
});

test("Projects pages declare their own metadata", () => {
  const index = read("src/app/projects/page.tsx");
  assert.match(index, /export const metadata/);
  assert.match(index, /canonical: "\/projects"/);
});
