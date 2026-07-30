/* eslint-disable @typescript-eslint/no-require-imports */
const { test, expect } = require("@playwright/test");

const states = ["logged-out", "normal-user", "staff-user"];
const displayCases = [
  { physicalWidth: 1280, zoom: 1 },
  { physicalWidth: 1440, zoom: 1 },
  { physicalWidth: 1920, zoom: 1 },
];

async function mockViewer(page, state) {
  if (state === "logged-out") return;

  const isStaff = state === "staff-user";
  const user = { id: `${state}-id`, email: `${state}@example.test`, aud: "authenticated", role: "authenticated" };
  const payload = Buffer.from(JSON.stringify({ sub: user.id, aud: "authenticated", exp: 4102444800 })).toString("base64url");
  const token = `eyJhbGciOiJub25lIn0.${payload}.test`;
  const session = { access_token: token, refresh_token: "test-refresh-token", expires_at: 4102444800, expires_in: 3600, token_type: "bearer", user };
  const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://test.supabase.co";
  const projectRef = new URL(projectUrl).hostname.split(".")[0];

  await page.context().addCookies([{
    name: `sb-${projectRef}-auth-token`,
    value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`,
    domain: "127.0.0.1",
    path: "/",
  }]);

  await page.route("**/auth/v1/user", (route) => route.fulfill({ json: user }));
  await page.route("**/rest/v1/user_roles**", (route) => route.fulfill({
    json: { user_id: user.id, role: isStaff ? "admin" : "member" },
    headers: { "content-type": "application/json" },
  }));
  await page.route("**/rest/v1/profiles**", (route) => route.fulfill({
    json: { id: user.id, username: state, display_name: isStaff ? "Archive Staff" : "Archive Member", avatar_url: null, is_verified: false, donation_rank: null },
    headers: { "content-type": "application/json" },
  }));
  await page.route("**/api/me/access", (route) => route.fulfill({
    json: { role: isStaff ? "admin" : "member", permissions: isStaff ? ["security.view"] : [], isStaff },
  }));
}

async function expectNoOverlaps(locator) {
  const boxes = await locator.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { label: element.getAttribute("aria-label") || element.textContent?.trim(), x: box.x, y: box.y, right: box.right, bottom: box.bottom };
  }).filter((box) => box.right > box.x && box.bottom > box.y));

  for (let a = 0; a < boxes.length; a += 1) {
    for (let b = a + 1; b < boxes.length; b += 1) {
      const first = boxes[a];
      const second = boxes[b];
      const overlaps = first.x < second.right && first.right > second.x && first.y < second.bottom && first.bottom > second.y;
      expect(overlaps, `${first.label} overlaps ${second.label}`).toBe(false);
    }
  }
}

for (const state of states) {
  for (const { physicalWidth, zoom } of displayCases) {
    test(`${state} header at ${physicalWidth}px and ${zoom * 100}% zoom`, async ({ page }) => {
      // Browser zoom reduces the CSS viewport by this ratio; using that effective
      // viewport also makes breakpoint behavior deterministic in headless CI.
      const cssWidth = Math.floor(physicalWidth / zoom);
      await page.setViewportSize({ width: cssWidth, height: 800 });
      await mockViewer(page, state);
      await page.goto("/");

      const desktop = page.getByTestId("desktop-header");
      if (cssWidth >= 1024) {
        await expect(desktop).toBeVisible();
        const center = await page.getByTestId("primary-navigation-group").boundingBox();
        expect(center).not.toBeNull();
        expect(Math.abs(center.x + center.width / 2 - cssWidth / 2)).toBeLessThanOrEqual(1);
        await expectNoOverlaps(desktop.locator("nav a, [data-testid='header-left-utilities'] > button, [data-testid='header-utilities'] > a, [data-testid='header-utilities'] > button, [data-testid='header-utilities'] > div"));
        await expect(desktop).toHaveScreenshot(`${state}-${physicalWidth}-${zoom}.png`);
      } else {
        await expect(desktop).toBeHidden();
        await page.getByRole("button", { name: "Toggle menu" }).click();
        await expect(page.getByRole("link", { name: "Shops" })).toBeVisible();
      }

      await page.keyboard.press("Control+k");
      await expect(page.getByText("Search site", { exact: true })).toBeVisible();
    });
  }
}
