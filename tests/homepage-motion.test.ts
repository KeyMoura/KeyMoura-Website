import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const css = read("src/app/globals.css");
const layout = read("src/app/layout.tsx");
const reveal = read("src/components/Reveal.tsx");
const home = read("src/app/page.tsx");

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
  assert.match(home, /aria-labelledby="home-capabilities"/);
  assert.match(home, /aria-labelledby="home-process"/);
  assert.match(home, /aria-labelledby="home-cta"/);
  assert.equal((home.match(/<h1/g) ?? []).length, 1, "exactly one h1 on the homepage");
});

test("the homepage does not pull in an animation dependency", () => {
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  for (const banned of ["framer-motion", "gsap", "motion", "react-spring", "aos", "lottie-react"]) {
    assert.ok(!(banned in pkg.dependencies), `unexpected animation dependency: ${banned}`);
  }
});
