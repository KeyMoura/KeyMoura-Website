import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { defaultSiteTheme, normalizeSiteTheme } from "../src/theme/runtime.ts";

test("appearance normalizes every configurable color and button role", () => {
  const theme = normalizeSiteTheme({
    headingText: "#112233",
    linkText: "#223344",
    primaryButtonText: "#334455",
    secondaryButtonText: "#445566",
    primaryButtonStyle: "soft",
    secondaryButtonStyle: "ghost",
  });

  assert.equal(theme.headingText, "#112233");
  assert.equal(theme.linkText, "#223344");
  assert.equal(theme.primaryButtonText, "#334455");
  assert.equal(theme.secondaryButtonText, "#445566");
  assert.equal(theme.primaryButtonStyle, "soft");
  assert.equal(theme.secondaryButtonStyle, "ghost");
});

test("appearance preserves the previous primary buttonStyle setting", () => {
  const theme = normalizeSiteTheme({ buttonStyle: "outline" });

  assert.equal(theme.primaryButtonStyle, "outline");
  assert.equal(theme.secondaryButtonStyle, defaultSiteTheme.secondaryButtonStyle);
});

test("appearance variables are scoped where theme aliases can resolve them", () => {
  const layout = readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
  const appearance = readFileSync(new URL("../src/app/staff/appearance/page.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

  assert.match(layout, /<html[^>]+style=\{brandStyles\}/);
  assert.doesNotMatch(layout, /<body[^>]+style=\{brandStyles\}/);
  assert.match(appearance, /data-theme-scope="true"/);
  assert.match(css, /\[data-theme-scope="true"\]/);
});

test("legacy amber and yellow Tailwind utilities inherit the live accent palette", () => {
  const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

  assert.match(css, /--color-amber-400:\s*var\(--brand-accent\)/);
  assert.match(css, /--color-amber-500:\s*var\(--brand-accent\)/);
  assert.match(css, /--color-yellow-400:\s*var\(--color-amber-400\)/);
  assert.match(css, /--color-yellow-500:\s*var\(--color-amber-500\)/);
});
