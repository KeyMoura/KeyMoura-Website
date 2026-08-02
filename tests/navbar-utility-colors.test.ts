import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const UTILITY_FIELDS = [
  "navigationUtilityBackground",
  "navigationUtilityBorder",
  "navigationUtilityText",
  "navigationUtilityHoverBackground",
  "navigationUtilityHoverBorder",
  "navigationUtilityHoverText",
] as const;

const UTILITY_CSS_VARS = [
  "--km-nav-util-bg",
  "--km-nav-util-border",
  "--km-nav-util-text",
  "--km-nav-util-hover-bg",
  "--km-nav-util-hover-border",
  "--km-nav-util-hover-text",
] as const;

test("Appearance exposes a dedicated navbar utility controls subsection", () => {
  const page = read("src/app/staff/appearance/page.tsx");

  assert.match(page, /Navbar utility controls/);
  for (const field of UTILITY_FIELDS) {
    assert.match(page, new RegExp(`form\\.theme\\.${field}`));
    assert.match(page, new RegExp(`setTheme\\("${field}"`));
  }

  // The section's "Reset this section" action must also revert the new fields.
  const resetBlock = page.match(/if \(section === "navigation"\) \{[\s\S]*?\}\r?\n\s*const keys:/)?.[0] ?? page;
  for (const field of UTILITY_FIELDS) {
    assert.match(resetBlock, new RegExp(field));
  }

  // The live-preview CSS variable map must include the new tokens.
  for (const cssVar of UTILITY_CSS_VARS) {
    assert.match(page, new RegExp(cssVar.replace(/-/g, "\\-")));
  }

  // The navbar preview panel should render the utility cluster too.
  assert.match(page, /site-nav-utility/);
});

test("the root layout wires the navbar utility CSS variables from the saved theme", () => {
  const layout = read("src/app/layout.tsx");
  for (const cssVar of UTILITY_CSS_VARS) {
    assert.match(layout, new RegExp(cssVar.replace(/-/g, "\\-")));
  }
  for (const field of UTILITY_FIELDS) {
    assert.match(layout, new RegExp(`settings\\.theme\\.${field}`));
  }
});

test("navbar utility controls in globals.css read the dedicated tokens, not the shared navbar palette", () => {
  const css = read("src/app/globals.css");

  const utilityBlock = css.match(/\.site-header-shell \.site-nav-utility \{[\s\S]*?\.site-nav-utility-badge[\s\S]*?\}\r?\n/)?.[0];
  assert.ok(utilityBlock, "expected a .site-nav-utility rule block in globals.css");

  assert.match(utilityBlock!, /var\(--km-nav-util-bg/);
  assert.match(utilityBlock!, /var\(--km-nav-util-border/);
  assert.match(utilityBlock!, /var\(--km-nav-util-text/);
  assert.match(utilityBlock!, /var\(--km-nav-util-hover-bg/);
  assert.match(utilityBlock!, /var\(--km-nav-util-hover-border/);
  assert.match(utilityBlock!, /var\(--km-nav-util-hover-text/);

  // The dedicated rule must not fall back to the shared navbar text/active tokens.
  assert.doesNotMatch(utilityBlock!, /--km-nav-text/);
  assert.doesNotMatch(utilityBlock!, /--km-nav-active/);
});

test("SiteHeader applies the dedicated navbar utility class to search, messages, notifications, account, and staff", () => {
  const header = read("src/components/SiteHeader.tsx");

  assert.match(header, /const bellClass = `\$\{desktopPillBase\} justify-center w-9 px-0 site-nav-utility/);
  assert.match(header, /const pillClass = `\$\{desktopPillBase\} justify-center w-9 px-0 site-nav-utility/);
  assert.match(header, /const accountPillClass = `\$\{desktopPillBase\} site-nav-utility/);
  assert.match(header, /const mobileAccountPillClass = `\$\{mobilePillBase\} site-nav-utility`/);
  assert.match(header, /site-nav-utility-badge/);

  // Search buttons (desktop + mobile) carry the dedicated class.
  assert.match(header, /\$\{desktopPillBase\} max-w-full justify-center site-nav-utility`/);
  assert.match(header, /className="site-nav-utility inline-flex h-9 items-center justify-center rounded-md border/);

  // Staff pill's non-database fallback now derives from the navbar utility theme fields.
  assert.match(header, /siteSettings\.theme\.navigationUtilityBorder/);
  assert.match(header, /siteSettings\.theme\.navigationUtilityBackground/);
  assert.match(header, /siteSettings\.theme\.navigationUtilityText/);
});

test("navbar utility controls no longer derive their color from the shared secondary/accent token", () => {
  const header = read("src/components/SiteHeader.tsx");

  const bellClassBlock = header.match(/const bellClass = `[\s\S]*?`;/)?.[0] ?? "";
  const pillClassBlock = header.match(/const pillClass = `[\s\S]*?`;/)?.[0] ?? "";
  const accountPillBlock = header.match(/const accountPillClass = `[\s\S]*?`;/)?.[0] ?? "";
  const mobileAccountPillBlock = header.match(/const mobileAccountPillClass = `[\s\S]*?`;/)?.[0] ?? "";
  const desktopSearchBlock = header.match(/\$\{desktopPillBase\} max-w-full justify-center site-nav-utility`/)?.[0] ?? "";
  const mobileSearchBlock = header.match(/className="site-nav-utility inline-flex h-9 items-center justify-center rounded-md border[^"]*"/)?.[0] ?? "";
  const badgeBlocks = header.match(/site-nav-utility-badge absolute[^"]*"/g) ?? [];
  const iconBlocks = header.match(/className="text-\[14px\]"/g) ?? [];

  const accentTokens = /brand-accent|amber-200|amber-300|amber-400|theme-accent-glow/;

  for (const block of [bellClassBlock, pillClassBlock, accountPillBlock, mobileAccountPillBlock, desktopSearchBlock, mobileSearchBlock, ...badgeBlocks]) {
    assert.doesNotMatch(block, accentTokens);
  }
  assert.equal(iconBlocks.length, 2, "expected both bell icons to drop their unread-driven accent color class");

  // The staff pill's fallback palette must not be the old hardcoded brand-flavored literal.
  assert.doesNotMatch(header, /border: dbBorder \?\? "#fbbf24"/);
  assert.doesNotMatch(header, /return \{ border: "#fbbf24", bg: "rgba\(0,0,0,0\.35\)", text: "#ffffff" \}/);
});
