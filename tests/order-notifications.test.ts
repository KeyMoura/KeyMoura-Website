import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("customer status changes use specific order notifications", () => {
  const route = read("src/app/api/staff/orders/[id]/route.ts");
  for (const title of [
    "More information needed",
    "Order request accepted",
    "Payment ready",
    "Production started",
    "Finished product ready for review",
    "Order completed",
    "Order request declined",
    "Order cancelled",
  ]) assert.match(route, new RegExp(title));
});

test("shipping and pickup notifications use distinct customer language", () => {
  const route = read("src/app/api/staff/orders/[id]/route.ts");
  assert.match(route, /title: delivered \? \(pickup \? "Pickup completed" : "Order delivered"\)/);
  assert.match(route, /pickup \? "Ready for pickup" : "Order shipped"/);
});

test("private Workshop updates do not create order notifications", () => {
  const workspace = read("src/app/api/staff/orders/[id]/workspace/route.ts");
  assert.doesNotMatch(workspace, /notifyOrder(?:User|Staff)/);
  assert.doesNotMatch(workspace, /from\("notifications"\)/);
});

test("major customer actions notify staff", () => {
  for (const path of [
    "src/app/api/orders/[id]/messages/route.ts",
    "src/app/api/orders/[id]/proposal/route.ts",
    "src/app/api/orders/[id]/quote/route.ts",
    "src/app/api/orders/[id]/final-review/route.ts",
    "src/app/api/webhooks/stripe/route.ts",
  ]) assert.match(read(path), /notifyOrderStaff/);
});
