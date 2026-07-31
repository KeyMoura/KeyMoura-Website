import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("production auth-debug route is absent", () => {
  assert.equal(existsSync("src/app/debug-user/page.tsx"), false);
});

test("shared product surfaces use deployment identity configuration", () => {
  const clientSurfaces = [
    "src/components/GlobalLockdownGate.tsx",
    "src/components/SiteHeader.tsx",
    "src/app/notifications/page.tsx",
  ];
  const serverSurfaces = [
    "src/app/privacy/page.tsx",
    "src/app/terms/page.tsx",
  ];

  for (const path of clientSurfaces) {
    assert.match(read(path), /useSiteSettings/);
  }
  for (const path of serverSurfaces) {
    assert.match(read(path), /getSiteSettings/);
  }

  const settings = read("src/lib/siteSettings.ts");
  assert.match(settings, /\.from\("site_settings"\)/);
  assert.match(settings, /site_name,description,public_url,logo_url,primary_color,accent_color,terminology/);

  const header = read("src/components/SiteHeader.tsx");
  assert.doesNotMatch(header, /\/brand\/sca-logo(?:-dull)?\.svg/);
});

test("the document exposes a keyboard skip target", () => {
  const layout = read("src/app/layout.tsx");

  assert.match(layout, /href="#main-content"/);
  assert.match(layout, /id="main-content"/);
});
