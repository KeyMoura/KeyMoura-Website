import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const css = read("src/app/globals.css");
const layout = read("src/app/layout.tsx");
const reveal = read("src/components/Reveal.tsx");
const home = read("src/app/page.tsx");
const sections = read("src/components/home/HomeSections.tsx");

test("reveals are hidden only when motion is explicitly enabled", () => {
  // The hidden state must be scoped, so content stays visible without
  // scripting, after a failed hydration, and under reduced motion.
  assert.match(css, /\[data-motion="on"\]\s+\.reveal\s*\{/);
  assert.ok(!/^\s*\.reveal\s*\{[^}]*opacity:\s*0/m.test(css), "unscoped .reveal must not hide content");
  assert.ok(
    !/^\s*\.reveal-stagger\s*>\s*\*\s*\{[^}]*opacity:\s*0/m.test(css),
    "unscoped .reveal-stagger must not hide content"
  );
});

test("the motion flag is set before paint and respects reduced motion", () => {
  assert.match(layout, /prefers-reduced-motion: reduce/);
  assert.match(layout, /document\.documentElement\.dataset\.motion='on'/);
  assert.match(layout, /try\{/, "the pre-paint script must not throw into the page");
});

test("reduced motion still neutralizes transitions globally", () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /transition-duration:\s*0\.01ms\s*!important/);
});

test("reveals share one IntersectionObserver and unobserve once shown", () => {
  assert.match(reveal, /let observer: IntersectionObserver \| null = null;/);
  assert.match(reveal, /observer\?\.unobserve\(entry\.target\)/);
  assert.equal((reveal.match(/new IntersectionObserver/g) ?? []).length, 1);
});

test("reveals degrade to visible when IntersectionObserver is unavailable", () => {
  assert.match(reveal, /if \(typeof IntersectionObserver === "undefined"\) return null;/);
  assert.match(reveal, /node\.dataset\.revealed = "true";/);
});

test("homepage sections keep accessible headings and landmarks", () => {
  // The sections moved out of the route in Homepage 3.0. `homepage-3.test.ts`
  // checks the outline against rendered markup, which is stronger than this;
  // what stays here is the landmark contract itself, so a section cannot lose
  // its label without something failing.
  const hero = read("src/components/home/HomeHero.tsx");
  for (const id of ["home-what", "home-process", "home-custom", "home-close"]) {
    assert.match(sections, new RegExp(`aria-labelledby="${id}"`), `no landmark label for ${id}`);
  }
  assert.match(hero, /aria-labelledby="home-hero-title"/);
  assert.equal((hero.match(/<h1/g) ?? []).length, 1, "the hero carries the only h1");
  assert.equal((sections.match(/<h1/g) ?? []).length, 0, "no section may add a second h1");
  assert.equal((home.match(/<h1/g) ?? []).length, 0, "the route composes sections rather than markup");
});

test("the homepage does not pull in an animation dependency", () => {
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  for (const banned of ["framer-motion", "gsap", "motion", "react-spring", "aos", "lottie-react"]) {
    assert.ok(!(banned in pkg.dependencies), `unexpected animation dependency: ${banned}`);
  }
});
