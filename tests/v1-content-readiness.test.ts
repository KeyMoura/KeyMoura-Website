import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("customer navigation keeps info available and community visibly disabled", () => { const header = read("src/components/SiteHeader.tsx"); for (const route of ["/about", "/capabilities", "/info", "/catalog", "/contact"]) assert.match(header, new RegExp(route)); assert.match(header, /Community is coming soon/); assert.match(header, /aria-disabled="true"/); assert.doesNotMatch(header.match(/const leftLinks[\s\S]*?const desktopPillBase/)?.[0] || "", /Workshop/); });
test("content routes provide manufacturing guidance", () => { for (const [file, token] of [["src/app/about/page.tsx", "Custom parts"], ["src/app/capabilities/page.tsx", "Supported materials"], ["src/app/design-guide/page.tsx", "Dimensions and tolerances"]]) assert.match(read(file), new RegExp(token)); });
test("product page explains purchase expectations", () => { const page = read("src/app/catalog/[slug]/page.tsx"); for (const token of ["Lead time", "Pricing basis", "Customization", "Before payment"]) assert.match(page, new RegExp(token)); });
test("contact endpoint validates, rate limits, traps bots, and delivers mail", () => { const route = read("src/app/api/contact/route.ts"); for (const token of ["attempts", "429", "body.website", "RESEND_API_KEY", "replyTo"]) assert.match(route, new RegExp(token)); });
