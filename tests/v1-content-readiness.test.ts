import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("customer navigation exposes projects and community without workshop", async () => {
  // The destinations moved out of SiteHeader into the shared navigation module
  // when the header was rebuilt around shopping; the requirement that all six
  // stay reachable did not change.
  const { primaryNav, secondaryNav, allCustomerNavHrefs } = await import("../src/lib/navigation.ts");
  const hrefs = allCustomerNavHrefs();
  for (const route of ["/about", "/capabilities", "/projects", "/catalog", "/contact", "/community"]) {
    assert.ok(hrefs.includes(route), `${route} must stay in the customer navigation`);
  }
  assert.ok(primaryNav.some((item) => item.href === "/projects"));
  const nav = read("src/lib/navigation.ts");
  assert.doesNotMatch(nav, /Community is coming soon|aria-disabled="true"/);
  assert.ok(![...primaryNav, ...secondaryNav].some((item) => /workshop/i.test(item.label)));
});
test("info landing page is presented as the projects hub", () => { const page = read("src/app/projects/ProjectsIndexClient.tsx"); for (const token of ["Project hub", "KeyMoura Build Log", "CNC & Machining", "Product Design", "Automation & Tools", "Recently updated projects"]) assert.match(page, new RegExp(token.replace(/[&]/g, "\\&"))); });
test("content routes provide manufacturing guidance", () => { for (const [file, token] of [["src/app/about/page.tsx", "Custom parts"], ["src/app/capabilities/page.tsx", "Supported materials"], ["src/app/design-guide/page.tsx", "Dimensions and tolerances"]]) assert.match(read(file), new RegExp(token)); });
test("product page explains purchase expectations", () => { const page = read("src/app/catalog/[slug]/page.tsx"); for (const token of ["Lead time", "Pricing basis", "Customization", "Before payment"]) assert.match(page, new RegExp(token)); });
test("contact endpoint validates, rate limits, traps bots, and delivers mail", () => { const route = read("src/app/api/contact/route.ts"); for (const token of ["attempts", "429", "body.website", "RESEND_API_KEY", "replyTo"]) assert.match(route, new RegExp(token)); });
