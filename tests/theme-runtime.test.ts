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

test("appearance controls the shared site shell and component families", () => {
  const theme = normalizeSiteTheme({
    primaryButtonStyle: "framed",
    secondaryButtonStyle: "framed",
    tabStyle: "underline",
    cardStyle: "outline",
    inputStyle: "soft",
    navigationStyle: "minimal",
    backgroundStyle: "solid",
    contentWidth: "wide",
  });

  assert.equal(theme.primaryButtonStyle, "framed");
  assert.equal(theme.secondaryButtonStyle, "framed");
  assert.equal(theme.tabStyle, "underline");
  assert.equal(theme.cardStyle, "outline");
  assert.equal(theme.inputStyle, "soft");
  assert.equal(theme.navigationStyle, "minimal");
  assert.equal(theme.backgroundStyle, "solid");
  assert.equal(theme.contentWidth, "wide");

  const layout = readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
  for (const attribute of ["data-tab-style", "data-card-style", "data-input-style", "data-navigation-style", "data-background-style", "data-content-width"]) {
    assert.match(layout, new RegExp(attribute));
  }
});

test("public navbar and expanded surface choices normalize independently", () => {
  const theme = normalizeSiteTheme({
    publicNavigationStyle: "framed",
    navigationBehavior: "sticky",
    navigationDensity: "comfortable",
    navigationBackground: "#101010",
    navigationText: "#eeeeee",
    navigationActiveText: "#ffbb22",
    navigationBorder: "#343434",
    cardStyle: "elevated",
    inputStyle: "filled",
    backgroundStyle: "spotlight",
    contentWidth: "full",
    shadowStyle: "glow",
    borderStrength: "strong",
  });

  assert.equal(theme.publicNavigationStyle, "framed");
  assert.equal(theme.navigationBehavior, "sticky");
  assert.equal(theme.navigationDensity, "comfortable");
  assert.equal(theme.navigationBackground, "#101010");
  assert.equal(theme.navigationActiveText, "#ffbb22");
  assert.equal(theme.cardStyle, "elevated");
  assert.equal(theme.inputStyle, "filled");
  assert.equal(theme.backgroundStyle, "spotlight");
  assert.equal(theme.contentWidth, "full");
  assert.equal(theme.shadowStyle, "glow");
  assert.equal(theme.borderStrength, "strong");

  assert.equal(normalizeSiteTheme({}).publicNavigationStyle, "underline");
});

/**
 * Retiring the pill styles is what changes a live site, and this is the
 * mechanism.
 *
 * `classic` and `soft` both drew a filled lozenge behind the current link.
 * Removing them from the union means `oneOf` no longer recognises them, so a
 * site whose `theme_config` still says `"classic"` normalizes to the default —
 * and renders as `underline` from the next deploy without anybody writing to the
 * database. The stored string is left exactly where it is.
 *
 * Pinned because it is easy to read the removal as cosmetic and "helpfully"
 * re-add the old values to a list later, which would silently restore the pill
 * on every site that never republished.
 */
test("a site still storing a retired navbar style renders as the underline default", () => {
  for (const retired of ["classic", "soft"]) {
    assert.equal(
      normalizeSiteTheme({ publicNavigationStyle: retired }).publicNavigationStyle,
      "underline",
      `${retired} drew a pill and must not survive normalization`
    );
  }
  // The three that remain are still honoured.
  for (const live of ["underline", "framed", "minimal"]) {
    assert.equal(normalizeSiteTheme({ publicNavigationStyle: live }).publicNavigationStyle, live);
  }
});

test("navbar utility control colors normalize independently of the shared navbar palette", () => {
  const theme = normalizeSiteTheme({
    navigationBackground: "#101010",
    navigationUtilityBackground: "#202020",
    navigationUtilityBorder: "#303030",
    navigationUtilityText: "#e0e0e0",
    navigationUtilityHoverBackground: "#404040",
    navigationUtilityHoverBorder: "#505050",
    navigationUtilityHoverText: "#f0f0f0",
  });

  assert.equal(theme.navigationBackground, "#101010");
  assert.equal(theme.navigationUtilityBackground, "#202020");
  assert.equal(theme.navigationUtilityBorder, "#303030");
  assert.equal(theme.navigationUtilityText, "#e0e0e0");
  assert.equal(theme.navigationUtilityHoverBackground, "#404040");
  assert.equal(theme.navigationUtilityHoverBorder, "#505050");
  assert.equal(theme.navigationUtilityHoverText, "#f0f0f0");
});

test("missing saved navbar utility values normalize to their neutral defaults", () => {
  const theme = normalizeSiteTheme({});
  assert.equal(theme.navigationUtilityBackground, defaultSiteTheme.navigationUtilityBackground);
  assert.equal(theme.navigationUtilityBorder, defaultSiteTheme.navigationUtilityBorder);
  assert.equal(theme.navigationUtilityText, defaultSiteTheme.navigationUtilityText);
  assert.equal(theme.navigationUtilityHoverBackground, defaultSiteTheme.navigationUtilityHoverBackground);
  assert.equal(theme.navigationUtilityHoverBorder, defaultSiteTheme.navigationUtilityHoverBorder);
  assert.equal(theme.navigationUtilityHoverText, defaultSiteTheme.navigationUtilityHoverText);

  // A pre-existing saved theme_config from before these fields existed (only unrelated
  // keys set) must still normalize cleanly to the same neutral defaults.
  const legacy = normalizeSiteTheme({ radius: "pill", navigationBackground: "#111111" });
  assert.equal(legacy.navigationUtilityBackground, defaultSiteTheme.navigationUtilityBackground);
  assert.equal(legacy.navigationUtilityBorder, defaultSiteTheme.navigationUtilityBorder);
  assert.equal(legacy.navigationUtilityText, defaultSiteTheme.navigationUtilityText);
});
