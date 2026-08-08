import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("customer navigation exposes the shop destinations without workshop", async () => {
  // The destinations moved out of SiteHeader into the shared navigation module
  // when the header was rebuilt around shopping. `/community` left this list in
  // pass 14 — it is dormant rather than removed, and `navbar-layout.test.ts`
  // asserts both halves of that. The remaining five must still be reachable.
  const { primaryNav, secondaryNav, allCustomerNavHrefs } = await import("../src/lib/navigation.ts");
  const hrefs = allCustomerNavHrefs();
  for (const route of ["/about", "/capabilities", "/projects", "/catalog", "/contact"]) {
    assert.ok(hrefs.includes(route), `${route} must stay in the customer navigation`);
  }
  assert.ok(!hrefs.includes("/community"), "Community is dormant and must not be linked");
  assert.ok(primaryNav.some((item) => item.href === "/projects"));
  const nav = read("src/lib/navigation.ts");
  assert.doesNotMatch(nav, /Community is coming soon|aria-disabled="true"/);
  assert.ok(![...primaryNav, ...secondaryNav].some((item) => /workshop/i.test(item.label)));
});
test("info landing page is presented as the projects hub", () => { const page = read("src/app/projects/ProjectsIndexClient.tsx"); for (const token of ["Project hub", "KeyMoura Build Log", "CNC & Machining", "Product Design", "Automation & Tools", "Recently updated projects"]) assert.match(page, new RegExp(token.replace(/[&]/g, "\\&"))); });
test("content routes provide manufacturing guidance", () => { for (const [file, token] of [["src/app/about/page.tsx", "Custom parts"], ["src/app/capabilities/page.tsx", "Supported materials"], ["src/app/design-guide/page.tsx", "Dimensions and tolerances"]]) assert.match(read(file), new RegExp(token)); });
test("product page explains purchase expectations", async () => {
  // This used to assert four hard-coded cards — "Lead time", "Pricing basis",
  // "Customization", "Before payment" — that rendered on every product whether
  // or not there was anything to put in them. Three of the four were static
  // prose. They are replaced by facts that come from the product, plus the
  // purchase-mode copy, so a product with a real lead time says so and one
  // without does not claim "Confirmed with your quote" as though it were data.
  const page = read("src/app/catalog/[slug]/page.tsx");
  const panel = read("src/components/product/ProductPurchasePanel.tsx");

  assert.match(page, /PURCHASE_MODE_COPY\[purchaseMode\]\.label/, "the mode is named on the page");
  assert.match(panel, /PURCHASE_MODE_COPY\[purchaseMode\]\.customerHint/, "and what it means is explained");
  assert.match(page, /quickFacts\(facts, \{ readyToShip \}\)/);
  assert.match(page, /reviewed by a person before any payment/);

  // Lead time still reaches the customer — from the column, when it is set.
  const { quickFacts, parseProductFacts } = await import("../src/lib/commerce/productContent.ts");
  const withLead = quickFacts(parseProductFacts({ lead_time_text: "3 days" }), { readyToShip: false });
  assert.deepEqual(withLead, [{ label: "Lead time", value: "3 days" }]);
  assert.deepEqual(quickFacts(parseProductFacts({}), { readyToShip: false }), []);
});
test("contact endpoint validates, rate limits, traps bots, and delivers mail", () => { const route = read("src/app/api/contact/route.ts"); for (const token of ["attempts", "429", "body.website", "RESEND_API_KEY", "replyTo"]) assert.match(route, new RegExp(token)); });
