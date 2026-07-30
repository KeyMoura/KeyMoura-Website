import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("production auth-debug route is absent", () => {
  assert.equal(existsSync("src/app/debug-user/page.tsx"), false);
});

test("shared product surfaces use deployment identity configuration", () => {
  const sharedSurfaces = [
    "src/components/GlobalLockdownGate.tsx",
    "src/components/SiteHeader.tsx",
    "src/app/notifications/page.tsx",
    "src/app/privacy/page.tsx",
    "src/app/terms/page.tsx",
  ];

  for (const path of sharedSurfaces) {
    assert.match(read(path), /siteConfig\.identity/);
  }
});

test("the document exposes a keyboard skip target", () => {
  const layout = read("src/app/layout.tsx");

  assert.match(layout, /href="#main-content"/);
  assert.match(layout, /id="main-content"/);
});
