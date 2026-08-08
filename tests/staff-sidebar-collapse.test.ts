import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * The collapsed staff sidebar.
 *
 * Collapsing hid the labels and left the sidebar 280px wide. The state lived on
 * the `<nav>`; the width is set by `grid-template-columns` on `.staff-shell`,
 * two levels above it. Every compact rule applied inside a box an ancestor had
 * already sized, so no amount of work on the link styles could have fixed it.
 *
 * These assert the structural rule rather than a rendered pixel width, because
 * the defect *was* structural: the attribute and the column have to live on the
 * same element. A browser check confirms the resulting widths; this is what
 * stops them drifting apart again.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const css = read("src/app/globals.css");
const shell = read("src/components/staff/StaffShell.tsx");
const nav = read("src/components/staff/StaffNav.tsx");
const layout = read("src/app/staff/layout.tsx");

test("the element that carries the compact flag is the element that sets the columns", () => {
  // This is the whole bug in one assertion.
  assert.match(shell, /className="staff-shell" data-compact=/, "the flag must be on .staff-shell itself");
  assert.match(css, /\.staff-shell\[data-compact="true"\]\s*\{[^}]*grid-template-columns/);
});

test("collapsed is a narrow rail, expanded is a normal sidebar", () => {
  const expanded = css.match(/\.staff-shell\s*\{[\s\S]{0,400}?grid-template-columns:\s*280px[^;]*;/);
  assert.ok(expanded, "the expanded sidebar stays 280px");

  const collapsed = css.match(/\.staff-shell\[data-compact="true"\]\s*\{([^}]*)\}/)?.[1] ?? "";
  const width = collapsed.match(/grid-template-columns:\s*([\d.]+)rem/)?.[1];
  assert.ok(width, "the collapsed column must be a fixed rail width");
  const px = Number(width) * 16;
  assert.ok(px >= 64 && px <= 80, `a compact rail should be 64–80px; got ${px}px`);
});

test("the content column can actually take the width the rail gives up", () => {
  // A bare `1fr` has an automatic min-content floor, so a wide table or a long
  // word inside the content column would stop it shrinking — and stop it
  // growing back. `minmax(0, 1fr)` is what makes the 208px real.
  // Only the two-track declarations: `.staff-shell { grid-template-columns: 1fr }`
  // is the single-column phone layout, which has no sidebar to give width up.
  const twoTrack = (css.match(/grid-template-columns:\s*(?:280px|4\.5rem)[^;]*;/g) ?? []);
  assert.equal(twoTrack.length, 2, "the expanded and collapsed columns should both be declared");
  for (const rule of twoTrack) {
    assert.match(rule, /minmax\(0,\s*1fr\)/, `a bare 1fr would absorb the gain: ${rule}`);
  }
});

test("the rail's own box shrinks, not only its contents", () => {
  // Centring icons inside a 280px panel is what the previous version did.
  assert.match(css, /\.staff-nav\[data-compact="true"\]\s*\{[^}]*padding:\s*0\.5rem/);
  assert.match(css, /\.staff-nav\[data-compact="true"\] \.staff-nav-link\s*\{[^}]*justify-content:\s*center/);
});

test("labels leave the layout rather than becoming invisible", () => {
  // `sr-only` is position:absolute, so it reserves no width while staying the
  // link's accessible name. Opacity or visibility would keep the column wide.
  assert.match(nav, /isCompact \? "sr-only" : "staff-nav-link-label"/);
  assert.doesNotMatch(css, /\.staff-nav\[data-compact="true"\][^{]*\{[^}]*opacity:\s*0\b/);
});

test("group separators fit the narrow rail", () => {
  const compactGroup = css.match(/\.staff-nav\[data-compact="true"\] \.staff-nav-group \+ \.staff-nav-group\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(compactGroup, /border-top/, "groups still need a visible boundary when headings are hidden");
  // The head's rule under a single centred button was a divider with nothing
  // above it.
  const compactHead = css.match(/\.staff-nav\[data-compact="true"\] \.staff-nav-head\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(compactHead, /border-bottom:\s*0/);
});

test("the collapsed rail is labelled for the keyboard, not only the pointer", () => {
  // No browser raises a `title` tooltip on focus, so the previous rail was
  // unlabelled for anyone tabbing it.
  assert.match(nav, /className="staff-nav-tip"/);
  assert.match(css, /\.staff-nav-link:focus-visible \.staff-nav-tip/);
  assert.match(css, /\.staff-nav-link:hover \.staff-nav-tip/);
  // The tooltip duplicates the sr-only name, so it must not be announced twice.
  assert.match(nav, /className="staff-nav-tip" aria-hidden="true"/);
  assert.doesNotMatch(nav, /title=\{isCompact \? item\.label/, "title is not a keyboard-reachable tooltip");
});

test("the active item stays visible when collapsed", () => {
  assert.match(nav, /aria-current=\{active \? "page" : undefined\}/);
  assert.match(css, /\.staff-nav-link\[aria-current="page"\]\s*\{[^}]*background/);
});

test("the collapse button remains reachable and states its state", () => {
  assert.match(nav, /aria-pressed=\{isCompact\}/);
  assert.match(nav, /onClick=\{onToggleCompact\}/);
  assert.match(nav, /Expand the sidebar/);
  assert.match(nav, /Collapse the sidebar/);
});

test("mobile stays a drawer and never inherits the desktop rail preference", () => {
  // The rail is display:none below lg and only becomes a grid column at lg, so
  // a compact preference set on a desktop cannot reach a phone.
  assert.match(css, /\.staff-shell-rail \{ display: none; \}/);
  assert.match(css, /@media \(min-width: 1024px\) \{ \.staff-shell-rail \{ display: block/);
  assert.match(shell, /lg:hidden[\s\S]{0,120}<StaffMobileNav \/>/);
  // Compact only applies to the sidebar variant, never the drawer's copy.
  assert.match(nav, /variant === "sidebar" && compact/);
});

test("one component owns the preference", () => {
  // Two subscriptions to the same key can disagree for a frame, and the one
  // that mattered could not act on it.
  assert.match(shell, /useStoredPreference/, "the shell reads the preference");
  assert.doesNotMatch(nav, /km\.staffNav\.compact/, "the sidebar must not read it a second time");
  assert.match(nav, /compact = false,/, "the sidebar is controlled");
});

test("the preference is served through the hydration-safe store", () => {
  // Reading localStorage during render is a hydration mismatch; writing it from
  // an effect is a cascading render on every mount. `useStoredPreference`
  // serves the default during SSR and swaps afterwards.
  assert.match(shell, /useStoredPreference\("km\.staffNav\.compact"|useStoredPreference\(\s*COMPACT_KEY/);
  assert.doesNotMatch(shell, /localStorage/, "the shell must not touch storage directly");
});

test("the layout stays a server component and delegates the client boundary", () => {
  assert.doesNotMatch(layout, /"use client"/, "the staff layout should not become a client component");
  assert.match(layout, /<StaffShell>/);
  assert.match(shell, /^"use client";/);
});
