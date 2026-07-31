import test from "node:test";
import assert from "node:assert/strict";

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
