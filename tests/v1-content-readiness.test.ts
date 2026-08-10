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
  // `/contact` became `/support` in the support pass — the same destination,
  // now backed by a real conversation with a reference, a status and an owner.
  for (const route of ["/about", "/capabilities", "/projects", "/catalog", "/support"]) {
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
/**
 * The public "ask us a question" endpoint keeps every property it had, on the
 * route that now does the job.
 *
 * `/api/contact` is gone. It built its own `new Resend(...)`, sent one email and
 * **stored nothing** — no record, no status, no owner — so it was a second mail
 * sender with none of the delivery, idempotency or audit machinery the rest of
 * the application uses. `/api/support` replaces it, and this test is re-pointed
 * rather than deleted: the four things worth asserting about a public form are
 * still asserted, and two more are now assertable because the request is
 * recorded.
 */
test("the public support endpoint validates, rate limits, traps bots, and records the request", () => {
  const route = read("src/app/api/support/route.ts");

  // Validation, with the rules in one shared module rather than inline.
  assert.match(route, /checkSubject\(body\.subject\)/);
  assert.match(route, /checkMessage\(body\.message\)/);
  assert.match(route, /checkEmail\(body\.email\)/);

  // Rate limiting, in Postgres rather than in a module-scope Map — the old
  // route's counter was per-instance, so on serverless the effective limit was
  // whatever was configured times however many instances were warm.
  assert.match(route, /consumeRateLimit\(RATE_LIMITS\.supportRequest/);
  assert.match(route, /status: 429/);

  // The honeypot, and the answer that does not teach a bot to drop the field.
  assert.match(route, /body\.website/);

  // What the old route could not do: the request becomes a row with a reference,
  // and the acknowledgement goes through the one sender.
  assert.match(route, /from\("support_conversations"\)/);
  assert.match(route, /notifyNewConversation/);
  assert.ok(!route.includes("RESEND_API_KEY"), "the support route reaches for the provider key directly");

  // And the page a customer lands on is the new one.
  assert.match(read("src/app/contact/page.tsx"), /redirect\("\/support"\)/);
});
